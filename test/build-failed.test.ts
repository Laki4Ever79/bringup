import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join as joinPath } from "node:path"
import { createHuman } from "@mozaik-ai/core"
import { BringupState, emit, join, sendMessage, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { mockScripts } from "../src/inference/scripts.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { createArchitectAgent, createFirmwareReviewer, createPartsAgent } from "../src/agents/roles.ts"
import { makeEvent } from "../src/events.ts"
import { CORE_FIELDS } from "../src/contract/types.ts"
import { ROOT, runDesign } from "../src/run.ts"
import type { Env } from "../src/tools/env.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 300)))

const VIA_ERROR = "Via hole at (-21.24mm, 2.40mm) overlaps SMD pad J1.pin6 at (-21.88mm, 2.40mm)"

async function drafted() {
	const state = new BringupState(tempDir(), 2000)
	startRuntime(state, inferenceConfig(true, mockScripts()), null)
	const events = recorder()
	const desk = createChangeDesk()
	join(desk)
	const engineer = createHuman({ name: "engineer", capabilities: [], handlers: [] })
	join(engineer)
	const architect = createArchitectAgent({ mock: true })
	const parts = createPartsAgent({ mock: true })
	const firmware = createFirmwareReviewer({ mock: true })
	sendMessage("Battery BLE temperature logger with USB-C and a status LED.", engineer.getId())
	await waitFor(() => CORE_FIELDS.every((f) => state.contract.version(f) >= 1) && (state.contract.get("pins") ?? []).some((p) => p.signal === "STATUS_LED"), 5000)
	await new Promise((r) => setTimeout(r, 300))
	// The text each agent's turns started with, from Mozaik's loop events.
	const turns = (agentId: string) =>
		events.filter((e) => e.type === "message_received.started" && e.producerId === agentId).map((e) => String((e.payload as { content?: string }).content ?? ""))
	const fail = (kind: "board" | "firmware" | "enclosure", revision: number, error: string) =>
		emit(makeEvent("artifact.failed", desk.getId(), { kind, revision, error }), desk.getId())
	return { state, events, architect, parts, firmware, desk, engineer, turns, fail }
}

test("a failed board build gives the architect and the parts agent a turn with the error", async () => {
	const t = await drafted()
	const partsVersion = t.state.contract.version("parts")
	const revision = t.state.contract.revision
	t.fail("board", revision, VIA_ERROR)
	await waitFor(() => t.turns(t.architect.getId()).some((m) => m.includes(VIA_ERROR)) && t.turns(t.parts.getId()).some((m) => m.includes(VIA_ERROR)))
	const msg = t.turns(t.architect.getId()).find((m) => m.includes(VIA_ERROR))!
	assert.match(msg, /board build failed at revision \d+/)
	assert.match(msg, /a contract field you own \(outline, connectors, rails, pins\)/)
	assert.match(msg, /Otherwise change nothing/)
	await new Promise((r) => setTimeout(r, 300))
	assert.equal(t.state.contract.version("parts"), partsVersion, "the mock parts agent only notes the failure")
	assert.equal(t.state.contract.revision, revision, "nothing changed in the mock run")
})

test("the same failure wakes each agent once", async () => {
	const t = await drafted()
	const revision = t.state.contract.revision
	t.fail("board", revision, VIA_ERROR)
	t.fail("board", revision, VIA_ERROR)
	await waitFor(() => t.turns(t.architect.getId()).some((m) => m.includes(VIA_ERROR)))
	await new Promise((r) => setTimeout(r, 300))
	assert.equal(t.turns(t.architect.getId()).filter((m) => m.includes(VIA_ERROR)).length, 1)
})

test("a failed firmware build wakes the parts agent but not the architect", async () => {
	const t = await drafted()
	const error = "src/main.cpp:12: error: 'PIN_SENSOR_INT' was not declared"
	t.fail("firmware", t.state.contract.revision, error)
	await waitFor(() => t.turns(t.parts.getId()).some((m) => m.includes(error)))
	await new Promise((r) => setTimeout(r, 300))
	assert.ok(!t.turns(t.architect.getId()).some((m) => m.includes(error)))
})

// Real run 14: the enclosure failed on a 7.5 mm tall USB-C cutout (the architect's connector height), nobody was
// woken, and the run ended unsettled with everything quiet.
test("a failed enclosure build wakes the architect, who owns the outline and connectors, and not the parts agent", async () => {
	const t = await drafted()
	const error = "enclosure: J1: cutout top 14.60 mm reaches the lid's lip (starts at 11.00 mm)"
	t.fail("enclosure", t.state.contract.revision, error)
	await waitFor(() => t.turns(t.architect.getId()).some((m) => m.includes(error)))
	await new Promise((r) => setTimeout(r, 300))
	assert.ok(!t.turns(t.parts.getId()).some((m) => m.includes(error)))
})

test("a run where parts arrive before the outline has no failed builds", { timeout: 90_000 }, async () => {
	const bare: Env = { root: ROOT, tsci: null, kicad: null, python: null, pio: null }
	const outDir = tempDir()
	const brief = readFileSync(joinPath(ROOT, "briefs/logger.md"), "utf8")
	const result = await runDesign({ brief, mock: true, outDir, env: bare, noHardware: true, timeoutMs: 60_000 })
	const trace = readFileSync(joinPath(outDir, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const changed = trace.filter((e) => e.type === "contract.changed").map((e) => e.payload.field)
	assert.ok(changed.indexOf("parts") < changed.indexOf("outline"), `the scenario needs parts first: ${changed.join(" ")}`)
	assert.deepEqual(trace.filter((e) => e.type === "artifact.failed").map((e) => e.payload), [])
	const outlineAt = trace.find((e) => e.type === "contract.changed" && e.payload.field === "outline").payload.revision
	const firstBoard = trace.find((e) => e.type === "artifact.ready" && e.payload.kind === "board").payload.revision
	assert.ok(firstBoard >= outlineAt, `board built at rev ${firstBoard}, before the outline (rev ${outlineAt})`)
	assert.equal(result.settled, true)
})

// Real run 15: six behavior proposals from the architect and parts waited 120 s and timed out. The firmware agent
// owns behavior but was never asked to decide.
test("a held behavior change asks its owner, the firmware agent, to decide", async () => {
	const t = await drafted()
	const id = t.state.approvals.open("behavior", "architect", "{}", false)
	emit(makeEvent("change.proposed", t.desk.getId(), { proposalId: id, field: "behavior", by: "architect", reason: "blink faster", needsEngineer: false }), t.desk.getId())
	await waitFor(() => t.turns(t.firmware.getId()).some((m) => m.includes(`proposalId=${id}`)))
	assert.ok(!t.turns(t.parts.getId()).some((m) => m.includes(`proposalId=${id}`)))
})

// Real run 18: "our sensor is out of stock" reached only the architect and firmware; the parts agent, who owns the parts
// list, saw only the architect's proposal, trusted a lookup with unknown stock over the engineer, and rejected it.
test("an engineer request reaches the parts agent too, and the engineer's word on stock counts over the lookup", async () => {
	const t = await drafted()
	const request = "our temperature/humidity sensor is out of stock; switch to the other one in the catalog"
	sendMessage(request, t.engineer.getId())
	await waitFor(() => t.turns(t.parts.getId()).some((m) => m.includes(request)))
	const msg = t.turns(t.parts.getId()).find((m) => m.includes(request))!
	assert.match(msg, /^Change request from the engineer:/)
	assert.match(msg, /If it is about the parts \(stock, a different or extra part\), meet it by changing the parts list you own/)
	assert.match(msg, /The engineer's word on stock counts over search_parts/)
	assert.ok(!t.turns(t.parts.getId()).some((m) => m.includes("Battery BLE temperature logger")), "the brief itself is not a change request")
})
