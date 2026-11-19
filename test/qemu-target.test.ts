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

// An ESP32-family chip other than the C3 builds its own firmware (lead, 19 Nov 2026: the S3 profile carried the C3's
// env and Zephyr board, so an S3 board got C3 firmware).
test("the S3 gets its own envs for every purpose, on its own board, and its own Zephyr board", async () => {
	const { readFileSync } = await import("node:fs")
	const { envFor, esp32FamilyEnvs } = await import("../src/mcu/firmware.ts")
	const s3 = loadProfiles().find((p) => p.id === "esp32-s3-mini-1")!
	assert.equal(envFor(s3), "esp32s3")
	assert.equal(s3.firmware.zephyrBoard, "esp32s3_devkitc")
	const ini = readFileSync(new URL("../templates/fw/platformio.ini", import.meta.url), "utf8")
	const out = esp32FamilyEnvs(ini, s3)
	const envs = [...out.matchAll(/^\[env:(\w+)\]/gm)].map((m) => m[1])
	assert.deepEqual(envs.sort(), ["esp32s3", "esp32s3_collect", "esp32s3_infer", "esp32s3_linktest", "esp32s3_linktest_usb", "esp32s3_test"])
	assert.ok(!/board = esp32-c3/.test(out), "no C3 board in the S3's envs")
	assert.equal([...out.matchAll(/^board = esp32-s3-devkitc-1$/gm)].length, envs.length)
	const rover = readFileSync(new URL("../templates/fw-rover/platformio.ini", import.meta.url), "utf8")
	assert.match(rover, /^\[env:esp32s3\]$/m)
	assert.match(rover, /^\[env:esp32s3_sim\]$/m)
})
