// Studio's commands into the local run (Task 2 of the Studio plan): each is one line for one of the files the hub
// appends (WRITEBACK_FILES). The running design follows those files already (requests.ts watches requests.jsonl,
// decisions.ts decisions.jsonl, …), so a change typed in Studio reaches the run exactly as one typed in the CLI.
//
// Public, in the engine: never imports src/dashboard or cloud/.
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { appendRequest, type ChangeRequest } from "../runner/requests.ts"
import { WRITEBACK_FILES, type Command } from "./protocol.ts"

// Every command is checked before any is written: one bad command in a batch writes nothing (a file outside
// WRITEBACK_FILES, a line that isn't one JSON object, a change request without text).
function check(c: Command): Record<string, unknown> {
	if (!(WRITEBACK_FILES as readonly string[]).includes(c.file)) throw new Error(`Studio command ${c.id}: ${c.file} is not a file Studio may write (${WRITEBACK_FILES.join(", ")})`)
	let v: unknown
	try {
		if (/[\r\n]/.test(c.line)) throw new Error()
		v = JSON.parse(c.line)
	} catch {
		throw new Error(`Studio command ${c.id}: its line is not one JSON object`)
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`Studio command ${c.id}: its line is not one JSON object`)
	if (c.file === "requests.jsonl" && typeof (v as { text?: unknown }).text !== "string") throw new Error(`Studio command ${c.id}: a change request needs its text`)
	return v as Record<string, unknown>
}

// Appends each command not in `seen` to its file in the run and adds its id to `seen`; returns the ids applied, in
// order. Change requests go through appendRequest, so they take the run's own time stamp and shape, as the CLI's do.
export function applyCommands(runDir: string, commands: Command[], seen: Set<string>): string[] {
	const fresh = commands.filter((c, i) => !seen.has(c.id) && commands.findIndex((x) => x.id === c.id) === i)
	const values = fresh.map(check)
	const applied: string[] = []
	fresh.forEach((c, i) => {
		const v = values[i]
		if (c.file === "requests.jsonl") {
			const r = v as Partial<ChangeRequest>
			appendRequest(runDir, r.text!, r.source, r.links, r.assembly)
		} else appendFileSync(join(runDir, c.file), JSON.stringify(v) + "\n")
		seen.add(c.id)
		applied.push(c.id)
	})
	return applied
}
