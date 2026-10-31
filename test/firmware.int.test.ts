import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkConsistency } from "../src/contract/consistency.ts"
import { buildFirmware } from "../src/tools/firmware.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const pio = [join(root, ".venv/bin/pio")].find(existsSync)
const skip = pio ? false : "pio not found"

test("fixture firmware builds and its pins match the contract", { skip, timeout: 600_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-"))
	try {
		const firmware = await buildFirmware(pio!, root, dir, fixtureContract(), 6)
		assert.equal(firmware.ok, true, firmware.log)
		assert.equal(firmware.revision, 6)
		assert.equal(firmware.pins.I2C_SDA, 8)
		assert.deepEqual(checkConsistency(fixtureContract(), { firmware }), [])
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test("a pin on a non-existent GPIO fails the build instead of throwing", { skip, timeout: 600_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-"))
	try {
		const c = fixtureContract()
		c.values.pins![0].gpio = 99
		const firmware = await buildFirmware(pio!, root, dir, c, 7)
		assert.equal(firmware.ok, false)
		assert.equal(firmware.pins.I2C_SDA, 99)
		assert.ok(firmware.log.length > 0)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

function withStatusLed(gpio: number) {
	const c = fixtureContract()
	c.values.pins!.push({ signal: "STATUS_LED", gpio, partRef: "D1", partPin: "A" })
	return c
}

test("a STATUS_LED pin builds and is reported back", { skip, timeout: 600_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-"))
	try {
		const firmware = await buildFirmware(pio!, root, dir, withStatusLed(10), 6)
		assert.equal(firmware.ok, true, firmware.log)
		assert.equal(firmware.pins.STATUS_LED, 10)
		assert.deepEqual(checkConsistency(withStatusLed(10), { firmware }), [])
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test("a STATUS_LED on a non-existent GPIO fails the static_assert", { skip, timeout: 600_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-"))
	try {
		const firmware = await buildFirmware(pio!, root, dir, withStatusLed(99), 7)
		assert.equal(firmware.ok, false)
		assert.match(firmware.log, /PIN_STATUS_LED is not a GPIO on this chip/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test("an SHTC3 in the parts compiles the SHTC3 driver, and the firmware reports it", { skip, timeout: 600_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-"))
	try {
		const c = fixtureContract()
		c.values.parts = c.values.parts!.map((p) => (p.role === "sensor" ? { ...p, mpn: "SHTC3-TR-2.5KS", lcsc: "C194656", pins: ["VDD", "SCL", "SDA", "VSS"] } : p))
		const firmware = await buildFirmware(pio!, root, dir, c, 9)
		assert.equal(firmware.ok, true, firmware.log)
		assert.equal(firmware.sensor, "SHTC3")
		assert.deepEqual(checkConsistency(c, { firmware }), [])
		const main = readFileSync(join(dir, "src/main.cpp"), "utf8")
		assert.match(main, /0x70/, "the SHTC3's I2C address (datasheet v4 Table 8)")
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

// The product path: wake, read, store the reading, blink, deep-sleep for the contract's period.
test("the product firmware compiles its duty cycle: the period from the contract, deep sleep and the history", { skip, timeout: 600_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-"))
	try {
		const c = fixtureContract()
		c.values.requirements = { ...c.values.requirements!, dutyCycle: { activeMs: 100, periodS: 240, sleepUa: 5 } }
		const firmware = await buildFirmware(pio!, root, dir, c, 9)
		assert.equal(firmware.ok, true, firmware.log)
		assert.match(readFileSync(join(dir, "include/pins.h"), "utf8"), /^#define DUTY_PERIOD_S 240$/m)
		const main = readFileSync(join(dir, "src/main.cpp"), "utf8")
		for (const needle of ["esp_deep_sleep_start", "esp_sleep_enable_timer_wakeup", "LittleFS", "READING_BLINK_MS = 20"]) assert.ok(main.includes(needle), needle)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
