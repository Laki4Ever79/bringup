// The CNC's emergency stop and limit switches (gap 7, src/cnc/board.ts estopSwitchCtx, src/cnc/estop.ts): the e-stop's NC
// contact holds a P-FET's gate loop (VMOT to VMOT_SW), its trip disables every driver and the spindle's buffer too, the
// logic stays on the unswitched rail, and each axis has a limit input with its pull-up and filter.
import { test } from "node:test"
import assert from "node:assert/strict"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { generatedNets, supportParts, supplyWidths } from "../src/codegen/circuit.ts"
import { completePowerTree } from "../src/contract/power-auto.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { estopChecks, estopFigures } from "../src/cnc/estop.ts"
import { fixtureContract } from "./fixture.ts"

const cnc = (edit: (parts: NonNullable<(typeof CNC_DESIGN)["parts"]>) => typeof CNC_DESIGN.parts = (p) => p) => {
	const base = fixtureContract()
	const s = { ...base, values: { ...base.values, ...CNC_DESIGN, parts: edit(CNC_DESIGN.parts), cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as typeof base
	return { ...s, values: { ...s.values, parts: completePowerTree(s.values.parts!, undefined, s).parts } } as typeof base
}

test("the e-stop switch: Q2 between VMOT and VMOT_SW, the drivers and the spindle after it, the logic before it", () => {
	const s = cnc()
	const nets = generatedNets(s)
	for (const e of ["Q2.S", "Q2.S_3", "J2.VIN"]) assert.ok(nets.get("VMOT")!.includes(e), e)
	for (const e of ["Q2.D", "Q2.D_4", "U4.VS", "U7.VS2", "J3.POS"]) assert.ok(nets.get("VMOT_SW")!.includes(e), e)
	assert.ok(!nets.get("VMOT")!.includes("U4.VS"), "no driver on the unswitched rail")
	const buck = s.values.parts!.find((p) => p.role === "buck")!
	assert.ok(nets.get("VMOT")!.includes(`${buck.ref}.VIN`), "the logic's step-down stays before the switch")
	// The gate network from the catalog entry.
	const q2 = supportParts(s).filter((p) => /^Q2 /.test(p.job)).map((p) => p.spec.lcsc).sort()
	assert.deepEqual(q2, ["C14663", "C17891", "C2104", "C25741", "C25756", "C25792", "C4410", "C81598"].sort())
	assert.ok(nets.get("ESTOP_LOOP")!.includes("JE1.LOOP"), "the e-stop's NC contact closes the loop")
	// The switched rail is as wide as the rail it switches.
	assert.equal(supplyWidths(s).get("VMOT_SW"), supplyWidths(s).get("VMOT"))
})

test("a trip disables every driver (one ENN from the OR gate) and the spindle's buffer, and the MCU reads it", () => {
	const s = cnc()
	const nets = generatedNets(s)
	for (const e of ["U9.Y", "U4.ENN", "U5.ENN", "U6.ENN", "U7.ENN"]) assert.ok(nets.get("STEPPERS_ENN")!.includes(e), e)
	for (const e of ["U9.A", "U8.OE"]) assert.ok(nets.get("ESTOP_TRIP")!.includes(e), e)
	assert.ok(s.values.pins!.some((p) => p.signal === "ESTOP_TRIP" && p.partRef === "U9" && p.partPin === "A"))
	assert.ok(s.values.pins!.some((p) => p.signal === "STEPPERS_EN" && p.partRef === "U9" && p.partPin === "B"))
	// Each axis' limit input: its plug's SIG on an MCU pin, pulled up to 3.3 V and filtered.
	for (const [sig, ref] of [["LIMIT_X", "JL1"], ["LIMIT_Y", "JL2"], ["LIMIT_Z", "JL3"]]) {
		assert.ok(s.values.pins!.some((p) => p.signal === sig && p.partRef === ref && p.partPin === "SIG"), sig)
		assert.equal(supportParts(s).filter((p) => p.job.startsWith(`${ref} `)).length, 2, `${ref}: pull-up and filter`)
	}
	// No pin on two nets, no @ net with nobody else on it.
	const on = new Map<string, number>()
	for (const ends of generatedNets(s).values()) for (const e of new Set(ends)) on.set(e, (on.get(e) ?? 0) + 1)
	assert.deepEqual([...on].filter(([, n]) => n > 1).map(([e]) => e), [])
	assert.deepEqual(checkConsistency(s, {}).filter((v) => ["part-net-unknown", "net-short"].includes(v.kind)), [])
})

test("the gate loop's numbers: the contact's minimum load at the brick's low end, VGS under 25 V, a soft inrush (estimates)", () => {
	const s = cnc()
	const cat = defaultCheckCatalog()!
	const sw = (cat.boardParts as unknown as { mpn: string; gate?: unknown }[]).find((x) => x.mpn === "AO4407A")! as never
	const f = estopFigures(s.values, sw)!
	assert.ok(f.loopMa.min >= 10, `loop ${f.loopMa.min} mA`)
	assert.ok(f.vgsMaxV <= 25 && f.vgsMaxV >= 10, `VGS ${f.vgsMaxV}`)
	assert.ok(f.inrushA < CNC_MACHINE!.input.amps, `inrush ${f.inrushA} A`)
	assert.ok(f.offMj < 101, `turn-off ${f.offMj} mJ`)
	assert.deepEqual(estopChecks(s.values, cat), [])
	// Without the switch, the contact would have to break the motor rail itself: 1.5 A inductive against the 6.67 A brick.
	const direct = cnc((p) => p.filter((x) => x.role !== "estop-switch"))
	assert.match(estopChecks(direct.values, cat).map((v) => v.message).join("\n"), /breaks 1\.5 A of inductive load/)
})

test("the spindle's current is measured (its stall stop): a 10 mOhm shunt under Q1's source, the INA180A1 to an ADC pin, 16.5 A full scale", async () => {
	const { spindleSenseChecks } = await import("../src/cnc/estop.ts")
	const s = cnc()
	const nets = generatedNets(s)
	for (const e of ["Q1.S", "Q1.S_3", "U10.INP"]) assert.ok(nets.get("SPINDLE_SHUNT")!.includes(e), e)
	assert.ok(nets.get("GND")!.includes("U10.INN"), "IN- on the shunt's ground side")
	assert.ok(supportParts(s).some((p) => /^U10 spindle shunt/.test(p.job) && p.spec.lcsc === "C466594"))
	assert.ok(s.values.pins!.some((p) => p.signal === "SPINDLE_I" && p.partRef === "U10" && p.partPin === "OUT"))
	const cat = defaultCheckCatalog()!
	assert.deepEqual(spindleSenseChecks(s.values, cat), [])
	// Without it the stall can't be seen: the parts agent hears it.
	const blind = cnc((p) => p.filter((x) => x.role !== "current-sense"))
	assert.match(spindleSenseChecks(blind.values, cat).map((v) => v.message).join("\n"), /the spindle has no current sense/)
})
