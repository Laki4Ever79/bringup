// A bought computer's typical draw counts in the robot's runtime and pack current (rover-pi, 15 Nov 2026: the Pi 5's
// 0.8 A at 5.1 V was left out, so the runtime figure was the motors' and the MCU board's alone).
import { test } from "node:test"
import assert from "node:assert/strict"
import { ASSUMED_REGULATOR_EFFICIENCY, boughtComputeA, defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { byMpn } from "../src/mechanics/catalog.ts"
import { COMPUTE_ROVER_PACK, COMPUTE_ROVER_REGULATOR, ROVER_MECHANICS } from "../src/inference/scripts.ts"
import type { Mechanics } from "../src/mechanics/types.ts"

const cat = defaultCheckCatalog()!
const pack = byMpn(cat.mech.batteries, COMPUTE_ROVER_PACK)!
const withPi = (regulator?: string): Mechanics => ({ ...ROVER_MECHANICS!, ...(regulator ? { regulator } : {}), chassis: { ...ROVER_MECHANICS!.chassis, boards: [{ name: "main", at: { xMm: 0, yMm: 0 }, rotDeg: 0 }, { name: "brain", at: { xMm: -70, yMm: 0 }, rotDeg: 0, module: "rpi-5" }] } }) as Mechanics

test("the Pi 5's 0.8 A at 5.1 V through the D36V50F5's 80 % from the 2S pack's 7.4 V: about 0.69 A", () => {
	const reg = byMpn(cat.mech.regulators ?? [], COMPUTE_ROVER_REGULATOR)!
	const r = boughtComputeA(withPi(reg.mpn), pack, cat)
	assert.equal(Math.round(r.amps * 100) / 100, Math.round(((0.8 * 5.1) / reg.efficiency / pack.nominalV) * 100) / 100)
	assert.match(r.how, /brain \(rpi-5\) 0\.8 A at 5\.1 V typical, through POLOLU-4091/)
})

test("no regulator chosen: the assumed efficiency, labelled an estimate; no bought board: nothing", () => {
	const r = boughtComputeA(withPi(), pack, cat)
	assert.equal(r.amps, (0.8 * 5.1) / ASSUMED_REGULATOR_EFFICIENCY / pack.nominalV)
	assert.match(r.how, /ESTIMATE/)
	assert.deepEqual(boughtComputeA(ROVER_MECHANICS as Mechanics, pack, cat), { amps: 0, how: "" })
})
