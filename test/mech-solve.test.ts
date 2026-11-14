import { test } from "node:test"
import assert from "node:assert/strict"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { defaultCheckCatalog, mechanicsChecksWith } from "../src/mechanics/checks.ts"
import { solveChassis } from "../src/mechanics/solve.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"

// The rover's board without its mechanics: what the mechanics engineer starts from.
const rover = (): ContractSnapshot => {
	const values = JSON.parse(JSON.stringify(ROVER_BOARD))
	delete values.mechanics
	return { revision: 5, versions: {} as never, values }
}
const cat = defaultCheckCatalog()!
const pick = { motor: "POLOLU-2367", wheel: "POLOLU-1430", caster: "TENTE", pack: "ADAFRUIT-2011", sensor: "ADAFRUIT-3317", connector: "JT1" }

test("for catalog parts the solver returns a mechanics field that passes every chassis check, within the brief's size", () => {
	const r = solveChassis(rover(), { ...pick, caster: "TENTE 1430POI038P60-46x38 swivel caster 38 mm" }, cat)
	assert.ok(r.mechanics, r.why)
	assert.deepEqual(r.remaining, [], r.why)
	const c = rover()
	c.values.mechanics = r.mechanics!
	const left = mechanicsChecksWith(c, cat).filter((v) => v.kind !== "mech-wiring")
	assert.deepEqual(left, [], "the run's own checks agree")
	const [maxL, maxW] = c.values.motion!.maxSizeMm
	assert.ok(r.mechanics!.chassis.plateMm[0] <= maxL && r.mechanics!.drive.trackMm + 10 <= maxW)
	assert.deepEqual(r.mechanics!.chassis.boards.map((b) => b.name), ["main"], "the board itself is 'main', as the checks name it")
	assert.equal(r.mechanics!.sensor.connector, "JT1")
})

test("part numbers alone are enough; an unknown part is named", () => {
	assert.equal(solveChassis(rover(), pick, cat).remaining.length, 0)
	const bad = solveChassis(rover(), { ...pick, wheel: "NOPE-1" }, cat)
	assert.equal(bad.mechanics, null)
	assert.match(bad.why, /wheel NOPE-1 not in catalog/)
})

test("parts that can't make a level chassis: the solver says which check fails and to pick others", () => {
	// A 1-inch caster under 80 mm wheels: the plate can't sit level on both.
	const r = solveChassis(rover(), { ...pick, caster: "IFUTURETECH" }, cat, { budget: 3000 })
	assert.ok(r.remaining.length > 0)
	assert.match(r.why, /no layout passes with these parts.*isn't level.*try other parts/)
})

test("a robot in a system keeps the system's plate and board positions", () => {
	const c = rover()
	c.values.assembly = { body: "chassis", plate: { lengthMm: 156, widthMm: 110 }, boards: [{ name: "main", xMm: 0, yMm: 0, rotDeg: 0, outline: { widthMm: 42, heightMm: 29 }, outlineSource: "built" }, { name: "climate", xMm: 48, yMm: 0, rotDeg: 0, outline: { widthMm: 36, heightMm: 26 }, outlineSource: "built" }], self: "main" } as never
	const r = solveChassis(c, pick, cat)
	assert.deepEqual(r.mechanics?.chassis.plateMm, [156, 110])
	assert.deepEqual(r.mechanics?.chassis.boards.find((b) => b.name === "climate")?.at, { xMm: 48, yMm: 0 })
})
