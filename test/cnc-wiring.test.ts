// The CNC's fixed wiring in code (src/cnc/wiring-auto.ts, docs/cnc.md gap 2): the scripted CNC with every hand-written
// net taken out but the MCU's gets them all back, and the board's nets are the hand-wired design's, pin for pin.
import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { completeCncBoard, withCncPlugs, withCncWiring } from "../src/cnc/wiring-auto.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { cncChecks } from "../src/cnc/checks.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { resolve } from "node:path"
import { completePowerTree } from "../src/contract/power-auto.ts"
import { generatedNets } from "../src/codegen/circuit.ts"
import { OWNERS, type ContractSnapshot, type FieldName, type Part } from "../src/contract/types.ts"
import { FunctionCallOutputItem, ModelMessageItem } from "@mozaik-ai/core"
import { BringupState, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { createRoleAgent, startTurn } from "../src/agents/common.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 200)))

const b = fixtureContract()
const cnc = (parts: Part[]): ContractSnapshot => {
	const s = { ...b, values: { ...b.values, ...CNC_DESIGN, parts, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as ContractSnapshot
	return { ...s, values: { ...s.values, parts: completePowerTree(parts, undefined, s).parts } }
}
const bare = CNC_DESIGN.parts!.map((p) => (p.role === "mcu" ? p : { ...p, nets: undefined }))
const sorted = (m: Map<string, string[]>) => [...m.entries()].map(([n, ps]) => `${n}: ${[...ps].sort().join(" ")}`).sort()

test("every hand-written net of the scripted CNC comes back from code, and the board's nets are the same", () => {
	const hand = CNC_DESIGN.parts!.filter((p) => p.role !== "mcu" && p.nets).map((p) => p.ref)
	assert.deepEqual(hand.sort(), ["J2", "J3", "JE1", "JX1", "JX2", "JX3", "JX4", "Q1", "R20"])
	const w = withCncWiring(bare, cnc(bare))
	assert.ok(w.note)
	for (const p of CNC_DESIGN.parts!.filter((x) => x.role !== "mcu" && x.nets)) {
		const got = w.parts.find((x) => x.ref === p.ref)!.nets
		for (const [pin, net] of Object.entries(p.nets!)) assert.equal(got?.[pin], net, `${p.ref}.${pin}`)
	}
	assert.deepEqual(sorted(generatedNets(cnc(w.parts))), sorted(generatedNets(cnc(CNC_DESIGN.parts!))))
})

test("a net the agent wrote stays; a second pass changes nothing; no spindle current sense puts the MOSFET's source on GND", () => {
	const mine = bare.map((p) => (p.ref === "JX1" ? { ...p, nets: { A1: "@Z_A1", A2: "@Z_A2", B1: "@Z_B1", B2: "@Z_B2" } } : p))
	const w = withCncWiring(mine, cnc(mine))
	assert.equal(w.parts.find((p) => p.ref === "JX1")!.nets!.A1, "@Z_A1")
	// The plugs left take the motors left, in order: Z is taken, so X, Y1, Y2.
	assert.deepEqual(["JX2", "JX3", "JX4"].map((r) => w.parts.find((p) => p.ref === r)!.nets!.A1), ["@X_A1", "@Y1_A1", "@Y2_A1"])
	assert.deepEqual(withCncWiring(w.parts, cnc(w.parts)), { parts: w.parts, note: null })
	const unsensed = bare.filter((p) => p.role !== "current-sense")
	const q1 = withCncWiring(unsensed, cnc(unsensed)).parts.find((p) => p.ref === "Q1")!
	assert.deepEqual([q1.nets!.S, q1.nets!.G, q1.nets!.D_4], ["GND", "@SPINDLE_GATE", "@SPINDLE_N"])
})

const once = (call: ReturnType<typeof toolCall>): Script => (items) => (items.at(-1) instanceof FunctionCallOutputItem ? [ModelMessageItem.rehydrate({ text: "done" })] : [call])
test("through the contract tools: bare parts first, the mechanics engineer's cnc later, and the plugs and the jack are wired", async () => {
	const state = new BringupState(tempDir(), 3000)
	for (const [field, value] of Object.entries({ ...b.values, ...CNC_DESIGN, parts: bare, cncTargets: CNC_TARGETS }) as [FieldName, never][]) {
		if (value === undefined || field === "cnc") continue
		assert.equal(state.contract.propose({ field, value, by: OWNERS[field], baseVersion: 0 }).status, "applied", field)
	}
	startRuntime(state, inferenceConfig(true, { "mock-mechanics": once(toolCall("propose_contract_change", { field: "cnc", value: CNC_MACHINE, baseVersion: 0, reason: "the machine" })) }), null)
	const mech = createRoleAgent({ role: "mechanics", instruction: "x", handlers: [], mock: true })
	startTurn(mech, "design the machine")
	const part = (ref: string) => state.contract.get("parts")!.find((p) => p.ref === ref)
	await waitFor(() => state.contract.version("cnc") === 1 && part("JX4")?.nets?.A1 === "@Z_A1")
	assert.equal(part("J2")!.nets!.VIN, "VMOT")
	assert.equal(part("J3")!.nets!.POS, "@VMOT_SW")
	assert.equal(part("R20")!.nets!.pin2, "@STEPPER_UART")
	assert.equal(part("JE1")!.nets!.LOOP, "@ESTOP_LOOP")
	// The power tree still lands: it finds the brick by the jack's VIN, so the wiring goes first (--no-hardware mock,
	// 27 Nov 2026: the tree ran on a bare jack, and U8.VCC had no 5 V).
	await waitFor(() => state.contract.get("parts")!.some((p) => p.role === "buck"))
	assert.deepEqual(state.contract.get("parts")!.filter((p) => ["buck", "diode"].includes(p.role ?? "")).map((p) => p.role).sort(), ["buck", "diode", "diode"])
})

const catalog = loadCatalog(resolve(import.meta.dirname, "..")) as never
const PLUG = /^(J[23]|JX\d|JL\d|JE1)$/
test("no plugs at all: the machine's jack, four motor plugs, spindle terminal, e-stop plug and three limit plugs come from code, and the board is the hand-wired one", () => {
	const none = bare.filter((p) => !PLUG.test(p.ref))
	assert.equal(none.length, bare.length - 10)
	const c = completeCncBoard(none, cnc(none), catalog)
	assert.match(c.note!, /added J2 DC-091-A250, JX1 B4B-XH-A\(LF\)\(SN\), JX2 .*JX4 .*J3 KF128R-5.08-2P, JE1 B2B-XH-A-R\(LF\)\(SN\), JL1 S2B-XH-A\(LF\)\(SN\), JL2 .*JL3 /)
	assert.deepEqual(sorted(generatedNets(cnc(c.parts))), sorted(generatedNets(cnc(CNC_DESIGN.parts!))))
	// The agent's own plugs count: the full scripted list gets nothing added.
	assert.equal(withCncPlugs(CNC_DESIGN.parts!, cnc(CNC_DESIGN.parts!), catalog).note, null)
})

test("the chips nothing else asked for: a CNC without its spindle gate driver, its MOSFET or the drivers' enable gate is told which to add", () => {
	const cat = defaultCheckCatalog()!
	const msgs = (drop: string) => cncChecks({ ...CNC_DESIGN, parts: CNC_DESIGN.parts!.filter((p) => p.ref !== drop), cnc: CNC_MACHINE, cncTargets: CNC_TARGETS }, cat).map((x) => x.message)
	assert.deepEqual(cncChecks({ ...CNC_DESIGN, cnc: CNC_MACHINE, cncTargets: CNC_TARGETS }, cat).filter((x) => /the CNC's board is missing/.test(x.message)), [])
	assert.ok(msgs("U8").some((m) => /is missing the spindle's gate driver \(role spindle-driver, SN74AHCT1G125DBVR/.test(m)))
	assert.ok(msgs("Q1").some((m) => /\(role mosfet, AO4468/.test(m)))
	assert.ok(msgs("U9").some((m) => /\(role enable-gate, SN74LVC1G32DBVR/.test(m)))
})
