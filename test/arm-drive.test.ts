// The arm's firmware-in-the-loop run (src/tools/drive.ts runArmDrive, arm task 8) without the toolchain: the bridge's
// spec from the contract, and a machine QEMU can't run is "not run", carrying the I2C note.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { armContract, INSIDE } from "./arm-fixture.ts"
import { armSimSpec, runArmDrive, ARM_SIM_NOTE } from "../src/tools/drive.ts"
import { ARM_JOINTS } from "../src/arm/types.ts"
import { ARM_GRIP_CLOSED_DEG, ARM_PERIOD_MS } from "../src/arm/firmware.ts"
import { tempDir } from "./helpers.ts"

const ROOT = join(import.meta.dirname, "..")

test("armSimSpec: the brief's drop point is the cup, its repeats are the run; new cubes go where the model put the first", () => {
	const spec = armSimSpec(armContract(), "/x/arm.xml")
	assert.deepEqual(spec.joints, ARM_JOINTS)
	assert.equal(spec.spawn, undefined, "the model rests the cube on the plate at the pick point, below the grip height")
	assert.deepEqual(spec.cup, { xMm: INSIDE.drop.xMm, yMm: INSIDE.drop.yMm }, "the cup's size comes from the model (arm_model.py)")
	assert.equal(spec.repeats, INSIDE.repeats)
	assert.equal(spec.periodMs, ARM_PERIOD_MS)
	assert.equal(spec.gripper.closedDeg, ARM_GRIP_CLOSED_DEG)
	assert.ok(spec.gripper.openDeg > spec.gripper.closedDeg)
})

test("runArmDrive on a machine QEMU has no model of is \"not run\", with the I2C note", async () => {
	const r = await runArmDrive({ root: ROOT, python: "python3", pio: "pio", fwDir: tempDir(), outDir: tempDir(), machine: "nrf52", spec: armSimSpec(armContract(), "/x/arm.xml") }, 3)
	assert.equal(r.result, "not run")
	assert.match(r.reason, /nrf52/)
	assert.equal(r.note, ARM_SIM_NOTE)
	assert.equal(r.revision, 3)
})
