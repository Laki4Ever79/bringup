// The bench companion's second piece: a robot's serial lines (its USB port, /dev/ttyACM0 or /dev/ttyUSB0, or a console
// on TCP such as QEMU's: tcp://127.0.0.1:5555) streamed into the design's folder as they come, one JSON line each in
// bench/session-<time>.jsonl ({at, line}), which the Studio connector mirrors up (the live view reads it; paid
// "debugging"). The same reader (rover-log.ts) diagnoses it after. With `commands`, the commands Studio's test buttons
// append to the run's bench-commands.jsonl (bench-commands.ts) are written to the robot as they come, and recorded in
// the session ({at, sent}) so the view can put each result beside the command that asked for it.
// No new dependency: the port is set up with stty and read and written as a file; a pseudo-terminal stands in for it
// in tests.
import { spawnSync } from "node:child_process"
import { appendFileSync, closeSync, createReadStream, mkdirSync, openSync, writeSync } from "node:fs"
import { connect } from "node:net"
import { join } from "node:path"
import { followBenchCommands } from "./bench-commands.ts"

export interface SerialSession { file: string; lines: () => number; sent: () => number; close: () => void; done: Promise<void> }

// Raw mode at the robot's speed (115200 by default); a pseudo-terminal or a plain file skips it (stty would fail).
export function prepareSerial(device: string, baud = 115200): void {
	if (!/^\/dev\/tty(ACM|USB)\d+$/.test(device)) return
	const r = spawnSync("stty", ["-F", device, String(baud), "raw", "-echo"], { encoding: "utf8" })
	if (r.status !== 0) throw new Error(`can't set up ${device}: ${(r.stderr || "").trim() || `stty exited ${r.status}`} (are you in the dialout group?)`)
}

// "tcp://host:port" (or "tcp:host:port"): a console on TCP; anything else is a device or file path.
export function tcpAddress(device: string): { host: string; port: number } | null {
	const m = /^tcp:(?:\/\/)?([\w.-]+):(\d{1,5})$/.exec(device)
	return m ? { host: m[1], port: Number(m[2]) } : null
}

export function streamSerial(device: string, runDir: string, opts: { baud?: number; now?: () => Date; onLine?: (line: string) => void; commands?: boolean; onSent?: (cmd: string) => void } = {}): SerialSession {
	const tcp = tcpAddress(device)
	if (!tcp) prepareSerial(device, opts.baud)
	const now = opts.now ?? (() => new Date())
	const dir = join(runDir, "bench")
	mkdirSync(dir, { recursive: true })
	const file = join(dir, `session-${now().toISOString().replace(/[:.]/g, "-")}.jsonl`)
	let n = 0, sentN = 0, rest = ""
	const onData = (chunk: string | Buffer) => {
		rest += String(chunk)
		const parts = rest.split(/\r?\n/)
		rest = parts.pop() ?? ""
		for (const line of parts) {
			if (!line.trim()) continue
			appendFileSync(file, JSON.stringify({ at: now().toISOString(), line }) + "\n")
			n++
			opts.onLine?.(line)
		}
	}
	// The way to the robot: the TCP socket, or the device opened for writing (a plain file, as in some tests, can't be).
	let write: ((s: string) => void) | null = null
	let closeAll = () => {}
	const done = new Promise<void>((resolve, reject) => {
		if (tcp) {
			const sock = connect(tcp.port, tcp.host)
			sock.on("data", onData)
			sock.on("close", () => resolve())
			sock.on("error", (e: NodeJS.ErrnoException) => (e.code === "ECONNRESET" ? resolve() : reject(e)))
			write = (s) => { sock.write(s) }
			closeAll = () => sock.destroy()
			return
		}
		const stream = createReadStream(device, { encoding: "utf8" })
		stream.on("data", onData)
		stream.on("end", () => resolve())
		stream.on("close", () => resolve())
		// A pseudo-terminal whose writer hung up reads EIO: the session is over, not failed.
		stream.on("error", (e: NodeJS.ErrnoException) => (e.code === "EIO" ? resolve() : reject(e)))
		if (opts.commands && /^\/dev\//.test(device)) {
			const fd = openSync(device, "w")
			write = (s) => { try { writeSync(fd, s) } catch {} }
			closeAll = () => { stream.destroy(); try { closeSync(fd) } catch {} }
		} else closeAll = () => stream.destroy()
	})
	let stopCommands = () => {}
	if (opts.commands && write) {
		const w: (s: string) => void = write
		stopCommands = followBenchCommands(runDir, (cmd) => {
			w(`${cmd}\n`)
			appendFileSync(file, JSON.stringify({ at: now().toISOString(), sent: cmd }) + "\n")
			sentN++
			opts.onSent?.(cmd)
		}).stop
	}
	void done.then(() => stopCommands(), () => stopCommands())
	return { file, lines: () => n, sent: () => sentN, close: () => { stopCommands(); closeAll() }, done }
}

// A saved session back as plain log text, for the diagnosis (rover-log.ts parseRoverLog): the robot's lines, and each
// command sent as "> <cmd>" (which the parser leaves alone) so line numbers match the live view's.
export function sessionText(jsonl: string): string {
	return jsonl.split("\n").flatMap((l) => {
		try {
			if (!l.trim()) return []
			const o = JSON.parse(l)
			return typeof o.line === "string" ? [o.line] : typeof o.sent === "string" ? [`> ${o.sent}`] : []
		} catch {
			return []
		}
	}).join("\n") + "\n"
}
