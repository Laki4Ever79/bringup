// The bench companion's second piece: a robot's serial lines (its USB port, /dev/ttyACM0 or /dev/ttyUSB0) streamed into
// the design's folder as they come, one JSON line each in bench/session-<time>.jsonl ({at, line}), which the Studio
// connector mirrors up (the live view reads it; paid "debugging"). The same reader (rover-log.ts) diagnoses it after.
// No new dependency: the port is set up with stty and read as a file; a pseudo-terminal stands in for it in tests.
import { spawnSync } from "node:child_process"
import { appendFileSync, createReadStream, mkdirSync } from "node:fs"
import { join } from "node:path"

export interface SerialSession { file: string; lines: () => number; close: () => void; done: Promise<void> }

// Raw mode at the robot's speed (115200 by default); a pseudo-terminal or a plain file skips it (stty would fail).
export function prepareSerial(device: string, baud = 115200): void {
	if (!/^\/dev\/tty(ACM|USB)\d+$/.test(device)) return
	const r = spawnSync("stty", ["-F", device, String(baud), "raw", "-echo"], { encoding: "utf8" })
	if (r.status !== 0) throw new Error(`can't set up ${device}: ${(r.stderr || "").trim() || `stty exited ${r.status}`} (are you in the dialout group?)`)
}

export function streamSerial(device: string, runDir: string, opts: { baud?: number; now?: () => Date; onLine?: (line: string) => void } = {}): SerialSession {
	prepareSerial(device, opts.baud)
	const now = opts.now ?? (() => new Date())
	const dir = join(runDir, "bench")
	mkdirSync(dir, { recursive: true })
	const file = join(dir, `session-${now().toISOString().replace(/[:.]/g, "-")}.jsonl`)
	let n = 0, rest = ""
	const stream = createReadStream(device, { encoding: "utf8" })
	const done = new Promise<void>((resolve, reject) => {
		stream.on("data", (chunk: string | Buffer) => {
			rest += String(chunk)
			const parts = rest.split(/\r?\n/)
			rest = parts.pop() ?? ""
			for (const line of parts) {
				if (!line.trim()) continue
				appendFileSync(file, JSON.stringify({ at: now().toISOString(), line }) + "\n")
				n++
				opts.onLine?.(line)
			}
		})
		stream.on("end", () => resolve())
		stream.on("close", () => resolve())
		// A pseudo-terminal whose writer hung up reads EIO: the session is over, not failed.
		stream.on("error", (e: NodeJS.ErrnoException) => (e.code === "EIO" ? resolve() : reject(e)))
	})
	return { file, lines: () => n, close: () => stream.destroy(), done }
}

// A saved session back as plain log text, for the diagnosis (rover-log.ts parseRoverLog).
export function sessionText(jsonl: string): string {
	return jsonl.split("\n").flatMap((l) => { try { return l.trim() ? [String(JSON.parse(l).line)] : [] } catch { return [] } }).join("\n") + "\n"
}
