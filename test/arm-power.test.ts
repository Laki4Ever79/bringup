// The arm's servo power (src/contract/power-auto.ts, arm task 5): servos split across SY8368A rails at the arm's rail
// voltage, the rail divider, the brick and its input jack, and the rover's path left as it was.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ARM } from "./arm-contract.test.ts"
import { fixtureContract } from "./fixture.ts"
import { armInputNet, armPowerChecks, armRails, completePowerTree, railDivider, servoRails, SUPPLY_HEADROOM } from "../src/contract/power-auto.ts"
import { withDriverOutputs } from "../src/contract/outputs-auto.ts"
import { CONNECTOR_HEADROOM, defaultCheckCatalog, SERVO_STALL_A } from "../src/mechanics/checks.ts"
import type { ArmSpec } from "../src/arm/types.ts"
import type { ContractSnapshot, Part } from "../src/contract/types.ts"

const mcuCatalog = () => defaultCheckCatalog()!.boardParts as unknown as (Part & { lcsc: string | null })[]
// The arm's brick (lead decision, 25 Nov 2026): a 19.5 V 90 W laptop brick, under the input TVS's 20 V stand-off (src/arm/inrush.ts).
const ARM24: ArmSpec = { ...ARM, input: { kind: "dc-brick", volts: 19.5, amps: 4.62 } }

// The arm's board before the code adds its power: the S3, its LDO and the PCA9685 (what the parts agent writes).
function armParts(): Part[] {
	const cat = mcuCatalog()
	const one = (ref: string, f: (p: Part) => boolean) => ({ ...cat.find(f)!, ref }) as Part
	return [one("U1", (p) => p.role === "mcu" && /S3/.test(p.mpn)), one("U2", (p) => p.mpn === "AP2112K-3.3TRG1"), one("U6", (p) => p.role === "pwm-driver"), one("J1", (p) => p.role === "usb-c")]
}

// The arm contract with the code's power applied, as contract-tools does on a parts write.
function armContract(arm: ArmSpec): ContractSnapshot {
	const c = fixtureContract()
	const withArm = { ...c, values: { ...c.values, arm, mechanics: undefined, motion: undefined } }
	const o = withDriverOutputs(armParts(), mcuCatalog(), null, arm)
	const t = completePowerTree(o.parts, undefined, withArm)
	return { ...withArm, values: { ...withArm.values, parts: t.parts } }
}

test("six arm servos split into two rails that each fit", () => {
	// 3 x MG996R at 2.5 A and 3 x SG90 at 0.7 A, 6 V: 9.6 A, 12 A with headroom, over one SY8368A's 8 A.
	const servos = [2.5, 2.5, 2.5, 0.7, 0.7, 0.7].map((a, i) => ({ ref: `JV${i + 1}`, stallA: a }))
	const rails = servoRails(servos, 8)
	assert.ok(rails)
	assert.equal(rails.length, 2)
	for (const r of rails) assert.ok(r.needA * SUPPLY_HEADROOM <= 8 + 1e-9, `${r.needA} A`)
	assert.deepEqual(rails.flatMap((r) => r.refs).sort(), servos.map((s) => s.ref).sort())
	// One servo over the chip's rating can't be split: null, which the check reports.
	assert.equal(servoRails([{ ref: "JV1", stallA: 7 }], 8), null)

	const s = armContract(ARM24)
	const ar = armRails(s)!
	assert.deepEqual(ar.map((r) => r.net), ["VSERVO1", "VSERVO2"])
	const supplies = s.values.parts!.filter((p) => p.role === "servo-supply")
	assert.deepEqual(ar.map((r) => r.supplyRef), supplies.map((p) => p.ref))
	assert.ok(supplies.every((p) => p.mpn === "SY8368AQQC"))
	for (const r of ar) assert.ok(r.headroomA <= 8 + 1e-9 && r.railV === 6)
	// Plugs JV1..JV6 in joint order then the gripper, on the arm's channels.
	const plugs = ar.flatMap((r) => r.plugs).sort((a, b) => a.ref.localeCompare(b.ref))
	assert.deepEqual(plugs.map((p) => [p.ref, p.joint, p.channel]), [["JV1", "base-yaw", 0], ["JV2", "shoulder", 1], ["JV3", "elbow", 2], ["JV4", "wrist-pitch", 3], ["JV5", "wrist-roll", 4], ["JV6", "gripper", 5]])
	assert.equal(s.values.parts!.filter((p) => p.role === "servo").length, 6)
	assert.deepEqual(armPowerChecks(s), [])
})

test("rail divider gives 6.0 V ±2 %", () => {
	const d = railDivider(6)
	assert.deepEqual([d.r1, d.r2], ["27k", "3k"])
	assert.ok(Math.abs(d.voutV - 6) / 6 <= 0.02, `${d.voutV}`)
	// 6.8 V has no E24 pair within 2 % (6.6 V or 7.0 V): a violation, not a quiet 6.6 V rail.
	assert.ok(armPowerChecks(armContract({ ...ARM24, joints: ARM24.joints.map((j) => ({ ...j, servo: "MG996R" })), gripper: { ...ARM24.gripper, servo: "MG996R" }, railV: 6.8 })).some((v) => /6\.8 V/.test(v.message) && /divider/.test(v.message)))
	for (const v of [5, 7.4]) assert.ok(Math.abs(railDivider(v).voutV - v) / v <= 0.02, `${v}: ${railDivider(v).voutV}`)
})

test("input connector carries brick amps × 1.25", () => {
	const s = armContract(ARM24)
	const jack = s.values.parts!.find((p) => p.mpn === "DC-091-A250")
	assert.ok(jack, "the brick input jack")
	assert.equal(jack.nets?.VIN, armInputNet)
	// The logic side from the brick input: a step-down to 5 V and its two Schottkys.
	assert.ok(s.values.parts!.some((p) => p.role === "buck"))
	assert.equal(s.values.parts!.filter((p) => p.role === "diode").length, 2)
	// 12 V needs about 7.3 A, × 1.25 = 9.1 A through an 8 A jack: a violation naming the numbers.
	const v12 = armPowerChecks(armContract({ ...ARM, input: { kind: "dc-brick", volts: 12, amps: 8 } }))
	const jackV = v12.find((v) => /DC-091-A250/.test(v.message))
	assert.ok(jackV, JSON.stringify(v12))
	assert.equal(jackV.kind, "arm-supply")
	assert.match(jackV.message, new RegExp(`${CONNECTOR_HEADROOM}`))
	// A brick rated under what the rails draw.
	const small = armPowerChecks(armContract({ ...ARM24, input: { kind: "dc-brick", volts: 19.5, amps: 2 } }))
	assert.ok(small.some((v) => v.kind === "arm-supply" && /brick/.test(v.message) && v.fields.includes("arm")), JSON.stringify(small))
	// A rail voltage outside a servo's range: arm-supply naming the servo, no NaN.
	const hot = armPowerChecks(armContract({ ...ARM24, railV: 7.4 }))
	assert.ok(hot.some((v) => /SG90/.test(v.message) && /4\.8–6 V/.test(v.message)), JSON.stringify(hot))
	assert.ok(!hot.some((v) => /NaN/.test(v.message)))
})

test("rover: SERVO_STALL_A path unchanged", () => {
	const c = fixtureContract()
	const parts = [...armParts()]
	const o = withDriverOutputs(parts, mcuCatalog(), null)
	assert.equal(o.parts.filter((p) => p.role === "servo").length, 2, "JV1 and JV2, as before")
	assert.equal(o.parts.filter((p) => p.role === "servo-supply").length, 1)
	assert.equal(armRails(c), null)
	assert.deepEqual(armPowerChecks(c), [])
	assert.ok(SERVO_STALL_A > 0)
})
