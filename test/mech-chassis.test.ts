// The chassis builder's TypeScript side (src/tools/chassis.ts): the spec it writes from the contract, and a chassis
// that can't be built failing with the generator's reason.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildChassis, chassisSpec } from "../src/tools/chassis.ts"
import { chassisNotNeeded } from "../src/agents/builders.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { tempDir } from "./helpers.ts"

const ROOT = resolve(import.meta.dirname, "..")
const python = join(ROOT, ".venv/bin/python")
const rover = (): ContractSnapshot => ({ revision: 3, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })

test("the chassis spec carries the plate, both motors, the caster's holes, the battery, the board and the sensor", () => {
	const spec = chassisSpec(rover())!
	assert.deepEqual([spec.plate.lengthMm, spec.plate.widthMm, spec.plate.clearanceMm], [150, 96, 50.5])
	assert.deepEqual(spec.motors.map((m) => m.side), ["left", "right"])
	assert.equal(spec.caster.holesMm.length, 4)
	assert.deepEqual(spec.boards.map((b) => [b.name, b.widthMm, b.heightMm]), [["main", 60, 40]])
	assert.equal(spec.sensor.xMm, 73.6)
	assert.equal(spec.edgeMm, 3, "the simulated course's step is the brief's edge")
	assert.ok(spec.motors.every((m) => m.axleDropMm === 10.5), "the brackets drop to the 40 mm axle")
	assert.ok(spec.massG > 100 && spec.com.length === 3, "mass and centre of mass for the simulation")
})

test("no mechanics, no chassis spec", () => {
	const s = rover()
	delete (s.values as Record<string, unknown>).mechanics
	assert.equal(chassisSpec(s), null)
})

test("a chassis that can't be built fails with the generator's reason", { skip: existsSync(python) ? false : "needs .venv with build123d", timeout: 120_000 }, async () => {
	const s = rover()
	s.values.mechanics!.chassis.plateMm = [50, 30]
	const r = await buildChassis(python, ROOT, tempDir(), s, 3)
	assert.equal(r.ok, false)
	assert.match(r.ok ? "" : r.reason, /board main .* doesn't fit/)
})

// Final review: py/mech/model.py hardcoded the old 60 mm wheel and 25 mm caster masses, so the simulated weight split
// differed from the checks'. The spec carries the real ones.
test("the chassis spec carries the wheel and caster masses the simulation splits the weight with", () => {
	const spec = chassisSpec(rover())!
	const cat = JSON.parse(readFileSync("catalog/mechanics.json", "utf8"))
	const mech = rover().values.mechanics!
	assert.equal(spec.wheelMassG, cat.wheels.find((w: { mpn: string }) => w.mpn === mech.drive.wheel).massG)
	assert.equal(spec.casterMassG, cat.casters.find((c: { mpn: string }) => c.mpn === mech.drive.caster).massG)
})

// Final review: mechanics without motion targets would have the chassis and drive wait for motion forever.
test("mechanics without motion targets: no chassis or drive is needed (the run isn't held)", () => {
	const s = rover()
	assert.equal(chassisNotNeeded(s), null)
	delete (s.values as Record<string, unknown>).motion
	assert.match(chassisNotNeeded(s) ?? "", /no motion targets/)
})

// pending-fixes, 11 Nov: every board on the chassis got the main board's outline (and its holes), whatever its size.
test("each board on the chassis gets its own outline; one whose outline isn't known is left off, and named", () => {
	const s = rover()
	const main = { w: s.values.outline!.widthMm, h: s.values.outline!.heightMm }
	s.values.mechanics!.chassis.boards = [...s.values.mechanics!.chassis.boards, { name: "lamp", at: { xMm: -30, yMm: 0 }, rotDeg: 0 }]
	const known = chassisSpec(s, [{ name: "lamp", outline: { widthMm: 20, heightMm: 15 } }])!
	assert.deepEqual(known.boards.map((b) => [b.name, b.widthMm, b.heightMm]), [["main", main.w, main.h], ["lamp", 20, 15]])
	assert.deepEqual(known.unplaced, [])
	const unknown = chassisSpec(s)!
	assert.deepEqual(unknown.boards.map((b) => b.name), ["main"])
	assert.deepEqual(unknown.unplaced, ["lamp"])
})

// The board and the chassis disagreed on how a board mounts (15 Nov 2026): the board has M2 holes 3.0 mm in from its
// corners (circuit.ts MOUNTING_HOLE), the chassis cut M2.5 standoff holes 3.5 mm in: 0.5 mm off on each axis, and an
// M2.5 screw doesn't pass the board's 2.2 mm hole. The chassis now takes each board's own holes and the case's screw
// (an M2 self-tapping screw into a 1.6 mm pilot hole, case.ts STANDOFF).
test("the chassis puts a standoff under each of the board's own mounting holes, sized for the board's screw", async () => {
	const { mountingHoles } = await import("../src/codegen/circuit.ts")
	const { STANDOFF } = await import("../src/contract/case.ts")
	const s = rover()
	const spec = chassisSpec(s)!
	const main = spec.boards.find((b) => b.name === "main")!
	const own = mountingHoles(s).map((h) => [+(main.xMm + h.x).toFixed(3), +(main.yMm + h.y).toFixed(3)])
	assert.ok(own.length > 0)
	assert.deepEqual(main.holes.map((h) => [h.xMm, h.yMm]), own)
	assert.equal(spec.boardScrew.pilotMm, STANDOFF.pilotMm)
	assert.equal(spec.boardScrew.boardHoleMm, 2.2)
})

test("a board turned on the plate has its holes turned with it", async () => {
	const { mountingHoles } = await import("../src/codegen/circuit.ts")
	const s = rover()
	s.values.mechanics!.chassis.boards[0].rotDeg = 90
	const main = chassisSpec(s)!.boards[0]
	// Counter-clockwise: a hole at (x, y) from the board's centre goes to (-y, x).
	const own = mountingHoles(s).map((h) => [+(main.xMm - h.y).toFixed(3), +(main.yMm + h.x).toFixed(3)])
	assert.deepEqual(main.holes.map((h) => [h.xMm, h.yMm]), own)
})

// The check: every hole of a board on the chassis has a standoff under it in the built chassis (its mounts.json,
// measured back from the solid), and every standoff has a board hole over it.
test("a built chassis whose standoffs miss the board's holes is a violation", async () => {
	const { boardMountChecks } = await import("../src/tools/chassis.ts")
	const s = rover()
	const holes = chassisSpec(s)!.boards[0].holes
	assert.deepEqual(boardMountChecks(s, { standoffHoles: holes, casterHoles: [] }), [])
	// The old chassis: standoffs 3.5 mm in, the board's holes 3.0 mm in.
	const old = holes.map((h) => ({ xMm: h.xMm - Math.sign(h.xMm) * 0.5, yMm: h.yMm - Math.sign(h.yMm) * 0.5 }))
	const v = boardMountChecks(s, { standoffHoles: old, casterHoles: [] })
	assert.equal(v.length, 1)
	assert.equal(v[0].kind, "board-mount-mismatch")
	assert.match(v[0].message, /main's hole at \(-27, -17\) has no standoff under it/)
	assert.deepEqual(v[0].affects, ["mechanics"])
})

test("the consistency check reports a chassis whose standoffs miss the board, and not a stub chassis", async () => {
	const { checkConsistency } = await import("../src/contract/consistency.ts")
	const s = rover()
	const holes = chassisSpec(s)!.boards[0].holes
	const off = holes.map((h) => ({ xMm: h.xMm + 0.5, yMm: h.yMm }))
	const chassis = (mounts: unknown, stub = false) => ({ chassis: { ok: true, revision: 3, dir: "", files: [], mounts, ...(stub ? { stub } : {}) } }) as never
	assert.ok(checkConsistency(s, chassis({ standoffHoles: off })).some((v) => v.kind === "board-mount-mismatch"))
	assert.ok(!checkConsistency(s, chassis({ standoffHoles: holes })).some((v) => v.kind === "board-mount-mismatch"))
	assert.ok(!checkConsistency(s, chassis(null, true)).some((v) => v.kind === "board-mount-mismatch"))
})

// The scripted rover (d9610c's e2e-rover2 run, 15 Nov 2026): at revision 11 the architect moved every connector, so a
// different corner of the 43×28 mm board lost its mounting hole (a connector covers it), but the chassis wasn't rebuilt
// (its inputs were mechanics, motion and outline) and board-mount-mismatch flagged the stale one. The chassis follows
// what the board's holes come from: the connectors, and the parts that give their footprints.
test("the scripted rover's chassis follows its board's holes: rebuilt when the connectors move, and then it matches", async () => {
	const { BUILD_INPUTS } = await import("../src/agents/builders.ts")
	assert.ok(BUILD_INPUTS.chassis.includes("connectors") && BUILD_INPUTS.chassis.includes("parts"), BUILD_INPUTS.chassis.join(", "))
	const { boardMountChecks } = await import("../src/tools/chassis.ts")
	const fx = (f: string) => JSON.parse(readFileSync(join(ROOT, "test/fixtures", f), "utf8"))
	const built10 = fx("e2e-rover2-chassis-rev10-mounts.json")
	// The chassis built for revision 10 matches revision 10's board, and not revision 11's.
	assert.deepEqual(boardMountChecks(fx("e2e-rover2-rev10.json"), built10), [])
	assert.match(boardMountChecks(fx("e2e-rover2-rev11.json"), built10)[0]?.message ?? "", /main's hole at \(18\.5, 11\) has no standoff under it/)
	// Its spec for revision 11 has revision 11's holes.
	const { mountingHoles } = await import("../src/codegen/circuit.ts")
	const s11 = fx("e2e-rover2-rev11.json")
	const main = chassisSpec(s11)!.boards[0]
	assert.deepEqual(main.holes.map((h) => [h.xMm, h.yMm]), mountingHoles(s11).map((h) => [main.xMm + h.x, main.yMm + h.y]))
})

// How each motor is held (16 Nov 2026, agreed with bringup-lead): Pololu's #989 bracket when the motor is a micro metal
// gearmotor and the axle sits its measured 5.0 mm under the plate; else the printed cradle with a printed clamp on two M2
// screws, when the cradle (its 2 mm wall above the motor) reaches that drop; else a check says nothing holds it there.
// The plate height is never changed for it. Before, the cradle silently held every 5.0 mm design at 7.0 mm.
test("each motor is held: a bought bracket at its own height, else a printed clamp, else a check says so", async () => {
	const { readFileSync } = await import("node:fs")
	const { motorMount, CRADLE_WALL_MM } = await import("../src/tools/chassis.ts")
	const { robotPartLines, robotPartNotes, hardwareFit } = await import("../src/tools/robot-parts.ts")
	const { loadMechCatalog } = await import("../src/mechanics/catalog.ts")
	const cat = loadMechCatalog(new URL("..", import.meta.url).pathname)
	const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8")) as ContractSnapshot
	// A real subscription rover: 5.0 mm drop, a POLOLU micro metal gearmotor: brackets, holes 18 mm apart across the motor.
	const real = fx("cc-rover-64x25-rev19.json")
	const rs = chassisSpec(real)!
	assert.ok(rs.motors.every((m) => m.mount.kind === "bracket"), JSON.stringify(rs.motors.map((m) => m.mount)))
	for (const m of rs.motors) if (m.mount.kind === "bracket") assert.equal(Math.abs(m.mount.holes[1].xMm - m.mount.holes[0].xMm), 18)
	const by = (s: ContractSnapshot, item: string) => robotPartLines(s).find((l) => l.item === item)
	assert.equal(by(real, "motor bracket")?.qty, 2)
	assert.equal(by(real, "motor bracket")?.packs, 1)
	assert.ok(!robotPartNotes(real).some((n) => /motors/.test(n)))
	// The scripted rover: 10.5 mm drop: the cradle and a clamp, two M2 self-tapping screws per motor.
	const scripted = fx("e2e-rover2-rev11.json")
	const ss = chassisSpec(scripted)!
	assert.ok(ss.motors.every((m) => m.mount.kind === "clamp"))
	assert.equal(by(scripted, "clamp screw")?.qty, 4)
	assert.match(by(scripted, "clamp screw")!.mpn, /^M2x8 self-tapping/)
	// A motor no bracket fits, 5 mm under the plate: the cradle can't reach it (it needs 5 + 2), and the check says so.
	const odd = motorMount({ xMm: 0, yMm: 30, bodyMm: [26, 12, 10], axleDropMm: 5 }, "OTHER-MOTOR", cat.motorMounts ?? [], 1.6)
	assert.deepEqual(odd, { kind: "cradle-too-shallow", needMm: 5 + CRADLE_WALL_MM })
	const shallow = structuredClone(scripted)
	shallow.values.mechanics!.chassis.clearanceMm -= 4.5 // the axle 6 mm under the plate: under the cradle's 7, not the bracket's 5
	assert.ok(hardwareFit(shallow).some((m) => /printed cradle needs 7 mm/.test(m)), hardwareFit(shallow).join("\n"))
})
