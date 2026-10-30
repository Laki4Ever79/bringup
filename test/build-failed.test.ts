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
	createFirmwareReviewer({ mock: true })
	sendMessage("Battery BLE temperature logger with USB-C and a status LED.", engineer.getId())
	await waitFor(() => CORE_FIELDS.every((f) => state.contract.version(f) >= 1) && (state.contract.get("pins") ?? []).some((p) => p.signal === "STATUS_LED"), 5000)
	await new Promise((r) => setTimeout(r, 300))
	// The text each agent's turns started with, from Mozaik's loop events.
	const turns = (agentId: string) =>
		events.filter((e) => e.type === "message_received.started" && e.producerId === agentId).map((e) => String((e.payload as { content?: string }).content ?? ""))
	const fail = (kind: "board" | "firmware", revision: number, error: string) =>
		emit(makeEvent("artifact.failed", desk.getId(), { kind, revision, error }), desk.getId())
	return { state, events, architect, parts, turns, fail }
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
