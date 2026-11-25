// The arm's kinematics and checks (src/arm/kinematics.ts, src/arm/checks.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import { forward, solve, armReachMm } from "../src/arm/kinematics.ts"
import { armChecks, worstTorques } from "../src/arm/checks.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import type { ArmSpec } from "../src/arm/types.ts"
import { ARM, TARGETS } from "./arm-contract.test.ts"

const cat = defaultCheckCatalog()!
const longer = (arm: ArmSpec, l1: number, l2: number): ArmSpec => ({ ...arm, joints: arm.joints.map((j) => (j.name === "shoulder" ? { ...j, linkMm: l1 } : j.name === "elbow" ? { ...j, linkMm: l2 } : j)) })
const kinds = (arm: ArmSpec, t = TARGETS) => armChecks({ arm, armTargets: t }, cat).map((v) => v.kind)

test("forward∘solve round-trips the pick point within 0.5 mm", () => {
	assert.equal(armReachMm(ARM), 280)
	for (const p of [TARGETS.pick, TARGETS.drop, { xMm: 150, yMm: 0, zMm: 0 }]) {
		const q = solve(ARM, p)
		assert.ok(Array.isArray(q), JSON.stringify(q))
		const tip = forward(ARM, q).tip
		assert.ok(Math.hypot(tip.xMm - p.xMm, tip.yMm - p.yMm, tip.zMm - p.zMm) < 0.5, JSON.stringify({ p, tip }))
		// The gripper points straight down: the last link's absolute pitch is -90°.
		assert.ok(Math.abs(q[1] + q[2] + q[3] + 90) < 1e-6)
		assert.equal(q[4], 0)
	}
	// Stretched level: the grip point at the shoulder's height, the reach out.
	const flat = forward(ARM, [0, 0, 0, 0, 0]).tip
	assert.deepEqual([Math.round(flat.xMm), Math.round(flat.zMm)], [280, 60])
})

test("unreachable point gives arm-reach, no NaN", () => {
	const r = solve(ARM, { xMm: 500, yMm: 0, zMm: 0 })
	assert.ok(!Array.isArray(r))
	assert.ok(Number.isFinite(r.shortMm) && r.shortMm > 200, String(r.shortMm))
	assert.match(r.error, /\(500, 0, 0\) is [\d.]+ mm beyond/)
	const v = armChecks({ arm: ARM, armTargets: { ...TARGETS, drop: { xMm: 500, yMm: 0, zMm: 0 } } }, cat)
	const reach = v.find((x) => x.kind === "arm-reach")
	assert.ok(reach && !/NaN/.test(reach.message), JSON.stringify(v))
	assert.match(reach!.message, /the drop point/)
	// A point the gripper can touch but not come down onto from ARM_APPROACH_MM above.
	const edge = armChecks({ arm: ARM, armTargets: { ...TARGETS, drop: { xMm: 220, yMm: 0, zMm: 60 } } }, cat).find((x) => x.kind === "arm-reach")
	assert.match(edge?.message ?? "", /the drop point's approach, 40 mm above it/)
	// A point in reach but outside a joint's limits says which joint.
	const behind = solve(ARM, { xMm: -150, yMm: 0, zMm: 20 })
	assert.ok(!Array.isArray(behind) && behind.shortMm === 0 && /base/.test(behind.error))
})

test("280 mm reach with 100 g: shoulder torque ≈ 0.5 N·m (±20 %)", () => {
	const w = worstTorques(ARM, TARGETS, cat.mech)
	const sh = w.find((x) => x.joint === "shoulder")!
	assert.ok(sh.nm > 0.4 && sh.nm < 0.6, String(sh.nm))
	assert.ok(Math.abs(sh.allowNm - 0.5 * 1.0787) < 0.01, String(sh.allowNm))
	// The elbow carries less than the shoulder; gravity doesn't load the base yaw or the wrist roll stretched level.
	assert.ok(w.find((x) => x.joint === "elbow")!.nm < sh.nm)
	assert.equal(w.find((x) => x.joint === "base-yaw")!.nm, 0)
	assert.equal(w.find((x) => x.joint === "wrist-roll")!.nm, 0)
})

test("300 mm with MG996R at the shoulder → arm-torque naming the 20 kg·cm servo", () => {
	const arm = longer(ARM, 130, 120)
	assert.equal(armReachMm(arm), 300)
	const v = armChecks({ arm, armTargets: { ...TARGETS, reachMm: 300 } }, cat).filter((x) => x.kind === "arm-torque")
	const sh = v.find((x) => /the shoulder joint/.test(x.message))
	assert.ok(sh, JSON.stringify(v))
	assert.match(sh!.message, /DS3218MG/)
	assert.match(sh!.message, /estimate: armLinkG/)
	assert.deepEqual(sh!.affects, ["mechanics"])
	// With the stronger servo at the shoulder, the shoulder passes.
	const fixed = { ...arm, joints: arm.joints.map((j) => (j.name === "shoulder" ? { ...j, servo: "DS3218MG" } : j)) }
	assert.ok(!armChecks({ arm: fixed, armTargets: { ...TARGETS, reachMm: 300 } }, cat).some((x) => /the shoulder joint/.test(x.message)))
	// Beyond every catalog servo: the architect hears it too (the reach or payload must give).
	const heavy = armChecks({ arm, armTargets: { ...TARGETS, reachMm: 300, payloadG: 1500 } }, cat).find((x) => /the shoulder joint/.test(x.message))!
	assert.deepEqual(heavy.affects, ["mechanics", "architect"])
	assert.match(heavy.message, /no catalog servo carries it/)
})

test("small plate with mass hold-down → arm-tipping", () => {
	assert.ok(!kinds(ARM).includes("arm-tipping"), kinds(ARM).join(", "))
	const small: ArmSpec = { ...ARM, base: { ...ARM.base, plateMm: [120, 100], ballastG: 0 } }
	const v = armChecks({ arm: small, armTargets: TARGETS }, cat).find((x) => x.kind === "arm-tipping")
	assert.ok(v)
	assert.match(v!.message, /120 × 100 mm plate/)
})

test("clamps → no arm-tipping", () => {
	const small: ArmSpec = { ...ARM, base: { ...ARM.base, plateMm: [120, 100], ballastG: 0, holdDown: "clamps" } }
	assert.ok(!kinds(small).includes("arm-tipping"))
})

test("280 mm and 100 g on an MG996R shoulder is just over (the spec's estimate); a DS3218MG shoulder passes everything; supply is the power checks'", () => {
	assert.deepEqual(kinds(ARM), ["arm-torque"])
	const strong = { ...ARM, joints: ARM.joints.map((j) => (j.name === "shoulder" ? { ...j, servo: "DS3218MG" } : j)) }
	assert.deepEqual(kinds(strong), [])
	// A rail beyond the servos' rating is the power checks' arm-supply (power-auto.ts), not reported again here, and gives
	// no torque verdict on a servo the rail can't run.
	assert.deepEqual(kinds({ ...strong, railV: 7.4 }), [])
	assert.match(kinds({ ...strong, joints: strong.joints.map((j, i) => (i === 2 ? { ...j, servo: "NOPE-9" } : j)) }).join(), /arm-torque/)
	assert.deepEqual(armChecks({}, cat), [])
})
