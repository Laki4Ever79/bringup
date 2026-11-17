// A robot's power tree is decided in code (src/contract/power-auto.ts), and a pack change regenerates it in the same step
// (real run 19b, Eurobot, 17 Nov 2026: the mechanics switched to the 2S pack at revision 17, and 19 revisions went on the
// agents adding and removing a 1-cell charger, an ideal diode, a buck and its Schottkys; the run hit its revision cap).
// And a board built from older inputs doesn't send agents after what the current contract already wires (the same run:
// the rev-10 board's JM2.VCC and JE1.VBAT were reported for 25 revisions, though the generator wired them from rev 12).
import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { FunctionCallOutputItem, ModelMessageItem } from "@mozaik-ai/core"
import { BringupState, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { createRoleAgent, startTurn } from "../src/agents/common.ts"
import { completePowerTree } from "../src/contract/power-auto.ts"
import { checkConsistency, packVoltage, supplyWiring, unconnectedParts } from "../src/contract/consistency.ts"
import { OWNERS, type ContractSnapshot, type FieldName } from "../src/contract/types.ts"
import { stubBoard } from "../src/tools/stubs.ts"
import { tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 200)))

const fx = (r: number) => JSON.parse(readFileSync(new URL(`./fixtures/cc-eurobot-19b-rev${r}.json`, import.meta.url), "utf8")) as ContractSnapshot
const POWER = ["charger", "charge-led", "buck", "diode", "ideal-diode"]
const tree = (s: ContractSnapshot) => (s.values.parts ?? []).filter((p) => POWER.includes(p.role ?? "")).map((p) => `${p.ref} ${p.role}`).sort()
const powerKinds = (s: ContractSnapshot) => [...packVoltage(s), ...supplyWiring(s)].map((v) => v.kind).filter((k) => ["pack-voltage", "charger-pack", "rail-battery-source", "net-short"].includes(k))

test("19b rev 17 (2S pack, 1-cell TP4054 left on): the parts write lands the tree complete", () => {
	const s = fx(17)
	assert.deepEqual(powerKinds(s).sort(), ["charger-pack", "pack-voltage"])
	const t = completePowerTree(s.values.parts!, s.values.mechanics!)
	const after = { ...s, values: { ...s.values, parts: t.parts } } as ContractSnapshot
	assert.deepEqual(tree(after), ["D10 diode", "D11 diode", "U7 buck"])
	assert.deepEqual(powerKinds(after), [])
	// Idempotent: a second write changes nothing.
	assert.equal(completePowerTree(t.parts, s.values.mechanics!).note, null)
})

function seeded(s: ContractSnapshot, skip: FieldName[] = []) {
	const state = new BringupState(tempDir(), 3000)
	for (const [field, value] of Object.entries(s.values) as [FieldName, never][]) {
		if (value === undefined || skip.includes(field)) continue
		const r = state.contract.propose({ field, value, by: OWNERS[field], baseVersion: 0 })
		assert.equal(r.status, "applied", `${field}: ${JSON.stringify(r)}`)
	}
	return state
}
const once = (call: ReturnType<typeof toolCall>): Script => (items) => (items.at(-1) instanceof FunctionCallOutputItem ? [ModelMessageItem.rehydrate({ text: "done" })] : [call])

test("19b rev 16 → 17: the switch to the 2S pack regenerates the power tree in the same step (one parts write)", async () => {
	const s16 = fx(16)
	const s17 = fx(17)
	const state = seeded(s16)
	assert.deepEqual(tree(state.contract.snapshot()), ["U4 charger"])
	startRuntime(state, inferenceConfig(true, { "mock-mechanics": once(toolCall("propose_contract_change", { field: "mechanics", value: s17.values.mechanics, baseVersion: 1, reason: "run 19b: the 2S pack" })) }), null)
	const mech = createRoleAgent({ role: "mechanics", instruction: "x", handlers: [], mock: true })
	startTurn(mech, "switch the pack")
	await waitFor(() => state.contract.version("mechanics") === 2)
	const now = state.contract.snapshot()
	assert.equal(now.versions.parts, 2, "one parts write follows the pack")
	assert.deepEqual(tree(now), ["D10 diode", "D11 diode", "U7 buck"])
	assert.deepEqual(powerKinds(now), [])
	assert.deepEqual(unconnectedParts(now).map((v) => v.message.split(" is ")[0]), [])
})

// The scripted Eurobot (mock, 17 Nov 2026): the mechanics' 2S pack dropped the TP4054 and its LED and left R4 (PROG),
// R7 (the LED's resistor) and C4 on nothing; the run ended unsettled at revision 9 on them.
test("the mock Eurobot's first mechanics write: the charger goes with its passives, nothing left unconnected", async () => {
	const s = JSON.parse(readFileSync(new URL("./fixtures/mock-eurobot-rev8.json", import.meta.url), "utf8")) as ContractSnapshot
	const state = seeded(s, ["mechanics"])
	startRuntime(state, inferenceConfig(true, { "mock-mechanics": once(toolCall("propose_contract_change", { field: "mechanics", value: s.values.mechanics, baseVersion: 0, reason: "the 2S pack" })) }), null)
	const mech = createRoleAgent({ role: "mechanics", instruction: "x", handlers: [], mock: true })
	startTurn(mech, "lay out the robot")
	await waitFor(() => state.contract.version("mechanics") === 1)
	const now = state.contract.snapshot()
	assert.equal(now.versions.parts, 2)
	assert.ok(!now.values.parts!.some((p) => ["U4", "D2", "R4", "R7", "C4"].includes(p.ref)))
	assert.deepEqual(unconnectedParts(now).map((v) => v.message.split(" is ")[0]), [])
	assert.deepEqual(powerKinds(now), [])
})

test("a board built from older inputs: supply pins the current contract wires wake nobody; on a current board they do", () => {
	const s10 = fx(10)
	const s12 = fx(12)
	const board = stubBoard(s10, 10, "")
	const supply = (stale: boolean) => checkConsistency(s12, { board }, "", { boardStale: stale }).filter((v) => v.kind === "supply-unwired")
	// Before: rev 12 judged on the rev-10 board named JM2.VCC and JE1.VBAT, which rev 12 wires.
	assert.match(supply(false)[0]?.message ?? "", /JM2\.VCC.*JE1\.VBAT/)
	assert.deepEqual(supply(true), [])
	// A pin open on the stale board that the current contract leaves open too is still reported (pins the old board wired
	// wait for the rebuild; a dropped 3V3 rail is rail-missing from the contract itself).
	const open = { ...s12, values: { ...s12.values, rails: s12.values.rails!.filter((r) => r.name !== "3V3") } } as ContractSnapshot
	const pinsOf = (x: ReturnType<typeof checkConsistency>) => x.filter((v) => v.kind === "supply-unwired").flatMap((v) => v.message.match(/leaves (.*) on no net/)![1].split(", "))
	assert.deepEqual(pinsOf(checkConsistency(open, { board: stubBoard(open, 12, "") }, "")), ["U1.3V3", "JM1.VCC", "JM2.VCC", "JT1.VCC"])
	assert.deepEqual(pinsOf(checkConsistency(open, { board }, "", { boardStale: true })), ["JM2.VCC"])
	assert.ok(checkConsistency(open, { board }, "", { boardStale: true }).some((v) => v.kind === "rail-missing"))
})

test("net-missing on a board built from older pins wakes nobody (the rebuild wires them)", () => {
	const s12 = fx(12)
	const board = stubBoard(fx(10), 10, "")
	const missing = (stale: boolean) => checkConsistency(s12, { board }, "", { boardStale: stale }).filter((v) => v.kind === "net-missing")
	assert.ok(missing(false).length > 0)
	assert.ok(missing(false).every((v) => v.affects.includes("board")))
	assert.ok(missing(true).every((v) => v.affects.length === 0 && /built for revision 10/.test(v.message)))
})
