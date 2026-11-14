// The board's assembly field (src/mechanics/assembly.ts): the plate and the boards' places come from the system, and the
// chassis, its spec and its checks read them from there.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mechanicsFactLines } from "../src/mechanics/facts.ts"
import { chassisSpec } from "../src/tools/chassis.ts"
import { mechanicsChecks, mechanicsFigures } from "../src/mechanics/checks.ts"
import { boardAssemblyShapeError, type BoardAssembly } from "../src/mechanics/assembly.ts"
import { DesignContract } from "../src/contract/contract.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const rover = (): ContractSnapshot => ({ revision: 3, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })
const assembly = (): BoardAssembly => ({
	body: "chassis", self: "rover", plate: { lengthMm: 180, widthMm: 120 },
	boards: [
		{ name: "rover", xMm: 10, yMm: 0, rotDeg: 0, outline: { widthMm: 60, heightMm: 40 }, outlineSource: "built" },
		{ name: "front", xMm: 55, yMm: 0, rotDeg: 0, outline: { widthMm: 50, heightMm: 30 }, outlineSource: "built" },
	],
})
const withAsm = (): ContractSnapshot => { const s = rover(); s.values.assembly = assembly(); return s }

test("no assembly: chassisSpec is exactly today's", () => {
	const spec = chassisSpec(rover())!
	assert.deepEqual([spec.plate.lengthMm, spec.plate.widthMm], [150, 110])
	assert.deepEqual(spec.boards.map((b) => [b.name, b.xMm, b.widthMm, b.heightMm]), [["main", 10, 60, 40]])
	assert.deepEqual(spec.unplaced, [])
})

test("the assembly's plate and places win", () => {
	const spec = chassisSpec(withAsm())!
	assert.deepEqual([spec.plate.lengthMm, spec.plate.widthMm], [180, 120])
	assert.deepEqual(spec.boards.map((b) => [b.name, b.xMm, b.widthMm, b.heightMm]), [["main", 10, 60, 40], ["front", 55, 50, 30]])
	assert.deepEqual(spec.unplaced, [])
})

test("an estimated outline still places the board", () => {
	const s = withAsm()
	s.values.assembly!.boards[1].outlineSource = "estimate"
	const spec = chassisSpec(s)!
	assert.deepEqual(spec.boards.map((b) => b.name), ["main", "front"])
	assert.deepEqual(spec.unplaced, [])
})

test("the mechanics agent's own plate is ignored while an assembly is set", () => {
	const s = withAsm()
	s.values.mechanics!.chassis.plateMm = [90, 60]
	const spec = chassisSpec(s)!
	assert.deepEqual([spec.plate.lengthMm, spec.plate.widthMm], [180, 120])
	assert.ok(!mechanicsChecks(s).some((v) => v.kind === "mech-fit" && /plate/.test(v.message) && /90 × 60/.test(v.message)), "no mech-fit finding is about the agent's 90 × 60 plate")
	// Without the assembly the same small plate is the agent's, and the board doesn't fit it.
	const bare = rover()
	bare.values.mechanics!.chassis.plateMm = [50, 30]
	assert.ok(mechanicsChecks(bare).some((v) => /50 × 30 mm plate/.test(v.message)))
})

test("the field's shape is checked", () => {
	assert.equal(boardAssemblyShapeError(assembly()), null)
	const { self: _self, ...noSelf } = assembly()
	assert.notEqual(boardAssemblyShapeError(noSelf), null)
	assert.match(boardAssemblyShapeError({ ...assembly(), self: "nobody" })!, /not one of its boards/)
	const turned = assembly()
	;(turned.boards[0] as { rotDeg: number }).rotDeg = 45
	assert.match(boardAssemblyShapeError(turned)!, /use 0, 90, 180 or 270/)
})

test("only the integrator owns the assembly", () => {
	const c = new DesignContract()
	assert.deepEqual(c.propose({ field: "assembly", value: assembly(), by: "mechanics", baseVersion: 0 }), { status: "not-owner", owner: "integrator" })
})

test("the assembly's other boards are known to the checks, and their mass counts", () => {
	// Front clear of the main board (which ends at x 40) and inside the plate.
	const s = withAsm()
	Object.assign(s.values.assembly!.boards[1], { xMm: 65, outline: { widthMm: 40, heightMm: 30 } })
	assert.ok(!mechanicsChecks(s).some((v) => /front/.test(v.message)), "no finding names the assembly's other board")
	const mass = (c: ContractSnapshot) => Number(/(\d+) g/.exec(mechanicsFigures(c).find((f) => f.check === "Mass")!.value)![1])
	assert.ok(mass(s) > mass(rover()), "front's board is in the mass")
	const grams = (c: ContractSnapshot) => Number(/about (\d+) g/.exec(mechanicsFactLines(c).join("\n"))![1])
	assert.ok(grams(s) > grams(rover()), "and in the facts")
	// The assembly replaces the agent's own board list, so a stray name in it is not read.
	const lost = withAsm()
	lost.values.mechanics!.chassis.boards.push({ name: "ghost", at: { xMm: 0, yMm: 0 }, rotDeg: 0 })
	assert.ok(!mechanicsChecks(lost).some((v) => /ghost/.test(v.message)), "the agent's own list is not read")
})

test("main's own outline is the truth, even when the assembly's copy of self lags", () => {
	const s = withAsm()
	s.values.assembly!.boards[0] = { ...s.values.assembly!.boards[0], outline: { widthMm: 40, heightMm: 30 }, outlineSource: "estimate" }
	const spec = chassisSpec(s)!
	assert.deepEqual(spec.boards.map((b) => [b.name, b.widthMm, b.heightMm]), [["main", 60, 40], ["front", 50, 30]])
})
