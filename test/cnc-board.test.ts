// The CNC's stepper drivers on the board (src/cnc/board.ts, the TMC2209-LA's catalog nets/support, circuit.ts
// chipInstances; docs/cnc.md gap 5): the motor rail, one UART, a distinct address per driver, the sense resistors for the
// run current, each motor's plug on its driver's outputs; and an "@" net no other part is on is reported.
import { test } from "node:test"
import assert from "node:assert/strict"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { chipInstances, generatedNets, supportParts } from "../src/codegen/circuit.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { cncMotors, senseResistor, tmc2209MaxRmsA } from "../src/cnc/board.ts"
import { fixtureContract } from "./fixture.ts"

const cnc = () => {
	const base = fixtureContract()
	return { ...base, values: { ...base.values, ...CNC_DESIGN, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as typeof base
}

test("the scripted CNC's drivers: VS on the 24 V rail, one shared UART, addresses 0-3, each plug on its driver", () => {
	const s = cnc()
	const nets = generatedNets(s)
	assert.deepEqual(nets.get("VMOT")!.filter((e) => /^U\d\.VS/.test(e)).sort(), ["U4.VS", "U4.VS2", "U5.VS", "U5.VS2", "U6.VS", "U6.VS2", "U7.VS", "U7.VS2"])
	assert.ok(nets.get("VMOT")!.includes("J2.VIN"), "the brick's jack feeds it")
	assert.deepEqual(nets.get("STEPPER_UART")!.sort(), ["U4.PDN_UART", "U5.PDN_UART", "U6.PDN_UART", "U7.PDN_UART"])
	for (const [motor, driver, plug] of [["X", "U4", "JX1"], ["Y1", "U5", "JX2"], ["Y2", "U6", "JX3"], ["Z", "U7", "JX4"]])
		for (const [coil, out] of [["A1", "OA1"], ["A2", "OA2"], ["B1", "OB1"], ["B2", "OB2"]]) assert.deepEqual(nets.get(`${motor}_${coil}`)!.sort(), [`${driver}.${out}`, `${plug}.${coil}`].sort())
	// The UART addresses: X, Y and Z their axes' (0, 1, 2), the gantry's second Y motor the free one (3); the straps follow.
	assert.deepEqual(cncMotors(s).map((m) => `${m.label}:${m.addr}`), ["X:0", "Y1:1", "Y2:3", "Z:2"])
	const straps = chipInstances(s).map((i) => `${i.part.ref} ${i.ctx.ms1}/${i.ctx.ms2}`)
	assert.deepEqual(straps, ["U4 GND/GND", "U5 rail:3V3/GND", "U6 rail:3V3/rail:3V3", "U7 GND/rail:3V3"])
	// Each driver's support from its catalog entry: 8 parts, the sense resistors sized for 1.2 A.
	const sup = supportParts(s).filter((p) => /^U[4-7] /.test(p.job))
	assert.equal(sup.length, 32)
	assert.ok(sup.filter((p) => /sense resistor/.test(p.job)).every((p) => /0\.15 Ω: 1\.35 A RMS full scale for 1\.2 A/.test(p.job)))
})

test("the sense resistor: the largest catalog value whose full scale covers the run current (datasheet §9)", () => {
	assert.equal(senseResistor(1.2)?.ohms, 0.15)
	assert.ok(Math.abs(tmc2209MaxRmsA(0.15) - 1.352) < 0.001)
	assert.equal(senseResistor(1.5)?.ohms, 0.1, "over 0.15 Ω's 1.35 A: the 0.1 Ω (1.92 A)")
	assert.equal(senseResistor(2.5), null, "over the catalog's range")
})

test("a part's @-net must be one another part is on: a typo reports part-net-unknown", () => {
	const s = cnc()
	assert.ok(!checkConsistency(s, {}, "").some((v) => v.kind === "part-net-unknown"), "the plugs' nets all meet their drivers")
	s.values.parts = s.values.parts!.map((p) => (p.ref === "JX1" ? { ...p, nets: { ...p.nets, A1: "@X_AI" } } : p))
	const bad = checkConsistency(s, {}, "").filter((v) => v.kind === "part-net-unknown")
	assert.equal(bad.length, 1)
	assert.match(bad[0].message, /JX1's nets put pin A1 on @X_AI, but no other part is on the net "X_AI"/)
})

test("the board rebuilds when mechanics writes cnc: the drivers' context (motor rail, plugs) comes from it", async () => {
	// CNC mock 9 (26 Nov 2026): the board built before cnc existed (no VMOT net, plugs unconnected) stayed current to the end.
	const { BOARD_DERIVED, BUILD_DERIVED } = await import("../src/agents/builders.ts")
	assert.ok(BUILD_DERIVED.board!.fields.includes("cnc"))
	const s = cnc()
	const without = { ...s, values: { ...s.values, cnc: undefined } } as typeof s
	assert.notDeepEqual(BOARD_DERIVED(without), BOARD_DERIVED(s))
	// The capacitor fix (mock 8): every driver capacitor in reach, none the reach check can't measure.
	const { unreachableCaps, capsUnchecked } = await import("../src/codegen/circuit.ts")
	assert.deepEqual(capsUnchecked(s), [])
	assert.deepEqual(unreachableCaps(s), [])
})
