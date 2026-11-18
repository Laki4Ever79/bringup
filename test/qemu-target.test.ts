// Each chip's QEMU (src/tools/qemu.ts): riscv32 for the ESP32-C3, xtensa for the ESP32-S3, picked from the MCU profile.
import { test } from "node:test"
import assert from "node:assert/strict"
import { qemuBaseArgs, qemuTarget } from "../src/tools/qemu.ts"
import { loadProfiles } from "../src/mcu/profile.ts"

test("the C3 and the S3 each get their own binary, machine, esptool chip and simulation build", () => {
	const byId = new Map(loadProfiles().map((p) => [p.id, p]))
	const c3 = qemuTarget(byId.get("esp32-c3-mini-1")!.sim.machine)!
	const s3 = qemuTarget(byId.get("esp32-s3-mini-1")!.sim.machine)!
	assert.deepEqual([c3.bin, c3.machine, c3.chip, c3.simEnv], ["tools/qemu/bin/qemu-system-riscv32", "esp32c3", "esp32c3", "esp32c3_sim"])
	assert.deepEqual([s3.bin, s3.machine, s3.chip, s3.simEnv], ["tools/qemu/bin/qemu-system-xtensa", "esp32s3", "esp32s3", "esp32s3_sim"])
	assert.equal(qemuTarget(undefined)?.machine, "esp32c3", "a design from before profiles is the C3's")
	assert.equal(qemuTarget("stm32g031"), null)
	assert.ok(qemuBaseArgs(s3, "f.bin").includes("driver=timer.esp32s3.timg,property=wdt_disable,value=true"))
})
