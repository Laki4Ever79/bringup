// The board's assembly field (src/mechanics/assembly.ts): the plate and the boards' places come from the system, and the
// chassis, its spec and its checks read them from there.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mechanicsFactLines } from "../src/mechanics/facts.ts"
import { chassisSpec } from "../src/tools/chassis.ts"
import { estimatedOutlineReason } from "../src/agents/builders.ts"
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
	assert.deepEqual([spec.plate.lengthMm, spec.plate.widthMm], [150, 96])
	assert.deepEqual(spec.boards.map((b) => [b.name, b.xMm, b.widthMm, b.heightMm]), [["main", 0, 60, 40]])
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
	// Front clear of the main board (which ends at x 40), inside the plate and behind the sensor's bracket (x 70.2; the
	// 40 mm board at x 65 here ran into it, which the bracket check added 19 Nov 2026 catches).
	const s = withAsm()
	Object.assign(s.values.assembly!.boards[1], { xMm: 55, outline: { widthMm: 28, heightMm: 30 } })
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

test("the drive isn't run while a sibling board's outline is only an estimate", () => {
	const s = withAsm()
	assert.equal(estimatedOutlineReason(s, chassisSpec(s)!), null)
	s.values.assembly!.boards[1].outlineSource = "estimate"
	assert.equal(estimatedOutlineReason(s, chassisSpec(s)!), "board front's outline is an estimate until it is built, so the drive would guess its weight")
	// The board's own entry is its own truth: an estimate there is no reason.
	s.values.assembly!.boards[1].outlineSource = "built"
	s.values.assembly!.boards[0].outlineSource = "estimate"
	assert.equal(estimatedOutlineReason(s, chassisSpec(s)!), null)
})

// A Raspberry Pi 5 behind the rover board with its HAT carrier on top (review C2, I4).
const withPi = (): ContractSnapshot => {
	const s = rover()
	const holes = [{ x: 3.5, y: 3.5, dia: 2.7 }, { x: 61.5, y: 3.5, dia: 2.7 }, { x: 3.5, y: 52.5, dia: 2.7 }, { x: 61.5, y: 52.5, dia: 2.7 }]
	const pi = { name: "brain", xMm: -48, yMm: 0, rotDeg: 0 as const, outline: { widthMm: 85, heightMm: 56 }, outlineSource: "built" as const, holes }
	s.values.assembly = { body: "chassis", self: "rover", plate: { lengthMm: 200, widthMm: 120 }, boards: [{ name: "rover", xMm: 40, yMm: 0, rotDeg: 0, outline: { widthMm: 60, heightMm: 40 }, outlineSource: "built" }, pi, { ...pi, name: "rpi-5-carrier", outlineSource: "estimate", carries: "brain" }] }
	return s
}

test("a bought board and its HAT carrier are not two boards overlapping in the robot board's mechanics checks; the HAT stands on the spacers", async () => {
	const s = withPi()
	const v = mechanicsChecks(s)
	assert.deepEqual(v.filter((x) => /overlap/.test(x.message)).map((x) => x.message), [])
	// Moved apart, they would overlap like any two boards: the rule is about the stacked pair only.
	const { mounts } = await import("../src/mechanics/model.ts")
	const { withAssembly } = await import("../src/mechanics/assembly.ts")
	const { loadMechCatalog } = await import("../src/mechanics/catalog.ts")
	const ms = mounts(withAssembly(s.values)!, [{ name: "brain", outline: { widthMm: 85, heightMm: 56 } }, { name: "rpi-5-carrier", outline: { widthMm: 85, heightMm: 56 } }], loadMechCatalog(process.cwd()))
	const z = (n: string) => ms.find((m) => m.what === `board:${n}`)!.zMm
	assert.ok(Math.abs(z("rpi-5-carrier") - z("brain") - (1.6 + 16)) < 1e-9, "the HAT's board is 16 mm of spacers above the Pi's")
})

test("the chassis puts the Pi's standoffs at its record's holes, and none for the HAT on it (review I4)", () => {
	const spec = chassisSpec(withPi())!
	const brain = spec.boards.find((b) => b.name === "brain")!
	assert.deepEqual(brain.holes.map((h) => [h.xMm, h.yMm]), [[-87, -24.5], [-29, -24.5], [-87, 24.5], [-29, 24.5]], "58 × 49 mm apart, from the lower-left corner at (-90.5, -28)")
	const hat = spec.boards.find((b) => b.name === "rpi-5-carrier")!
	assert.equal(hat.standoffs, false)
	assert.deepEqual(hat.holes, [], "the HAT stands on the Pi's spacers")
	assert.equal(spec.boards.find((b) => b.name === "main")!.holes.length, 4, "a designed board keeps its own standoffs")
})
