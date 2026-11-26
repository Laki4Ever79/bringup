// Arm task 8's acceptance, end to end: the fixture arm's real firmware (esp32s3_sim) in QEMU drives the MuJoCo arm
// (py/mech/arm_model.py) through the brief's pick-and-place; every cube must land in the cup. Needs PlatformIO, QEMU for
// the S3, MuJoCo (.venv) and the arm model; skipped otherwise.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { armContract } from "./arm-fixture.ts"
import { prepareFirmware } from "../src/tools/firmware.ts"
import { armSimSpec, runArmDrive } from "../src/tools/drive.ts"
import { tempDir } from "./helpers.ts"

const ROOT = resolve(import.meta.dirname, "..")
const pio = join(ROOT, ".venv/bin/python").replace(/python$/, "pio"), python = join(ROOT, ".venv/bin/python"), qemu = join(ROOT, "tools/qemu/bin/qemu-system-xtensa")
const model = join(ROOT, "py/mech/arm_model.py")
const skip = !existsSync(model) ? "needs py/mech/arm_model.py (the arm's MuJoCo model)" : existsSync(pio) && existsSync(python) && existsSync(qemu) ? false : "needs PlatformIO, QEMU for the S3 and .venv with MuJoCo"

test("arm pick-and-place lands 5/5", { skip, timeout: 1_200_000 }, async () => {
	const s = armContract()
	const fw = tempDir(), out = tempDir()
	await prepareFirmware(ROOT, fw, s)
	// The model from the contract: arm_model.py <contract.json> <arm.xml>.
	const contract = join(out, "contract.json"), mjcf = join(out, "arm.xml")
	writeFileSync(contract, JSON.stringify(s))
	const m = spawnSync(python, ["-B", model, contract, mjcf], { cwd: join(ROOT, "py"), encoding: "utf8", env: { ...process.env, PYTHONPATH: join(ROOT, "py") } })
	assert.equal(m.status, 0, m.stderr)
	const r = await runArmDrive({ root: ROOT, python, pio, fwDir: fw, outDir: out, spec: armSimSpec(s, mjcf), timeoutMs: 900_000 }, 1)
	console.log(`arm acceptance: ${r.result}: ${r.reason}; landed ${r.landed}/${r.attempts}, worst ${r.worstMm} mm, cycles ${r.cycleS?.join(", ")} s (sim ${r.simS} s); ${r.note}`)
	assert.equal(r.result, "pass", JSON.stringify(r, null, 1))
	assert.equal(r.landed, s.values.armTargets!.repeats)
})
