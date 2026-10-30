import { test } from "node:test"
import assert from "node:assert/strict"
import { artifactLine } from "../src/agents/reviewer.ts"
import { fixtureContract } from "./fixture.ts"

const versions = { ...fixtureContract().versions, requirements: 3, outline: 1, connectors: 1, parts: 4, pins: 5, behavior: 0 }

test("an artifact built at an older revision whose inputs haven't changed is reported current", () => {
	const line = artifactLine("enclosure", { revision: 3 }, undefined, { outline: 1, connectors: 1 }, versions, 17)
	assert.equal(line, "enclosure: current: its inputs (outline, connectors) unchanged since revision 3")
})

test("an artifact whose inputs changed since it was built is reported out of date, naming them", () => {
	const line = artifactLine("board", { revision: 9 }, undefined, { parts: 3, pins: 5, outline: 1, connectors: 1 }, versions, 17)
	assert.equal(line, "board: built for revision 9, OUT OF DATE: parts changed since")
})

test("an artifact at the reviewed revision, a failed build and a missing build keep their wording", () => {
	assert.equal(artifactLine("firmware", { revision: 17, ok: true }, undefined, { parts: 4, pins: 5, behavior: 0 }, versions, 17), "firmware: built for revision 17, compiles")
	assert.equal(artifactLine("board", undefined, "tscircuit build failed (exit 1)\nmore", undefined, versions, 17), "board: build FAILED: tscircuit build failed (exit 1)")
	assert.equal(artifactLine("enclosure", undefined, undefined, undefined, versions, 17), "enclosure: not built")
})
