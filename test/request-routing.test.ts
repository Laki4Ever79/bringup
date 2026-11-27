import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { createHuman } from "@mozaik-ai/core"
import { BringupState, join, sendMessage, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { mockScripts } from "../src/inference/scripts.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { createArchitectAgent, createMechanicsAgent, createMlAgent, createPartsAgent, createTestAgent, hearsRequest } from "../src/agents/roles.ts"
import { CORE_FIELDS, type FieldName } from "../src/contract/types.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 300)))

const none = (_: FieldName) => false
const with_ = (...fields: FieldName[]) => (f: FieldName) => fields.includes(f)

test("a plain board's size change reaches none of the ML, test and mechanics agents", () => {
	for (const role of ["ml", "test", "mechanics"] as const) assert.equal(hearsRequest(role, none, "make it 40 mm wide"), false, role)
})

test("a request in a feature role's own words reaches it before its field exists", () => {
	assert.ok(hearsRequest("ml", none, "add a wake word so it answers to 'hey logger'"))
	assert.ok(hearsRequest("ml", none, "recognise when the dog barks"))
	assert.ok(hearsRequest("test", none, "we need a factory test fixture"))
	assert.ok(hearsRequest("test", none, "add test pads for the bed of nails"))
})

test("once the design has a role's field, every request reaches that role", () => {
	assert.ok(hearsRequest("ml", with_("model"), "make it 40 mm wide"))
	assert.ok(hearsRequest("test", with_("test"), "use a smaller regulator"))
	assert.ok(hearsRequest("mechanics", with_("motion"), "make it 40 mm wide"))
	assert.ok(hearsRequest("mechanics", with_("mechanics"), "use a bigger battery"))
})

test("mechanics hears requests only on a robot, whatever the words", () => {
	assert.equal(hearsRequest("mechanics", none, "make it drive faster with bigger wheels"), false)
})

test("other roles hear every request as before", () => {
	for (const role of ["architect", "parts", "enclosure", "connectivity", "firmware"] as const) assert.ok(hearsRequest(role, none, "make it 40 mm wide"), role)
})

// The guard: on the scripted logger, a size change wakes no feature agent (each wake is a real model call in a real run).
test("on the scripted logger, 'make the board 60 mm wide' starts no turn for the ML, test or mechanics agents", async () => {
	const state = new BringupState(tempDir(), 2000)
	startRuntime(state, inferenceConfig(true, mockScripts()), null)
	const events = recorder()
	join(createChangeDesk())
	const engineer = createHuman({ name: "engineer", capabilities: [], handlers: [] })
	join(engineer)
	createArchitectAgent({ mock: true })
	createPartsAgent({ mock: true })
	const feature = [createMlAgent({ mock: true }), createTestAgent({ mock: true }), createMechanicsAgent({ mock: true })].map((a) => a.getId())
	sendMessage("Battery BLE temperature logger with USB-C and a status LED.", engineer.getId())
	await waitFor(() => CORE_FIELDS.every((f) => state.contract.version(f) >= 1), 15000)
	const mark = events.length
	sendMessage("make the board 60 mm wide", engineer.getId())
	await waitFor(() => state.contract.get("outline")?.widthMm === 60, 15000)
	await new Promise((r) => setTimeout(r, 500))
	const woke = events.slice(mark).filter((e) => feature.includes(e.producerId))
	assert.deepEqual(woke.map((e) => e.type), [])
})

// A build that failed for a missing tool wakes no owner; one that failed on the design does.
test("a build failed for a missing tool wakes no agent; a design failure still does", async () => {
	const state = new BringupState(tempDir(), 2000)
	startRuntime(state, inferenceConfig(true, mockScripts()), null)
	const events = recorder()
	const { getOutbox } = await import("../src/runtime.ts")
	const { makeEvent } = await import("../src/events.ts")
	const parts = createPartsAgent({ mock: true }).getId()
	const fromParts = () => events.filter((e) => e.producerId === parts && !["artifact.failed", "participant.joined"].includes(e.type))
	getOutbox().emit(makeEvent("artifact.failed", parts, { kind: "board", revision: 3, error: "tscircuit build failed: tsci is not installed (tools/node)" }), parts)
	await new Promise((r) => setTimeout(r, 500))
	assert.deepEqual(fromParts().map((e) => e.type), [], "a missing tool woke the parts agent")
	getOutbox().emit(makeEvent("artifact.failed", parts, { kind: "board", revision: 4, error: "unknown footprint soic9 on U3" }), parts)
	await waitFor(() => fromParts().length > 0)
})
