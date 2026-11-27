// The bench companion's commands to the robot (design note 2026-11-26-bench-companion-design.md, part 3): Studio's
// test buttons append one line each to the run's bench-commands.jsonl (on this machine directly, or from Studio through
// the connector's write-back, src/connector/protocol.ts WRITEBACK_FILES), and `bringup bench-stream` writes each new one
// to the robot's serial port. Only the rover firmware's own host commands get through (templates/fw-rover/src/main.cpp):
//   G <x_mm> <y_mm>   drive to that point (from where it started: x ahead, y to its left)
//   C [<quarters>]    the turn calibration, that many quarter-turns each way (8 by default)
//   H <left> <right>  wheel duties, -1..1 (H 0 0 stops it and clears its route)
// Public, in the engine: the hub, the connector and the CLI all check a command the same way here.
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import { join } from "node:path"

export const BENCH_COMMANDS_FILE = "bench-commands.jsonl"
export interface BenchCommand { at: string; cmd: string }

const NUM = "-?\\d{1,5}(?:\\.\\d{1,3})?"
const DUTY = "-?(?:0(?:\\.\\d{1,3})?|1(?:\\.0{1,3})?)"
const SHAPES: [RegExp, string][] = [
	[new RegExp(`^G ${NUM} ${NUM}$`), "G <x mm> <y mm>"],
	[/^C(?: (?:[1-9]|[1-3]\d|40))?$/, "C or C <1–40 quarter-turns>"],
	[new RegExp(`^H ${DUTY} ${DUTY}$`), "H <left> <right>, each -1 to 1"],
]

// The command as the firmware reads it (spaces collapsed), or why it isn't one.
export function benchCommand(text: unknown): { cmd: string } | { error: string } {
	if (typeof text !== "string") return { error: "a command is text" }
	const cmd = text.trim().replace(/\s+/g, " ")
	if (SHAPES.some(([re]) => re.test(cmd))) return { cmd }
	return { error: `not a command the robot takes: ${JSON.stringify(cmd.slice(0, 40))} (${SHAPES.map(([, s]) => s).join("; ")})` }
}

// One command into the run's file: refused (thrown) unless it's one the robot takes.
export function appendBenchCommand(runDir: string, text: unknown, now = new Date()): BenchCommand {
	const c = benchCommand(text)
	if ("error" in c) throw new Error(c.error)
	const line: BenchCommand = { at: now.toISOString(), cmd: c.cmd }
	appendFileSync(join(runDir, BENCH_COMMANDS_FILE), JSON.stringify(line) + "\n")
	return line
}

// Follows the run's bench-commands.jsonl from its end now (commands written before the session started are not
// replayed onto a robot) and calls `send` with each new valid one; invalid lines are skipped with `onSkip`.
export function followBenchCommands(runDir: string, send: (cmd: string) => void, opts: { intervalMs?: number; onSkip?: (why: string) => void } = {}): { stop: () => void } {
	const file = join(runDir, BENCH_COMMANDS_FILE)
	let at = existsSync(file) ? statSync(file).size : 0, rest = ""
	const tick = () => {
		if (!existsSync(file)) return
		const size = statSync(file).size
		if (size < at) at = 0 // rewritten: read it from the start
		if (size === at) return
		const fd = openSync(file, "r")
		try {
			const buf = Buffer.alloc(size - at)
			readSync(fd, buf, 0, buf.length, at)
			at = size
			rest += buf.toString("utf8")
		} finally {
			closeSync(fd)
		}
		const lines = rest.split("\n")
		rest = lines.pop() ?? ""
		for (const l of lines) {
			if (!l.trim()) continue
			let v: unknown
			try { v = JSON.parse(l) } catch { opts.onSkip?.("a line that isn't JSON"); continue }
			const c = benchCommand((v as { cmd?: unknown })?.cmd)
			if ("error" in c) opts.onSkip?.(c.error)
			else send(c.cmd)
		}
	}
	const timer = setInterval(tick, opts.intervalMs ?? 250)
	return { stop: () => clearInterval(timer) }
}
