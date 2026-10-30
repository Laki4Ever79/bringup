import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkConsistency } from "../src/contract/consistency.ts"
import { buildFirmware } from "../src/tools/firmware.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const pio = [join(root, ".venv/bin/pio"), resolve(root, "../agent-mesh/.venv/bin/pio")].find(existsSync)
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
