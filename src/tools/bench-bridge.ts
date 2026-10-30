import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

// Node's side of the py/bench.py bridge protocol (docs/design/bench.md §3b): JSON lines both ways. The bridge owns
// every port; this client only matches acks to commands and hands every other line to the listeners.

export type BenchSource = "real" | "fake" | "replay"

export interface BridgeLine {
	k: string
	at: number
	[key: string]: unknown
}

export interface BridgeHello {
	source: BenchSource
	ports: { dut: string | null; fixture: string | null; telemetry: string | null }
	meter: boolean
}

export interface BridgeAck {
	ok: boolean
	error?: string
	stage?: string
	ms?: number
	simulated?: boolean
	[key: string]: unknown
}

export interface Bridge {
	readonly hello: Promise<BridgeHello>
	onLine(listener: (line: BridgeLine) => void): void
	command(cmd: { cmd: string; [key: string]: unknown }): Promise<BridgeAck>
	close(): Promise<void>
}

// Spawns the bridge (normally `.venv/bin/python py/bench.py --source …`). Lines that aren't JSON become
// {k:"text"} lines, as the bridge does for the DUT's own text.
export function startBridge(command: string, args: string[], opts: { cwd?: string; onStderr?: (text: string) => void } = {}): Bridge {
	// No __pycache__ next to py/benchlib in the checkout.
	const child = spawn(command, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } })
	const listeners: ((line: BridgeLine) => void)[] = []
	const pending = new Map<number, (ack: BridgeAck) => void>()
	let nextId = 1
	let exited = false
	let resolveHello: (h: BridgeHello) => void = () => {}
	let rejectHello: (e: Error) => void = () => {}
	const hello = new Promise<BridgeHello>((resolve, reject) => {
		resolveHello = resolve
		rejectHello = reject
	})
	// Nobody awaiting hello must not crash the process when the bridge fails to start.
	hello.catch(() => {})
	const exit = new Promise<void>((resolve) => {
		const done = (why: string) => {
			if (exited) return
			exited = true
			rejectHello(new Error(`bench bridge ${why} before saying hello`))
			for (const [id, settle] of pending) settle({ ok: false, error: `bench bridge ${why}`, id })
			pending.clear()
			resolve()
		}
		child.on("error", (e) => done(`failed to start (${e.message})`))
		child.on("close", (code) => done(`exited with code ${code}`))
	})
	child.stdin.on("error", () => {})
	child.stderr.on("data", (d) => opts.onStderr?.(String(d)))
	createInterface({ input: child.stdout }).on("line", (raw) => {
		if (raw.trim() === "") return
		let line: BridgeLine
		try {
			line = JSON.parse(raw)
		} catch {
			line = { k: "text", at: Date.now(), text: raw }
		}
		if (line.k === "hello") resolveHello(line as unknown as BridgeHello)
		if (line.k === "ack" && typeof line.id === "number" && pending.has(line.id)) {
			const settle = pending.get(line.id)!
			pending.delete(line.id)
			settle(line as unknown as BridgeAck)
			return
		}
		for (const l of listeners) l(line)
	})
	return {
		hello,
		onLine: (listener) => void listeners.push(listener),
		command(cmd) {
			if (exited) return Promise.resolve({ ok: false, error: "bench bridge exited" })
			const id = nextId++
			return new Promise((resolve) => {
				pending.set(id, resolve)
				child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n")
			})
		},
		async close() {
			if (exited) return
			child.stdin.write(JSON.stringify({ id: nextId++, cmd: "quit" }) + "\n")
			child.stdin.end()
			const killer = setTimeout(() => child.kill(), 3000)
			await exit
			clearTimeout(killer)
		},
	}
}
