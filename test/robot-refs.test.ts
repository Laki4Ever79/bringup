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
