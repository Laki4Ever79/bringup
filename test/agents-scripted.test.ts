import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHuman } from "@mozaik-ai/core"
import { BringupState, join, sendMessage, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { mockScripts } from "../src/inference/scripts.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { createArchitectAgent, createFirmwareReviewer, createPartsAgent } from "../src/agents/roles.ts"
import { CORE_FIELDS } from "../src/contract/types.ts"
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
	await waitFor(() => CORE_FIELDS.every((f) => t.state.contract.version(f) >= 1), 5000)
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
	getOutbox().emit(makeEvent("change.proposed", architect, { proposalId: id, field: "parts", by: "architect", reason: "add a button", needsEngineer: false }), architect)
	await waitFor(() => types().includes("change.decided"))
	const decided = t.events.find((e) => e.type === "change.decided")!
	assert.equal(decided.producerId, parts)
})

test("an engineer change request mid-run makes the architect change the outline", async () => {
	const t = setup()
	sendMessage("Battery BLE temperature logger with USB-C and a status LED.", t.engineer.getId())
	await waitFor(() => CORE_FIELDS.every((f) => t.state.contract.version(f) >= 1), 5000)
	const before = t.state.contract.revision
	assert.equal(t.state.contract.get("outline")?.widthMm, 50)

	sendMessage("make the board 60 mm wide", t.engineer.getId())
	await waitFor(() => t.state.contract.get("outline")?.widthMm === 60, 5000)
	assert.ok(t.state.contract.revision > before)
	assert.equal(t.state.contract.get("outline")?.heightMm, 30, "only the width changes")
	const outlineChanges = t.changes().filter((c) => c.field === "outline")
	assert.deepEqual(outlineChanges.map((c) => c.by), ["architect", "architect"])
})

test("a change request the architect can't map to a field changes nothing", async () => {
	const t = setup()
	sendMessage("Battery BLE temperature logger with USB-C and a status LED.", t.engineer.getId())
	await waitFor(() => CORE_FIELDS.every((f) => t.state.contract.version(f) >= 1), 5000)
	await waitFor(() => (t.state.contract.get("pins") ?? []).some((p) => p.signal === "STATUS_LED"), 5000)
	await new Promise((r) => setTimeout(r, 300))
	const before = t.state.contract.revision
	sendMessage("make it prettier", t.engineer.getId())
	await new Promise((r) => setTimeout(r, 500))
	assert.equal(t.state.contract.revision, before)
	assert.equal(t.state.contract.version("requirements"), 1, "the request was not taken as a new brief")
})

const BEACON = readFileSync(new URL("../briefs/beacon.md", import.meta.url), "utf8")

test("the beacon brief gets the second scripted design: a button, no sensor, no I2C", async () => {
	const t = setup()
	sendMessage(BEACON, t.engineer.getId())
	await waitFor(() => CORE_FIELDS.every((f) => t.state.contract.version(f) >= 1) && (t.state.contract.get("pins") ?? []).some((p) => p.signal === "STATUS_LED"), 5000)
	const c = t.state.contract
	assert.ok(!c.get("parts")!.some((p) => p.role === "sensor"))
	assert.ok(c.get("parts")!.some((p) => p.ref === "SW1" && p.role === "button"))
	assert.deepEqual(c.get("pins")!.map((p) => p.signal).sort(), ["BUTTON", "STATUS_LED"])
	assert.deepEqual(c.get("connectors")!.map((x) => `${x.ref}:${x.edge}`), ["J1:left", "SW1:top"])
	assert.match(c.get("requirements")!.summary, /beacon/i)
})

test("\"add a temperature/humidity sensor\" on the beacon: parts adds the SHT40, the architect its I2C pins and a requirement", async () => {
	const t = setup()
	sendMessage(BEACON, t.engineer.getId())
	await waitFor(() => CORE_FIELDS.every((f) => t.state.contract.version(f) >= 1) && (t.state.contract.get("pins") ?? []).some((p) => p.signal === "STATUS_LED"), 5000)
	await new Promise((r) => setTimeout(r, 300))
	const mark = t.changes().length
	sendMessage("add a temperature/humidity sensor", t.engineer.getId())
	const c = t.state.contract
	await waitFor(() => (c.get("parts") ?? []).some((p) => p.ref === "U2") && (c.get("pins") ?? []).some((p) => p.signal === "I2C_SCL"), 5000)
	await new Promise((r) => setTimeout(r, 300))
	assert.equal(c.get("parts")!.find((p) => p.ref === "U2")!.mpn, "SHT40-AD1B-R2")
	assert.deepEqual(c.get("pins")!.filter((p) => p.signal.startsWith("I2C")).map((p) => `${p.signal}=GPIO${p.gpio}>${p.partRef}.${p.partPin}`), ["I2C_SDA=GPIO8>U2.SDA", "I2C_SCL=GPIO9>U2.SCL"])
	assert.ok(c.get("requirements")!.peripherals.includes("i2c-sensor"))
	assert.ok(c.get("pins")!.some((p) => p.signal === "BUTTON") && c.get("pins")!.some((p) => p.signal === "STATUS_LED"), "the other pins stay")
	const after = t.changes().slice(mark).map((x) => `${x.by}:${x.field}`)
	assert.ok(after.includes("parts:parts") && after.includes("architect:pins") && after.includes("architect:requirements"), after.join(" "))
	assert.equal(after.filter((x) => x === "parts:parts").length, 1, `parts written once: ${after.join(" ")}`)
})
