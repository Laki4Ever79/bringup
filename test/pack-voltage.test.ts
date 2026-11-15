// A robot's pack against what its board puts on VBAT: a 1-cell charger on a 2S pack, and a 5.5 V regulator on 8.4 V
// (rover-pi, 15 Nov 2026: the main board kept the logger's TP4054 and RT9080 on the 2S pack).
import { test } from "node:test"
import assert from "node:assert/strict"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { packVoltage } from "../src/contract/consistency.ts"
import { generatedNets, supportParts } from "../src/codegen/circuit.ts"
import { COMPUTE_ROVER_PACK, ROVER_BOARD } from "../src/inference/scripts.ts"

const rover = (pack: string): ContractSnapshot => {
	const v = structuredClone(ROVER_BOARD) as unknown as ContractSnapshot["values"]
	v.mechanics = { ...v.mechanics!, battery: { ...v.mechanics!.battery, pack } }
	return { revision: 1, values: v } as ContractSnapshot
}

test("the reference rover's 1S pack: the TP4054 and RT9080 fit", () => {
	assert.deepEqual(packVoltage(rover(ROVER_BOARD.mechanics!.battery.pack)), [])
})

test("a 2S pack: the 1-cell charger and the 5.5 V LDO on VBAT are each named, with their datasheet figures", () => {
	const v = packVoltage(rover(COMPUTE_ROVER_PACK))
	assert.deepEqual(v.map((x) => x.kind), ["charger-pack", "pack-voltage"])
	assert.match(v[0].message, /U4 TP4054-42-SOT25R charges 1 cell to 4\.2 V .* is 2S \(6–8\.4 V\)/)
	assert.match(v[1].message, /U3 RT9080-33GJ5 \(ldo\) is on VBAT and takes at most 5\.5 V \(Richtek RT9080 datasheet DS9080-09/)
	assert.deepEqual(v.map((x) => x.affects), [["parts"], ["parts"]])
})

test("without the charger (and its LED and resistors) the LDO takes USB, the pack feeds only the motor driver, and nothing is flagged", () => {
	const c = rover(COMPUTE_ROVER_PACK)
	const drop = new Set(["U4", "D2"])
	const used = supportParts(c).filter((sp) => [sp.a, sp.b].some((e) => "ref" in e && drop.has(e.ref))).map((sp) => sp.ref)
	assert.deepEqual(used.sort(), ["R4", "R7"])
	c.values.parts = c.values.parts!.filter((p) => !drop.has(p.ref) && !used.includes(p.ref))
	const nets = generatedNets(c)
	assert.ok(nets.get("VBUS")!.includes("U3.VIN"))
	// The pack's socket, the driver's VM and their capacitors; no regulator, no charger.
	assert.deepEqual(nets.get("VBAT")!.map((e) => e.split(".")[0]).filter((r) => !r.startsWith("C")).sort(), ["J2", "U5"])
	assert.deepEqual(packVoltage(c), [])
})
