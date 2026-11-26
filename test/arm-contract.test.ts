// The arm's contract fields (src/arm/types.ts, src/arm/shape.ts) and the servo catalog (catalog/mechanics.json servos,
// servoAt): the freeze every later arm task builds on.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { armShapeError, armTargetsShapeError } from "../src/arm/shape.ts"
import { ARM_JOINTS, type ArmSpec, type ArmTargets } from "../src/arm/types.ts"
import { servoAt, type MechCatalog, type ServoPart } from "../src/mechanics/catalog.ts"
import { mechanicsChecks } from "../src/mechanics/checks.ts"
import { DesignContract } from "../src/contract/contract.ts"
import { OWNERS, type ContractSnapshot } from "../src/contract/types.ts"
import { hearsRequest } from "../src/agents/roles.ts"
import { ROVER_MECHANICS, ROVER_MOTION } from "../src/inference/scripts.ts"

const cat = JSON.parse(readFileSync(new URL("../catalog/mechanics.json", import.meta.url), "utf8")) as MechCatalog
const servo = (mpn: string) => cat.servos!.find((s) => s.mpn === mpn) as ServoPart

export const ARM: ArmSpec = {
	base: { plateMm: [200, 160], thicknessMm: 5, shoulderZMm: 60, holdDown: "mass", ballastG: 300 },
	joints: [
		{ name: "base-yaw", servo: "MG996R", channel: 0, linkMm: 0, minDeg: -60, maxDeg: 60 },
		{ name: "shoulder", servo: "MG996R", channel: 1, linkMm: 120, minDeg: 0, maxDeg: 120 },
		{ name: "elbow", servo: "MG996R", channel: 2, linkMm: 110, minDeg: -90, maxDeg: 30 },
		{ name: "wrist-pitch", servo: "SG90", channel: 3, linkMm: 20, minDeg: -120, maxDeg: 60 },
		{ name: "wrist-roll", servo: "SG90", channel: 4, linkMm: 30, minDeg: -90, maxDeg: 90 },
	],
	gripper: { servo: "SG90", channel: 5, openMm: 40, fingerMm: 30 },
	railV: 6,
	input: { kind: "dc-brick", volts: 12, amps: 3 },
	boards: [{ name: "main", at: { xMm: -60, yMm: 0 }, rotDeg: 0 }],
}
export const TARGETS: ArmTargets = { reachMm: 280, payloadG: 100, pick: { xMm: 180, yMm: -125, zMm: 20 }, drop: { xMm: 160, yMm: 125, zMm: 60 }, repeats: 5, objectG: 50 }

test("servoAt MG996R at 6 V", () => {
	const r = servoAt(servo("MG996R"), 6)
	assert.ok(!("error" in r))
	assert.ok(Math.abs(r.stallNm - 1.08) < 0.01, `${r.stallNm}`)
	assert.ok(Math.abs(r.stallA - 2.5) < 1e-9)
	assert.ok(Math.abs(r.degPerS - 60 / 0.14) < 1e-6)
	// Between the listed voltages it interpolates; beyond the last listed one it keeps the nearest.
	const mid = servoAt(servo("MG996R"), 5.4)
	assert.ok(!("error" in mid) && mid.stallNm > 0.92 && mid.stallNm < 1.08)
	const hi = servoAt(servo("MG996R"), 7.2)
	assert.ok(!("error" in hi) && Math.abs(hi.stallNm - r.stallNm) < 1e-9)
})

test("servoAt refuses outside minV..maxV", () => {
	const r = servoAt(servo("SG90"), 7.4)
	assert.ok("error" in r)
	assert.match(r.error, /SG90/)
	assert.match(r.error, /4\.8–6 V/)
	assert.ok("error" in servoAt(servo("STS3215 C001 7.4V"), 5))
})

test("arm shape: a valid spec passes, a 4-joint spec fails naming the missing joint", () => {
	assert.equal(armShapeError(ARM), null)
	const four = { ...ARM, joints: ARM.joints.filter((j) => j.name !== "wrist-roll") }
	assert.match(armShapeError(four) ?? "", /no wrist-roll joint/)
	const swapped = { ...ARM, joints: [ARM.joints[1], ARM.joints[0], ...ARM.joints.slice(2)] }
	assert.match(armShapeError(swapped) ?? "", /joints are shoulder, base-yaw/)
	assert.match(armShapeError({ ...ARM, gripper: { ...ARM.gripper, channel: 0 } }) ?? "", /share a channel/)
	assert.match(armShapeError({ ...ARM, joints: ARM.joints.map((j, i) => (i === 2 ? { ...j, minDeg: 10, maxDeg: 0 } : j)) }) ?? "", /joint elbow/)
	assert.equal(armShapeError({ ...ARM, links: [{ name: "shoulder", massG: 30, comMm: [60, 0, 0] }] }), null)
	assert.ok(armShapeError({ ...ARM, links: [{ name: "thumb", massG: 30, comMm: [60, 0, 0] }] }))
})

test("armTargets shape: a negative reach fails", () => {
	assert.equal(armTargetsShapeError(TARGETS), null)
	assert.ok(armTargetsShapeError({ ...TARGETS, reachMm: -280 }))
	assert.ok(armTargetsShapeError({ ...TARGETS, repeats: 0 }))
	assert.ok(armTargetsShapeError({ ...TARGETS, pick: { xMm: 1, yMm: 2 } }))
})

test("the contract takes armTargets from the architect and arm from the mechanics agent, through their shapes", () => {
	assert.equal(OWNERS.armTargets, "architect")
	assert.equal(OWNERS.arm, "mechanics")
	const c = new DesignContract()
	assert.equal(c.propose({ field: "armTargets", value: TARGETS, by: "architect", baseVersion: 0 }).status, "applied")
	assert.equal(c.propose({ field: "arm", value: ARM, by: "mechanics", baseVersion: 0 }).status, "applied")
	assert.equal(c.propose({ field: "arm", value: ARM, by: "architect", baseVersion: 1 }).status, "not-owner")
	assert.equal(c.propose({ field: "arm", value: { ...ARM, joints: ARM.joints.slice(0, 4) }, by: "mechanics", baseVersion: 1 }).status, "invalid")
	// The mechanics agent hears change requests on an arm design ("make the reach 300 mm").
	assert.equal(hearsRequest("mechanics", (f) => f === "armTargets", "make the reach 300 mm"), true)
	assert.equal(hearsRequest("mechanics", () => false, "make the reach 300 mm"), false)
})

test("rover contract: arm checks return []", () => {
	const snap = (values: ContractSnapshot["values"]): ContractSnapshot => ({ revision: 1, values, versions: {} as ContractSnapshot["versions"] })
	const robot = { summary: "a robot arm that picks a cube", peripherals: ["six servos"], batteryLifeDays: null }
	// An arm design moves but has no motion: the rover's "moves but no motion targets" stays out of it.
	// (Its own checks run instead: src/arm/checks.ts; none of the rover's.)
	assert.ok(!mechanicsChecks(snap({ requirements: robot, armTargets: TARGETS, arm: ARM })).some((v) => v.kind.startsWith("mech-")))
	// A rover's checks are unchanged by the arm fields' existence: no motion still fires, motion with mechanics runs them.
	const rover = { summary: "a rover", peripherals: ["two motors"], batteryLifeDays: null }
	assert.equal(mechanicsChecks(snap({ requirements: rover }))[0]?.fields[0], "motion")
	const kinds = mechanicsChecks(snap({ requirements: rover, motion: ROVER_MOTION, mechanics: ROVER_MECHANICS })).map((v) => v.kind)
	assert.ok(!kinds.some((k) => k.startsWith("arm")), kinds.join(", "))
})

test("catalog: every servo value has a source or an estimates entry", () => {
	const servos = cat.servos ?? []
	assert.deepEqual(servos.map((s) => s.mpn), ["SG90", "MG996R", "DS3218MG", "STS3215 C001 7.4V"])
	const keys = ["minV", "maxV", "stallNm", "stallA", "secPer60", "rangeDeg", "massG", "bodyMm", "earsMm", "holesMm", "holeDiaMm", "spline"]
	for (const s of servos) {
		for (const k of [...keys, ...(s.pulseUs ? ["pulseUs"] : [])]) assert.ok(s.source[k]?.url && s.source[k]?.where, `${s.mpn}.${k} has no source`)
		for (const e of s.estimates ?? []) assert.ok(s.source[e], `${s.mpn}: estimate ${e} names no source key`)
		assert.ok(s.minV < s.maxV && s.stallNm.length > 0 && s.stallA.length > 0 && s.secPer60.length > 0, s.mpn)
		for (const list of [s.stallNm, s.stallA, s.secPer60]) assert.ok(list.every((p, i) => i === 0 || p.v > list[i - 1].v), `${s.mpn}: voltages ascend`)
	}
	// The hobby servos' ear holes have no maker's drawing: they are estimates (the plan's rule).
	for (const m of ["SG90", "MG996R"]) assert.ok(servo(m).estimates?.includes("holesMm"), m)
	// A 20 kg·cm-class PWM servo stronger than the MG996R at the 6 V rail, so a failing shoulder has somewhere to go.
	const strong = servoAt(servo("DS3218MG"), 6), mg = servoAt(servo("MG996R"), 6)
	assert.ok(!("error" in strong) && !("error" in mg) && strong.stallNm > 1.8 * mg.stallNm / 1.08)
	assert.equal(ARM_JOINTS.length, 5)
})
