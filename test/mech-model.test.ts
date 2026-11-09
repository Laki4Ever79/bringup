// The drive model (src/mechanics/model.ts): plain physics the mechanics checks and the simulation share.
import { test } from "node:test"
import assert from "node:assert/strict"
import { edgeForceN, massAndCom, motorAt, mounts, supportPolygon } from "../src/mechanics/model.ts"
import type { MechCatalog, MotorPart } from "../src/mechanics/catalog.ts"
import type { Mechanics } from "../src/mechanics/types.ts"

const cite = { url: "https://example.com/ds", where: "table 1" }
const motor: MotorPart = { mpn: "M1", ratedV: 6, noLoadRpm: 300, stallTorqueNm: 0.12, stallA: 1.6, noLoadA: 0.07, gearRatio: 100, bodyMm: [34, 12, 10], shaftMm: 3, massG: 10, source: { ratedV: cite } }
const cat: MechCatalog = {
	motors: [motor],
	wheels: [{ mpn: "W1", diameterMm: 60, widthMm: 8, shaftMm: 3, massG: 10, tread: "rubber", source: {} }],
	casters: [{ mpn: "C1", wheelMm: 25, heightMm: 32, swivel: true, holesMm: [[-10, 0], [10, 0]], massG: 15, source: {} }],
	batteries: [{ mpn: "B1", cells: 1, nominalV: 3.7, fullV: 4.2, cutoffV: 3.0, mAh: 1000, maxContA: 2, peakA: 4, sizeMm: [50, 34, 8], massG: 20, source: {} }],
}
const mech: Mechanics = {
	drive: { kind: "differential", motor: "M1", wheel: "W1", caster: "C1", trackMm: 110, wheelbaseMm: 90, axleXMm: 30 },
	battery: { pack: "B1", at: { xMm: 0, yMm: 0 } },
	chassis: { plateMm: [150, 120], thicknessMm: 3, material: "PLA", clearanceMm: 12, boards: [{ name: "main", at: { xMm: 0, yMm: 0 }, rotDeg: 0 }] },
}

test("the motor curve gives the datasheet points at rated voltage and scales linearly with voltage", () => {
	const m = motorAt(motor, 6)
	assert.ok(Math.abs(m.noLoadRadS - (300 * 2 * Math.PI) / 60) < 1e-9)
	assert.ok(Math.abs(m.stallNm - 0.12) < 1e-12)
	assert.ok(Math.abs(m.stallA - 1.6) < 1e-12)
	const half = motorAt(motor, 3)
	assert.ok(Math.abs(half.noLoadRadS - m.noLoadRadS / 2) < 1e-9)
	assert.ok(Math.abs(half.stallNm - 0.06) < 1e-12)
})

test("lifting a wheel over a step takes W·√(h(2r−h))/(r−h); a step as high as the axle can't be climbed", () => {
	const W = 0.5 * 9.81, r = 0.0315, h = 0.01
	assert.ok(Math.abs(edgeForceN(0.5, r, h) - (W * Math.sqrt(h * (2 * r - h))) / (r - h)) < 1e-9)
	assert.equal(edgeForceN(0.5, r, 0.04), Infinity)
})

test("two equal masses at ±50 mm put the centre of mass in the middle", () => {
	const r = massAndCom([
		{ what: "a", xMm: 50, yMm: 0, zMm: 10, sizeMm: [1, 1, 1], massG: 100 },
		{ what: "b", xMm: -50, yMm: 0, zMm: 10, sizeMm: [1, 1, 1], massG: 100 },
	])
	assert.equal(r.massG, 200)
	assert.deepEqual(r.com, [0, 0, 10])
})

test("the rover rests on its two wheels and the caster behind the axle", () => {
	const poly = supportPolygon(mech, cat)
	assert.equal(poly.length, 3)
	const caster = poly.find(([, y]) => y === 0)!
	assert.ok(caster[0] < 30, "behind the axle")
	assert.deepEqual(poly.filter(([, y]) => y !== 0).map(([x, y]) => [x, Math.abs(y)]), [[30, 55], [30, 55]])
})

test("mounts list every part once, with the board, battery, motors, wheels, caster and plate", () => {
	const m = mounts(mech, [{ name: "main", outline: { widthMm: 50, heightMm: 30 } }], cat)
	assert.deepEqual(m.map((x) => x.what).sort(), ["battery", "board:main", "caster", "motor:left", "motor:right", "plate", "wheel:left", "wheel:right"])
	assert.ok(m.every((x) => x.massG > 0))
})
