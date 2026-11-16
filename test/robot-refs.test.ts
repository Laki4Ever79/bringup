// A robot's plugs have fixed names (rover run cc-rover-4 on the Claude subscription, 15 Nov 2026: the parts agent, the
// architect and the mechanics renamed the motor and sensor plugs JM1, JM2, JT1, JMOT1, JMOT2 in turn for 30 revisions).
import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { FunctionCallOutputItem, ModelMessageItem } from "@mozaik-ai/core"
import { BringupState, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { createRoleAgent, startTurn } from "../src/agents/common.ts"
import { connectorsForParts, robotRefs } from "../src/mechanics/refs.ts"
import { OWNERS, type ContractSnapshot, type FieldName } from "../src/contract/types.ts"
import { tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 200)))

const rev26 = () => JSON.parse(readFileSync(new URL("./fixtures/cc-rover-4-rev26.json", import.meta.url), "utf8")) as ContractSnapshot

test("the plugs take their fixed names: sensor JT1, motors JM1 and JM2; other parts keep theirs", () => {
	const parts = rev26().values.parts!
	const r = robotRefs(parts)
	assert.deepEqual(r.renames, { JM1: "JT1", JMOT1: "JM1", JMOT2: "JM2" })
	assert.equal(new Set(r.parts.map((p) => p.ref)).size, parts.length, "no ref twice")
	assert.deepEqual(robotRefs(r.parts).renames, {}, "named parts stay named")
	assert.equal(r.parts.find((p) => p.ref === "J2")!.role, "battery")
})

test("a part holding a plug's name that isn't that plug moves to a free J<n>", () => {
	const plug = (ref: string, pins: string[]) => ({ ref, role: "connector", mpn: "x", lcsc: null, footprint: "f", pins })
	const r = robotRefs([{ ref: "JT1", role: "led", mpn: "x", lcsc: null, footprint: "f", pins: ["A", "K"] }, plug("J5", ["GND", "VCC", "IO1", "IO2"]), plug("J2", ["1", "2"])])
	assert.deepEqual(r.renames, { JT1: "J3", J5: "JT1", J2: "JM1" })
})

test("connectors naming no part go to the plugs with no connector, in order", () => {
	const parts = robotRefs(rev26().values.parts!).parts
	const k = (ref: string) => ({ ref })
	assert.deepEqual(connectorsForParts([k("J1"), k("J2"), k("JT1"), k("JX"), k("JY")], parts)!.map((c) => c.ref), ["J1", "J2", "JT1", "JM1", "JM2"])
	assert.equal(connectorsForParts([k("J1"), k("J2"), k("JT1"), k("JM1"), k("JM2")], parts), null)
})

const once = (call: ReturnType<typeof toolCall>): Script => (items) => (items.at(-1) instanceof FunctionCallOutputItem ? [ModelMessageItem.rehydrate({ text: "done" })] : [call])

test("run 4's revision 26: the parts agent's list is renamed, and the connectors and mechanics agree with it", async () => {
	const s = rev26()
	const state = new BringupState(tempDir(), 3000)
	for (const [field, value] of Object.entries(s.values) as [FieldName, never][]) {
		if (value === undefined) continue
		assert.equal(state.contract.propose({ field, value, by: OWNERS[field], baseVersion: 0 }).status, "applied", field)
	}
	const parts = s.values.parts!.map((p) => ({ ...p, reason: "again" }))
	startRuntime(state, inferenceConfig(true, { "mock-parts": once(toolCall("propose_contract_change", { field: "parts", value: parts, baseVersion: 1, reason: "same parts" })) }), null)
	const agent = createRoleAgent({ role: "parts", instruction: "x", handlers: [], mock: true })
	startTurn(agent, "fix the parts")
	await waitFor(() => state.contract.version("connectors") === 2)
	const now = state.contract.snapshot().values
	const plugs = now.parts!.filter((p) => p.role === "connector").map((p) => p.ref).sort()
	assert.deepEqual(plugs, ["JM1", "JM2", "JT1"])
	assert.deepEqual(now.connectors!.map((c) => c.ref).sort(), ["J1", "J2", "JM1", "JM2", "JT1"])
})

// Run cc-eurobot-10 (16 Nov 2026): the start plug was JS1 in the parts and J4 in the pins, the e-stop's J3 in the
// mechanics; the e-stop's and start cord's plugs have fixed names too.
const rev25 = () => JSON.parse(readFileSync(new URL("./fixtures/cc-eurobot-10-rev25.json", import.meta.url), "utf8")) as ContractSnapshot

test("the e-stop's and the start cord's plugs take their fixed names, JE1 and JS1", () => {
	const plug = (ref: string, role: string, pins: string[]) => ({ ref, role, mpn: "x", lcsc: null, footprint: "f", pins })
	const r = robotRefs([plug("J3", "estop", ["VBAT", "VM"]), plug("J4", "start", ["START", "GND"]), plug("JE1", "led", ["A", "K"])])
	assert.equal(r.renames.J3, "JE1")
	assert.equal(r.renames.J4, "JS1")
	assert.ok(r.renames.JE1 && r.renames.JE1 !== "JE1", "a part holding JE1 that isn't the e-stop's plug moves")
})

function seeded25(skip: FieldName[]) {
	const s = rev25()
	const state = new BringupState(tempDir(), 3000)
	for (const [field, value] of Object.entries(s.values) as [FieldName, never][]) {
		if (value === undefined || skip.includes(field)) continue
		assert.equal(state.contract.propose({ field, value, by: OWNERS[field], baseVersion: 0 }).status, "applied", field)
	}
	return { s, state }
}

test("run 10's revision 25: the START pin proposed on J4 lands on the start plug JS1", async () => {
	const { s, state } = seeded25(["pins"])
	startRuntime(state, inferenceConfig(true, { "mock-architect": once(toolCall("propose_contract_change", { field: "pins", value: s.values.pins, baseVersion: 0, reason: "run 10's pins" })) }), null)
	startTurn(createRoleAgent({ role: "architect", instruction: "x", handlers: [], mock: true }), "assign the pins")
	await waitFor(() => state.contract.version("pins") === 1)
	assert.equal(state.contract.get("pins")!.find((p) => p.signal === "START")!.partRef, "JS1")
})

test("run 10's revision 25: the mechanics' e-stop plug J3 is written as JE1", async () => {
	const { s, state } = seeded25(["mechanics"])
	startRuntime(state, inferenceConfig(true, { "mock-mechanics": once(toolCall("propose_contract_change", { field: "mechanics", value: s.values.mechanics, baseVersion: 0, reason: "run 10's mechanics" })) }), null)
	startTurn(createRoleAgent({ role: "mechanics", instruction: "x", handlers: [], mock: true }), "lay out the robot")
	await waitFor(() => state.contract.version("mechanics") === 1)
	const safety = state.contract.get("mechanics")!.safety!
	assert.equal(safety.estop!.connector, "JE1")
	assert.equal(safety.start!.connector, "JS1")
})
