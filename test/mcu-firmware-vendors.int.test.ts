// The firmware template built for the RP2040 and the nRF52840 (docs/mcu.md, Firmware): the fixture's logger (SHT40 on
// I2C, a status LED) compiles under the env each profile generates, and its pins read back as the contract's. Neither
// profile has a buildable board yet, so the MCU part carries no pins. The nRF52840 build also boots in Renode when
// tools/renode is there.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildFirmware } from "../src/tools/firmware.ts"
import { renodePath } from "../src/tools/renode.ts"
import { bootFirmware } from "../src/tools/emulator.ts"
import { profileById } from "../src/mcu/profile.ts"
import { fixtureContract } from "./fixture.ts"

function contractFor(mpn: string, pins: { sda: number; scl: number; led: number }) {
	const s = fixtureContract()
	s.values.parts = s.values.parts!.map((p) => (p.role === "mcu" ? { ...p, mpn, lcsc: null, footprint: "", pins: [] } : p))
	s.values.pins = [
		{ signal: "I2C_SDA", gpio: pins.sda, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: pins.scl, partRef: "U2", partPin: "SCL" },
		{ signal: "STATUS_LED", gpio: pins.led, partRef: "D1", partPin: "A" },
	]
	return s
}

const root = resolve(import.meta.dirname, "..")
const pio = [join(root, ".venv/bin/pio")].find(existsSync)
const skip = pio ? false : "pio not found"

test("the RP2040 logger (SHT40 on I2C0 GPIO4/GPIO5, LED on GPIO25) builds with no radio, and its pins read back", { skip, timeout: 900_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-rp-"))
	try {
		const firmware = await buildFirmware(pio!, root, dir, contractFor("RP2040", { sda: 4, scl: 5, led: 25 }), 6)
		assert.equal(firmware.ok, true, firmware.log)
		assert.deepEqual({ sda: firmware.pins.I2C_SDA, scl: firmware.pins.I2C_SCL, led: firmware.pins.STATUS_LED }, { sda: 4, scl: 5, led: 25 })
		assert.equal(firmware.sensor, "SHT40")
		assert.ok(existsSync(join(dir, ".pio/build/rp2040/firmware.elf")))
		const ini = readFileSync(join(dir, "platformio.ini"), "utf8")
		assert.match(ini, /^default_envs = rp2040$/m)
		assert.match(readFileSync(join(dir, "include/pins.h"), "utf8"), /#define BRINGUP_CONSOLE_TX 0\n#define BRINGUP_CONSOLE_RX 1/)
		assert.match(readFileSync(join(dir, "include/connectivity.h"), "utf8"), /RADIO_NONE/)
		assert.match(readFileSync(join(dir, "include/pins.h"), "utf8"), /^#define HISTORY_BYTES 65536\b/m)
		assert.doesNotMatch(firmware.log, /NimBLE|bluefruit/i)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test("the nRF52840 logger (SHT40 on P0.26/P0.27, LED on P0.13) builds with Bluetooth LE on Bluefruit, its pins read back, and it boots in Renode as far as the first I2C transfer", { skip, timeout: 900_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-nrf-"))
	try {
		const profile = profileById("nrf52840-mdbt50q")!
		const firmware = await buildFirmware(pio!, root, dir, contractFor("MDBT50Q-1MV2", { sda: 26, scl: 27, led: 13 }), 6)
		assert.equal(firmware.ok, true, firmware.log)
		assert.deepEqual({ sda: firmware.pins.I2C_SDA, scl: firmware.pins.I2C_SCL, led: firmware.pins.STATUS_LED }, { sda: 26, scl: 27, led: 13 })
		assert.ok(existsSync(join(dir, ".pio/build/nrf52840_mdbt50q/firmware.elf")))
		const ini = readFileSync(join(dir, "platformio.ini"), "utf8")
		assert.match(ini, /^default_envs = nrf52840_mdbt50q$/m)
		assert.match(readFileSync(join(dir, "include/pins.h"), "utf8"), /#define BRINGUP_CONSOLE_TX 6\n#define BRINGUP_CONSOLE_RX 8/)
		assert.match(readFileSync(join(dir, "include/connectivity.h"), "utf8"), /^#define RADIO_BLE 1$/m)
		// The BLE path is in the image: its log line, and Bluefruit's own symbols.
		const elfText = readFileSync(join(dir, ".pio/build/nrf52840_mdbt50q/firmware.elf")).toString("latin1")
		assert.ok(elfText.includes("BLE %s advertising %lu ms"))
		assert.ok(elfText.includes("AdafruitBluefruit"))
		// Renode's nrf52840.repl boots it: it guesses the vector table at 0x26000 (the Adafruit core links the application
		// above the S140 SoftDevice, which the ELF doesn't carry), and the banner comes out of UARTE0 on P0.06. Then the
		// first I2C transfer never ends: the core drives TWIM (EasyDMA, ENABLE = 6), which Renode's twi0 model doesn't
		// implement ("Wrong enabled value"), so the core polls for an event that never comes (on a chip, a missing sensor
		// is an address NACK and an ERROR event). runRenode keeps the console lines whole, so twi0's warning flood can't
		// push the banner out: the ordinary boot path finds it.
		if (renodePath(root)) {
			const boot = await bootFirmware(root, dir, 120_000, profile)
			assert.equal(boot.backend, "renode")
			assert.equal(boot.booted, true, boot.serial.slice(-3000))
			assert.equal(boot.revision, 6)
		}
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
