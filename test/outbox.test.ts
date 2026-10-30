import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SemanticEvent } from "@mozaik-ai/core"
import { Outbox } from "../src/outbox.ts"

test("outbox delivers in order without re-entrancy", () => {
	const log: string[] = []
	let outbox: Outbox
	outbox = new Outbox((e) => {
		log.push(`start ${e.type}`)
		if (e.type === "A") outbox.emit(SemanticEvent.create("B", "p", {}), "p")
		log.push(`end ${e.type}`)
	}, null)
	outbox.emit(SemanticEvent.create("A", "p", {}), "p")
	assert.deepEqual(log, ["start A", "end A", "start B", "end B"])
})

test("outbox writes trace lines", () => {
	const path = join(mkdtempSync(join(tmpdir(), "bringup-")), "trace.jsonl")
	const outbox = new Outbox(() => {}, path)
	for (const t of ["x", "y", "z"]) outbox.emit(SemanticEvent.create(t, "p", { n: t }), "p")
	const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l))
	assert.deepEqual(lines.map((l) => l.seq), [0, 1, 2])
	assert.equal(lines[1].type, "y")
	assert.deepEqual(lines[2].payload, { n: "z" })
})

test("outbox keeps delivering after a handler throws", () => {
	const seen: string[] = []
	const outbox = new Outbox((e) => {
		seen.push(e.type)
		if (e.type === "boom") throw new Error("handler failed")
	}, null)
	outbox.emit(SemanticEvent.create("boom", "p", {}), "p")
	outbox.emit(SemanticEvent.create("after", "p", {}), "p")
	assert.deepEqual(seen, ["boom", "after"])
})
