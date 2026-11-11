// The firmware template built for a chip other than the ESP32-C3 (docs/mcu.md, Firmware): the fixture's logger on an
// STM32G031K8 compiles under the env its profile generates, with pins.h spelled for STM32duino.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildFirmware } from "../src/tools/firmware.ts"
import { bootFirmware } from "../src/tools/emulator.ts"
import { renodePath } from "../src/tools/renode.ts"
import { chipPartPins } from "../src/mcu/board.ts"
import { profileById } from "../src/mcu/profile.ts"
import { fixtureContract } from "./fixture.ts"

function stmContract() {
	const stm = profileById("stm32g031k8t6")!
	const s = fixtureContract()
	s.values.parts = s.values.parts!.map((p) => (p.role === "mcu" ? { ...p, mpn: "STM32G031K8T6", lcsc: null, footprint: "", pins: chipPartPins(stm) } : p))
	s.values.pins = [
		{ signal: "I2C_SDA", gpio: 23, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 22, partRef: "U2", partPin: "SCL" },
		{ signal: "STATUS_LED", gpio: 5, partRef: "D1", partPin: "A" },
	]
	return s
}

const root = resolve(import.meta.dirname, "..")
const pio = [join(root, ".venv/bin/pio")].find(existsSync)
const skip = pio ? false : "pio not found"

test("the STM32G031K8 logger (SHT40 on PB7/PB6, LED on PA5) builds, its pins read back as the contract's, and it boots in Renode", { skip, timeout: 900_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-stm-"))
	try {
		const firmware = await buildFirmware(pio!, root, dir, stmContract(), 6)
		assert.equal(firmware.ok, true, firmware.log)
		assert.deepEqual({ sda: firmware.pins.I2C_SDA, scl: firmware.pins.I2C_SCL, led: firmware.pins.STATUS_LED }, { sda: 23, scl: 22, led: 5 })
		assert.ok(existsSync(join(dir, ".pio/build/stm32g031k8t6/firmware.elf")))
		assert.match(readFileSync(join(dir, "platformio.ini"), "utf8"), /^default_envs = stm32g031k8t6$/m)
		// No radio code in a chip without a radio.
		assert.doesNotMatch(firmware.log, /NimBLE/)
		// It boots on Renode's STM32G0 and logs on its console UART (USART2): the banner, the sensor's answer (Renode
		// has no SHT40 at 0x44, so FAIL) and the sleep. The same success test QEMU's ESP32-C3 boot uses.
		if (renodePath(root)) {
			const boot = await bootFirmware(root, dir, 120_000, profileById("stm32g031k8t6"))
			assert.equal(boot.backend, "renode")
			assert.equal(boot.booted, true, boot.serial)
			assert.equal(boot.revision, 6)
			assert.match(boot.serial, /SENSOR (OK|FAIL)/)
		}
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
