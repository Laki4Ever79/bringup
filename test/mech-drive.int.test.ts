// Firmware in the loop, end to end: the scripted rover's real firmware (simulation build) in QEMU drives the MuJoCo
// rover over the course. Needs PlatformIO, QEMU and MuJoCo (.venv); skipped otherwise.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { prepareFirmware } from "../src/tools/firmware.ts"
import { chassisSpec } from "../src/tools/chassis.ts"
import { runDrive } from "../src/tools/drive.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { tempDir } from "./helpers.ts"

const ROOT = resolve(import.meta.dirname, "..")
const pio = join(ROOT, ".venv/bin/pio"), python = join(ROOT, ".venv/bin/python"), qemu = join(ROOT, "tools/qemu/bin/qemu-system-riscv32")
const skip = existsSync(pio) && existsSync(python) && existsSync(qemu) ? false : "needs PlatformIO, QEMU and .venv with MuJoCo"
const rover = (): ContractSnapshot => ({ revision: 5, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })

test("the scripted rover's firmware drives the course: climbs the step, turns away from the wall, keeps driving", { skip, timeout: 1_200_000 }, async () => {
	const s = rover()
	const fw = tempDir()
	await prepareFirmware(ROOT, fw, s)
	const r = await runDrive({ root: ROOT, python, pio, fwDir: fw, spec: chassisSpec(s)!, outDir: tempDir(), courseS: 20 }, 5)
	assert.equal(r.result, "pass", JSON.stringify(r, null, 1))
	assert.ok((r.topSpeedMps ?? 0) >= 0.27)
})

test("a firmware that never answers on UART1 is \"not run\", not a hang", { skip, timeout: 1_200_000 }, async () => {
	const s = rover()
	const fw = tempDir()
	await prepareFirmware(ROOT, fw, s)
	const r = await runDrive({ root: ROOT, python, pio, fwDir: fw, spec: chassisSpec(s)!, outDir: tempDir(), env: "esp32c3", courseS: 20 }, 5)
	assert.equal(r.result, "not run")
	assert.match(r.reason, /didn't answer within 10 s/)
})
