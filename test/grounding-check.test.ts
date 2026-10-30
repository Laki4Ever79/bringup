import { afterEach, test } from "node:test"
import { UserMessageItem } from "@mozaik-ai/core"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { BringupState, emit, join, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { LOGGER_DESIGN, mockScripts } from "../src/inference/scripts.ts"
import type { Script } from "../src/inference/scripted-runner.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { createArchitectAgent, createPartsAgent } from "../src/agents/roles.ts"
import { createGroundingCheck } from "../src/agents/grounding-check.ts"
import { makeEvent } from "../src/events.ts"
import type { GroundingFinding } from "../src/contract/grounding.ts"
import type { FieldName } from "../src/contract/types.ts"
import type { Env } from "../src/tools/env.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

// Let the previous test's agent loops finish before the next runtime starts (one runtime per process).
afterEach(() => new Promise((r) => setTimeout(r, 300)))

// Catalog-only grounding: no KiCad, so the test needs no docker.
const env: Env = { root: resolve(import.meta.dirname, ".."), tsci: null, kicad: null, python: null, pio: null }

function setup() {
	const turns = { "mock-parts": 0, "mock-architect": 0 }
	const scripts = mockScripts()
	const counted = (name: keyof typeof turns): Script => (items) => {
		// Count turns, not steps: a turn starts with no tool output after its instruction.
		if (items.at(-1) instanceof UserMessageItem) turns[name]++
		return scripts[name](items)
	}
	const state = new BringupState(tempDir(), 2000)
	startRuntime(state, inferenceConfig(true, { ...scripts, "mock-parts": counted("mock-parts"), "mock-architect": counted("mock-architect") }), null)
	const events = recorder()
	const desk = createChangeDesk()
	join(desk)
	join(createGroundingCheck(env))
	createArchitectAgent({ mock: true })
	createPartsAgent({ mock: true })
	// Applies a change the way an agent's contract tool would, then announces it.
	const change = (field: FieldName, value: unknown, by: "architect" | "parts") => {
		const r = state.contract.propose({ field, value, by, baseVersion: state.contract.version(field) } as never)
		if (r.status !== "applied") throw new Error(r.status)
		emit(makeEvent("contract.changed", desk.getId(), { field, version: r.version, revision: r.revision, by }), desk.getId())
	}
	const checks = () => events.filter((e) => e.type === "grounding.checked").map((e) => e.payload as { revision: number; findings: GroundingFinding[] })
	return { state, events, turns, change, checks }
}

const inventedParts = () => LOGGER_DESIGN.parts.map((p) => (p.ref === "U2" ? { ...p, pins: [...p.pins, "SDA2"] } : p))

test("the logger design is grounded with no findings", async () => {
	const t = setup()
	t.change("pins", LOGGER_DESIGN.pins, "architect")
	t.change("parts", LOGGER_DESIGN.parts, "parts")
	await waitFor(() => t.checks().some((c) => c.revision === t.state.contract.snapshot().revision))
	assert.deepEqual(t.checks().at(-1)!.findings, [])
	assert.deepEqual(t.state.groundingFindings, [])
})

test("an invented pin wakes the parts agent, which replaces the parts list", async () => {
	const t = setup()
	t.change("pins", LOGGER_DESIGN.pins, "architect")
	t.change("parts", inventedParts(), "parts")
	await waitFor(() => t.checks().some((c) => c.findings.length > 0))
	const flagged = t.checks().find((c) => c.findings.length > 0)!.findings
	assert.deepEqual(flagged.map((f) => [f.partRef, f.kind]), [["U2", "pin-not-on-part"]])
	assert.match(flagged[0].detail, /SDA2/)
	// The mock parts agent proposes the catalog parts again, and the grounding check clears the finding.
	await waitFor(() => t.turns["mock-parts"] >= 1 && t.state.contract.version("parts") >= 2 && t.checks().at(-1)!.findings.length === 0, 5000)
	assert.deepEqual(t.state.groundingFindings, [])
	assert.equal(t.turns["mock-architect"], 0, "a parts-list finding is not the architect's")
})

test("a pin assignment to an invented pin wakes the architect, not the parts agent", async () => {
	const t = setup()
	t.change("parts", LOGGER_DESIGN.parts, "parts")
	t.change("pins", LOGGER_DESIGN.pins.map((p) => (p.signal === "I2C_SDA" ? { ...p, partPin: "SDA2" } : p)), "architect")
	await waitFor(() => t.turns["mock-architect"] >= 1, 5000)
	assert.deepEqual(t.state.groundingFindings.map((f) => [f.partRef, f.kind]), [["U2", "pin-not-on-part"]])
	assert.equal(t.turns["mock-parts"], 0)
})
