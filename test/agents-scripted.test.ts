import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { createHuman } from "@mozaik-ai/core"
import { BringupState, join, sendMessage, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { mockScripts } from "../src/inference/scripts.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { createArchitectAgent, createFirmwareReviewer, createPartsAgent } from "../src/agents/roles.ts"
import { FIELDS } from "../src/contract/types.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

// Let the previous test's agent loops finish before the next runtime starts (one runtime per process).
afterEach(() => new Promise((r) => setTimeout(r, 300)))

function setup() {
	const state = new BringupState(tempDir(), 2000)
	startRuntime(state, inferenceConfig(true, mockScripts()), null)
	const events = recorder()
	join(createChangeDesk())
	const engineer = createHuman({ name: "engineer", capabilities: [], handlers: [] })
	join(engineer)
	createArchitectAgent({ mock: true })
	createPartsAgent({ mock: true })
	createFirmwareReviewer({ mock: true })
	const changes = () => events.filter((e) => e.type === "contract.changed").map((e) => e.payload as { field: string; by: string })
	return { state, events, engineer, changes }
}

test("scripted architect and parts populate the contract concurrently", async () => {
	const t = setup()
	sendMessage("Battery BLE temperature logger with USB-C and a status LED.", t.engineer.getId())
	await waitFor(() => FIELDS.every((f) => t.state.contract.version(f) >= 1), 5000)
	const order = t.changes().map((c) => `${c.by}:${c.field}`)
	const partsAt = order.indexOf("parts:parts")
	const requirementsAt = order.indexOf("architect:requirements")
	const lastArchitectAt = order.findLastIndex((x) => x.startsWith("architect:"))
	assert.ok(requirementsAt < partsAt, order.join(" "))
	assert.ok(partsAt < lastArchitectAt, `parts did not overlap the architect: ${order.join(" ")}`)
})

test("firmware asks for a status LED pin through change control", async () => {
	const t = setup()
	sendMessage("Battery BLE temperature logger with USB-C and a status LED.", t.engineer.getId())
	await waitFor(() => (t.state.contract.get("pins") ?? []).some((p) => p.signal === "STATUS_LED"), 5000)
	const types = t.events.map((e) => e.type)
	assert.ok(types.includes("change.proposed") && types.includes("change.decided"))
	assert.ok(t.changes().some((c) => c.by === "firmware" && c.field === "pins"))
})

test("an agent reviews each contract version once", async () => {
	const t = setup()
	sendMessage("Battery BLE temperature logger with USB-C and a status LED.", t.engineer.getId())
	await waitFor(() => (t.state.contract.get("pins") ?? []).some((p) => p.signal === "STATUS_LED"), 5000)
	await new Promise((r) => setTimeout(r, 300))
	const proposals = t.events.filter((e) => e.type === "change.proposed").length
	assert.equal(proposals, 1)
})

test("the parts agent decides change requests to the parts list", async () => {
	const t = setup()
	const types = () => t.events.map((e) => e.type)
	const { getOutbox } = await import("../src/runtime.ts")
	const { makeEvent } = await import("../src/events.ts")
	const parts = [...t.state.roles.entries()].find(([, r]) => r === "parts")![0]
	const architect = [...t.state.roles.entries()].find(([, r]) => r === "architect")![0]
	const id = t.state.approvals.open("parts", "architect")
	getOutbox().emit(makeEvent("change.proposed", architect, { proposalId: id, field: "parts", by: "architect", reason: "add a button" }), architect)
	await waitFor(() => types().includes("change.decided"))
	const decided = t.events.find((e) => e.type === "change.decided")!
	assert.equal(decided.producerId, parts)
})
