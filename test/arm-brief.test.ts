// The arm's brief (briefs/arm.md), its targets read in code (src/mechanics/brief.ts armTargetsFromBrief), and the scripted
// arm the mock agents design from it (src/inference/scripts.ts ARM_SPEC, ARM_BOARD).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { armTargetsFromBrief } from "../src/mechanics/brief.ts"
import { armChecks, worstTorques } from "../src/arm/checks.ts"
import { armShapeError, armTargetsShapeError } from "../src/arm/shape.ts"
import { defaultCheckCatalog, mechanicsChecks } from "../src/mechanics/checks.ts"
import { armPowerChecks, completePowerTree } from "../src/contract/power-auto.ts"
import { withDriverOutputs } from "../src/contract/outputs-auto.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { ARM_BOARD, ARM_SPEC, ARM_SUMMARY, armServoFixes, scriptedDesignFor } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"
import type { ContractSnapshot, Part } from "../src/contract/types.ts"

const brief = (name: string) => readFileSync(new URL(`../briefs/${name}`, import.meta.url), "utf8")
const cat = defaultCheckCatalog()!
const ARM_BRIEF = brief("arm.md")

test("armTargetsFromBrief reads reach 280, payload 100, pick-to-drop 250 mm", () => {
	const t = armTargetsFromBrief(ARM_BRIEF)
	assert.ok(t)
	assert.equal(armTargetsShapeError(t), null)
	assert.equal(t.reachMm, 280)
	assert.equal(t.payloadG, 100)
	assert.equal(t.objectG, 50)
	assert.equal(t.repeats, 5)
	// The cup 250 mm from the pick point, measured on the table; both on the table in front of the arm.
	assert.equal(Math.hypot(t.drop.xMm - t.pick.xMm, t.drop.yMm - t.pick.yMm), 250)
	assert.ok(t.pick.xMm > 0 && t.drop.xMm > 0)
	// The pick at the 30 mm cube's middle; the drop clears the 40 mm cup's rim with the cube under the gripper.
	assert.equal(t.pick.zMm, 15)
	assert.ok(t.drop.zMm - 15 > 40, String(t.drop.zMm))
	// Both reachable by the arm's checks (with the 40 mm approach), on the scripted arm.
	assert.ok(!armChecks({ arm: ARM_SPEC, armTargets: t }, cat).some((v) => v.kind === "arm-reach"))
	// The brief's own numbers drive it: a 300 mm reach moves the points out with it.
	const longer = armTargetsFromBrief(ARM_BRIEF.replace("Reach about 280 mm", "Reach about 300 mm"))!
	assert.equal(longer.reachMm, 300)
	assert.ok(longer.pick.xMm > t.pick.xMm)
})

test("eurobot brief → null", () => {
	assert.equal(armTargetsFromBrief(brief("eurobot-base.md")), null)
	// No other brief is an arm's.
	for (const f of readdirSync(new URL("../briefs/", import.meta.url)).filter((f) => f.endsWith(".md") && f !== "arm.md")) assert.equal(armTargetsFromBrief(brief(f)), null, f)
	// An arm named without a reach is no arm brief the code can read.
	assert.equal(armTargetsFromBrief("# Brief: desktop robot arm\nIt picks things up."), null)
})

test("the scripted arm: the brief's servos, the shoulder fails torque at 280 mm and the check names the servo the mock then takes", () => {
	assert.equal(armShapeError(ARM_SPEC), null)
	const t = armTargetsFromBrief(ARM_BRIEF)!
	// The brief's servos as it names them.
	assert.deepEqual(ARM_SPEC.joints.map((j) => j.servo), ["MG996R", "MG996R", "MG996R", "SG90", "SG90"])
	assert.equal(ARM_SPEC.gripper.servo, "SG90")
	assert.equal(ARM_SPEC.input.volts, 20)
	assert.equal(ARM_SPEC.input.tolerancePct, 5)
	assert.ok(ARM_SPEC.input.volts * ARM_SPEC.input.amps >= 119.9)
	const v = armChecks({ arm: ARM_SPEC, armTargets: t }, cat)
	const message = v.map((x) => `- ${x.kind}: ${x.message}`).join("\n")
	const fixes = armServoFixes(message)
	assert.deepEqual(fixes, [{ joint: "shoulder", servo: "DS3218MG" }], message)
	const fixed = { ...ARM_SPEC, joints: ARM_SPEC.joints.map((j) => (j.name === "shoulder" ? { ...j, servo: "DS3218MG" } : j)) }
	assert.deepEqual(armChecks({ arm: fixed, armTargets: t }, cat), [])
	assert.ok(worstTorques(fixed, t, cat.mech).every((w) => w.nm <= w.allowNm))
})

test("armTargets with no arm yet wake the mechanics engineer", () => {
	const c = fixtureContract()
	const s: ContractSnapshot = { ...c, values: { ...c.values, armTargets: armTargetsFromBrief(ARM_BRIEF)! } }
	const v = mechanicsChecks(s)
	assert.equal(v.length, 1)
	assert.equal(v[0].kind, "arm-reach")
	assert.deepEqual(v[0].affects, ["mechanics"])
	assert.match(v[0].message, /no arm design yet/)
})

test("the scripted arm's board: the S3 and the PCA9685; the parts tools add six plugs, three 6 V rails and the 20 V jack, and the brick passes", () => {
	assert.equal(scriptedDesignFor(ARM_BRIEF), ARM_BOARD as never)
	assert.ok(ARM_SUMMARY.test(ARM_BOARD.requirements.summary))
	// No word that makes the design a rover (src/mechanics/checks.ts saysRobot; the mock's isRover reads "motors").
	assert.doesNotMatch(ARM_BOARD.requirements.summary, /\b(motors?|wheels?|rover|robot)\b/i)
	assert.equal(ARM_BOARD.parts.find((p) => p.role === "mcu")?.mpn, "ESP32-S3-MINI-1")
	const catalog = loadCatalog(new URL("..", import.meta.url).pathname) as never
	const o = withDriverOutputs(ARM_BOARD.parts as Part[], catalog, null, ARM_SPEC)
	const c = fixtureContract()
	const t = completePowerTree(o.parts, undefined, { ...c, values: { ...c.values, arm: ARM_SPEC, parts: o.parts } })
	const parts = t.parts
	assert.equal(parts.filter((p) => p.role === "servo").length, 6)
	// Three TPS54560 rails (the rail chip by rule, 26 Nov 2026: rated over the input TVS's 35.5 V clamp; 5 A each).
	assert.equal(parts.filter((p) => p.role === "servo-supply").length, 3)
	assert.ok(parts.some((p) => p.nets?.VIN === "VIN_BRICK" && p.role === "connector"))
	const s: ContractSnapshot = { ...c, values: { ...c.values, arm: ARM_SPEC, armTargets: armTargetsFromBrief(ARM_BRIEF)!, parts } }
	// Every chip on the brick's input is rated over its TVS's clamp (rail chips and logic step-down at 65 V): no finding.
	assert.deepEqual(armPowerChecks(s).map((v) => v.message), [])
})
