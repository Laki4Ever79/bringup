import { afterEach, test } from "node:test"
import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import assert from "node:assert/strict"
import { BringupState, emit, join, startRuntime } from "../src/runtime.ts"
import { BUILD_REQUIRES, createBuilder } from "../src/agents/builders.ts"
import { createConsistencyParticipant } from "../src/agents/consistency.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { makeEvent } from "../src/events.ts"
import { FIELDS, type ContractValues, type FieldName } from "../src/contract/types.ts"
import { fixtureArtifacts, fixtureContract } from "./fixture.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 100)))

function setup(opts: { maxRevisions?: number; breakFirmware?: boolean; requires?: boolean } = {}) {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const events = recorder()
	const desk = createChangeDesk()
	join(desk)
	const settled: { settled: boolean; revision: number }[] = []
	join(createConsistencyParticipant({ quietMs: 50, maxRevisions: opts.maxRevisions ?? 25, onSettled: (r) => settled.push(r) }))
	const a = fixtureArtifacts()
	if (opts.breakFirmware) a.firmware!.pins.I2C_SDA = 7
	const requires = (kind: keyof typeof BUILD_REQUIRES) => (opts.requires ? { requires: BUILD_REQUIRES[kind] } : {})
	join(createBuilder({ kind: "board", inputs: ["parts", "pins", "outline", "connectors"], ...requires("board"), build: async ({ revision }) => ({ ...a.board!, revision }) }))
	join(createBuilder({ kind: "enclosure", inputs: ["outline", "connectors"], ...requires("enclosure"), build: async ({ revision }) => ({ ...a.enclosure!, revision }) }))
	join(createBuilder({ kind: "firmware", inputs: ["parts", "pins"], ...requires("firmware"), build: async ({ revision }) => ({ ...a.firmware!, revision }) }))
	const write = (field: FieldName, value: unknown) => {
		const r = state.contract.propose({ field, value: value as ContractValues[FieldName], by: field === "parts" ? "parts" : "architect", baseVersion: state.contract.version(field) })
		if (r.status !== "applied") throw new Error(r.status)
		emit(makeEvent("contract.changed", desk.getId(), { field, version: r.version, revision: r.revision, by: "architect" }), desk.getId())
	}
	const writeAll = () => {
		const v = fixtureContract().values
		for (const f of FIELDS) write(f, v[f])
	}
	return { state, events, settled, write, writeAll }
}

test("settles once every artifact is current and consistent", async () => {
	const t = setup()
	t.writeAll()
	await waitFor(() => t.settled.length > 0)
	assert.deepEqual(t.settled, [{ settled: true, revision: 6 }])
	assert.ok(t.events.some((e) => e.type === "design.settled"))
})

test("reports an unsettled design when it is quiet but inconsistent", async () => {
	const t = setup({ breakFirmware: true })
	t.writeAll()
	await waitFor(() => t.settled.length > 0)
	assert.equal(t.settled[0].settled, false)
	const checked = t.events.filter((e) => e.type === "consistency.checked").at(-1)!.payload as { violations: { kind: string }[] }
	assert.deepEqual(checked.violations.map((v) => v.kind), ["pin-mismatch"])
})

test("does not settle while a change request is open", async () => {
	const t = setup()
	t.state.approvals.open("pins", "firmware")
	t.writeAll()
	await new Promise((r) => setTimeout(r, 300))
	assert.deepEqual(t.settled, [])
})

test("stops after too many revisions", async () => {
	const t = setup({ maxRevisions: 3 })
	t.writeAll()
	await waitFor(() => t.settled.length > 0)
	assert.equal(t.settled[0].settled, false)
})

test("does not settle until the grounding check has grounded the current parts and pins", async () => {
	const t = setup()
	t.state.groundingEnabled = true
	t.writeAll()
	await new Promise((r) => setTimeout(r, 300))
	assert.deepEqual(t.settled, [])
	t.state.groundedVersions = { parts: t.state.contract.version("parts"), pins: t.state.contract.version("pins") }
	// Any event re-runs the settle check; a real (different) outline write provides one.
	t.write("outline", { widthMm: 50, heightMm: 32, thicknessMm: 1.6 })
	await waitFor(() => t.settled.length > 0)
})

test("waiting builders still settle once every field exists", async () => {
	const t = setup({ requires: true })
	t.writeAll()
	await waitFor(() => t.settled.length > 0)
	assert.deepEqual(t.settled, [{ settled: true, revision: 6 }])
	assert.ok(!t.events.some((e) => e.type === "artifact.failed"))
})

test("a quiet design missing a required field settles unsettled and names the field", async () => {
	const t = setup({ requires: true })
	const v = fixtureContract().values
	for (const f of FIELDS) if (f !== "pins") t.write(f, v[f])
	await waitFor(() => t.settled.length > 0, 2000)
	assert.deepEqual(t.settled, [{ settled: false, revision: 5 }])
	assert.match(t.state.artifactFailures.board ?? "", /pins/)
	assert.match(t.state.artifactFailures.firmware ?? "", /pins/)
	assert.equal(t.state.artifactFailures.enclosure, undefined, "the enclosure has its inputs and was built")
	assert.ok(!t.events.some((e) => e.type === "artifact.failed"), "waiting is not a failed build")
})

test("a missing field does not end the run while an agent is still mid-turn", async () => {
	const t = setup({ requires: true })
	const v = fixtureContract().values
	for (const f of FIELDS) if (f !== "pins") t.write(f, v[f])
	// An agent loop that has started and not answered yet (it may still write the pins).
	const agent = createHuman({ name: "architect-stand-in", capabilities: [], handlers: [] })
	join(agent)
	emit(SemanticEvent.create("message_received.started", agent.getId(), {}), agent.getId())
	await new Promise((r) => setTimeout(r, 300))
	assert.deepEqual(t.settled, [])
})

test("MAX_REVISIONS still ends a run with waiting builders", async () => {
	const t = setup({ requires: true, maxRevisions: 3 })
	const v = fixtureContract().values
	for (const f of ["requirements", "outline", "connectors", "rails"] as const) t.write(f, v[f])
	await waitFor(() => t.settled.length > 0)
	assert.equal(t.settled[0].settled, false)
})
