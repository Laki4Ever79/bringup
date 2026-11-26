// Studio's commands into the local run (src/connector/apply.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { applyCommands } from "../src/connector/apply.ts"
import { appendRequest } from "../src/runner/requests.ts"
import type { Command } from "../src/connector/protocol.ts"
import { tempDir } from "./helpers.ts"

const lines = (dir: string, f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])

test("a change request from Studio lands in requests.jsonl once, even when applied twice", () => {
	const dir = tempDir()
	const seen = new Set<string>()
	const cmd: Command = { file: "requests.jsonl", line: JSON.stringify({ text: "make it 50 mm wide" }), id: "c1" }
	assert.deepEqual(applyCommands(dir, [cmd], seen), ["c1"])
	assert.deepEqual(applyCommands(dir, [cmd], seen), [])
	const got = lines(dir, "requests.jsonl")
	assert.equal(got.length, 1)
	assert.equal(got[0].text, "make it 50 mm wide")
	assert.match(got[0].at, /^\d{4}-\d{2}-\d{2}T/) // appendRequest's own time stamp, as a CLI request gets
})

test("a CLI request appended in between keeps both, in the file's order", () => {
	const dir = tempDir()
	const seen = new Set<string>()
	applyCommands(dir, [{ file: "requests.jsonl", line: JSON.stringify({ text: "from Studio 1" }), id: "c1" }], seen)
	appendRequest(dir, "from the CLI")
	applyCommands(dir, [{ file: "requests.jsonl", line: JSON.stringify({ text: "from Studio 2" }), id: "c2" }], seen)
	assert.deepEqual(lines(dir, "requests.jsonl").map((r) => r.text), ["from Studio 1", "from the CLI", "from Studio 2"])
})

test("decisions, steering, drift actions and system requests are appended as Studio wrote them", () => {
	const dir = tempDir()
	const seen = new Set<string>()
	const ids = applyCommands(dir, [
		{ file: "decisions.jsonl", line: JSON.stringify({ proposalId: "p1", accept: true }), id: "d1" },
		{ file: "steer.jsonl", line: JSON.stringify({ agent: "firmware", action: "pause" }), id: "s1" },
		{ file: "drift-actions.jsonl", line: JSON.stringify({ path: "board.circuit.tsx", action: "keep" }), id: "x1" },
		{ file: "system-requests.jsonl", line: JSON.stringify({ text: "move the sensor board" }), id: "y1" },
	], seen)
	assert.deepEqual(ids, ["d1", "s1", "x1", "y1"])
	assert.deepEqual(lines(dir, "decisions.jsonl"), [{ proposalId: "p1", accept: true }])
	assert.deepEqual(lines(dir, "steer.jsonl"), [{ agent: "firmware", action: "pause" }])
	assert.equal(lines(dir, "drift-actions.jsonl").length, 1)
	assert.equal(lines(dir, "system-requests.jsonl").length, 1)
})

test("a command for a file outside WRITEBACK_FILES is refused (throws, nothing written)", () => {
	const dir = tempDir()
	const seen = new Set<string>()
	const good: Command = { file: "requests.jsonl", line: JSON.stringify({ text: "ok" }), id: "c1" }
	const bad = { file: "contract.json", line: "{}", id: "c2" } as unknown as Command
	assert.throws(() => applyCommands(dir, [good, bad], seen), /contract\.json/)
	assert.equal(existsSync(join(dir, "requests.jsonl")), false)
	assert.equal(existsSync(join(dir, "contract.json")), false)
	assert.equal(seen.size, 0)
	// A path that climbs out of the run, and a line that isn't one JSON object, are refused too.
	assert.throws(() => applyCommands(dir, [{ file: "../requests.jsonl", line: "{}", id: "c3" } as unknown as Command], seen))
	assert.throws(() => applyCommands(dir, [{ file: "steer.jsonl", line: '{"a":1}\n{"b":2}', id: "c4" }], seen), /one JSON object/)
	assert.throws(() => applyCommands(dir, [{ file: "requests.jsonl", line: JSON.stringify({ nope: 1 }), id: "c5" }], seen), /text/)
})
