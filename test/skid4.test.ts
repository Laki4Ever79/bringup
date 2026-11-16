// A four-wheel skid-steer rover (mechanics.drive.kind "skid4", briefs/rover-4wd.md): the brief picks it, its layout
// passes every mechanics check, turning in place is checked against the sideways scrub, and the board carries a second
// driver for the rear motors, tied to the first.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { defaultCheckCatalog, mechanicsChecksWith, mechanicsFigures } from "../src/mechanics/checks.ts"
import { FOUR_WD, motionFromBrief, ROVER4_BOARD, ROVER_BOARD, scriptedDesignFor } from "../src/inference/scripts.ts"
import { generatedNets, skidDriverTraces } from "../src/codegen/circuit.ts"
import { mechanicsShapeError } from "../src/mechanics/shape.ts"
import { robotPartLines } from "../src/tools/robot-parts.ts"
import { chassisSpec } from "../src/tools/chassis.ts"

const brief = readFileSync(new URL("../briefs/rover-4wd.md", import.meta.url), "utf8")
const snap = (b: unknown = ROVER4_BOARD) => ({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(b)) })

test("the four-wheel brief gets the skid-steer rover; the indoor rover's doesn't", () => {
	assert.ok(FOUR_WD.test(brief))
	assert.equal(scriptedDesignFor(brief), ROVER4_BOARD)
	assert.equal(motionFromBrief(brief).drive, "skid4")
	assert.ok(!FOUR_WD.test(readFileSync(new URL("../briefs/rover.md", import.meta.url), "utf8")))
	assert.equal(mechanicsShapeError(ROVER4_BOARD.mechanics), null)
})

test("its layout passes every mechanics check, the skid turn included", () => {
	assert.deepEqual(mechanicsChecksWith(snap(), defaultCheckCatalog()!), [])
	const turn = mechanicsFigures(snap()).find((f) => f.check === "Skid turn")
	assert.ok(turn?.ok, JSON.stringify(turn))
	assert.ok(!mechanicsFigures(snap()).some((f) => f.check === "Caster climb"))
})

test("refused: a wheelbase longer than 0.9× the track, and a differential layout for a four-wheel brief", () => {
	const long = snap()
	long.values.mechanics.drive.wheelbaseMm = 160
	assert.ok(mechanicsChecksWith(long, defaultCheckCatalog()!).some((v) => v.kind === "mech-torque" && /turns in place only while its wheelbase is shorter than its track/.test(v.message)))
	const diff = snap()
	diff.values.mechanics = JSON.parse(JSON.stringify(ROVER_BOARD.mechanics))
	assert.ok(mechanicsChecksWith(diff, defaultCheckCatalog()!).some((v) => v.kind === "mech-fit" && /asks for four-wheel drive/.test(v.message)))
})

test("the board drives four motors: the rear driver's inputs on the front one's nets, its outputs to JM3 and JM4", () => {
	const s = snap()
	assert.deepEqual(skidDriverTraces(s).map((t) => `${t.ref}.${t.pin}=${t.net}`).sort(), ["U6.AIN1=MOT_AIN1", "U6.AIN2=MOT_AIN2", "U6.BIN1=MOT_BIN1", "U6.BIN2=MOT_BIN2"])
	const nets = generatedNets(s)
	assert.ok(nets.get("MOTOR_C1")?.includes("U6.AOUT1") && nets.get("MOTOR_C1")?.includes("JM3.1"))
	assert.ok(nets.get("MOTOR_D2")?.includes("U6.BOUT2") && nets.get("MOTOR_D2")?.includes("JM4.2"))
	assert.ok(nets.get("MOTOR_A1")?.includes("JM1.1") && !nets.get("MOTOR_A1")?.includes("JM3.1"))
	const on = new Map<string, number>()
	for (const ends of nets.values()) for (const e of new Set(ends)) on.set(e, (on.get(e) ?? 0) + 1)
	assert.deepEqual([...on].filter(([, n]) => n > 1), [], "no pad on two nets")
	assert.deepEqual(skidDriverTraces(snap(ROVER_BOARD)), [], "a differential rover has no rear driver")
})

test("its parts list has four motors and four wheels and no caster; its chassis spec no caster", () => {
	const lines = robotPartLines(snap(), defaultCheckCatalog()!.mech)
	assert.equal(lines.find((l) => l.item === "motor")?.qty, 4)
	assert.equal(lines.find((l) => l.item === "wheel")?.qty, 4)
	assert.ok(!lines.some((l) => l.item === "caster"))
	const spec = chassisSpec(snap())!
	assert.equal(spec.caster, null)
	assert.equal(spec.motors.length, 4)
	assert.equal(spec.motors.filter((m) => m.rear).length, 2)
})

test("its ROS export: four wheel joints, no caster, both wheels of a side in the controller, the mass the checks have", async () => {
	const { robotUrdf, controllersYaml, bodyOf } = await import("../src/ros/urdf.ts")
	const spec = chassisSpec(snap())!
	const urdf = robotUrdf(spec)
	for (const j of ["left_wheel_joint", "right_wheel_joint", "left_rear_wheel_joint", "right_rear_wheel_joint"]) assert.match(urdf, new RegExp(`<joint name="${j}" type="continuous">`))
	assert.doesNotMatch(urdf, /caster_link/)
	const y = controllersYaml(spec)
	assert.match(y, /left_wheel_names: \["left_wheel_joint", "left_rear_wheel_joint"\]/)
	assert.match(y, /right_wheel_names: \["right_wheel_joint", "right_rear_wheel_joint"\]/)
	const b = bodyOf(spec)
	assert.ok(Math.abs(b.bodyKg + 4 * b.wheelKg - spec.massG / 1000) < 1e-9, "body plus four wheels is the whole")
})
