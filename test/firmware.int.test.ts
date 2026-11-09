import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkConsistency } from "../src/contract/consistency.ts"
import { buildFirmware } from "../src/tools/firmware.ts"
import { fixtureContract } from "./fixture.ts"
import { MIC_PART, MIC_PINS, WAKE_WORD_MODEL } from "../src/inference/scripts.ts"
import { pathHash, sensorPath } from "../src/contract/sensor-path.ts"

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
		// BLE after each reading, for the rest of the contract's wake (100 ms minus the 30 ms reading), with NimBLE pinned.
		assert.match(readFileSync(join(dir, "include/pins.h"), "utf8"), /^#define BLE_ADVERTISE_MS 70$/m)
		assert.match(readFileSync(join(dir, ".pio/libdeps/esp32c3/NimBLE-Arduino/library.properties"), "utf8"), /^version=2\.5\.2$/m)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test("the firmware compiles with the contract's 180-day history", { skip, timeout: 600_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-"))
	try {
		const c = fixtureContract()
		c.values.requirements = { ...c.values.requirements!, historyDays: 180, dutyCycle: { activeMs: 100, periodS: 300, sleepUa: 5 } }
		const firmware = await buildFirmware(pio!, root, dir, c, 9)
		assert.equal(firmware.ok, true, firmware.log)
		assert.match(readFileSync(join(dir, "include/pins.h"), "utf8"), /^#define HISTORY_DAYS 180$/m)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

// A board with no sensor (briefs/beacon.md): no I2C pins, no sensor part. It wakes, blinks, advertises "no sensor" over
// BLE and sleeps, and never reads or writes the history.
test("a design with no sensor compiles the no-sensor product path: no reading, no history writes", { skip, timeout: 600_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-fw-"))
	try {
		const c = fixtureContract()
		c.values.parts = c.values.parts!.filter((p) => p.role !== "sensor")
		c.values.parts.push({ ref: "SW1", role: "button", mpn: "TS-1187A-B-A-B", lcsc: "C318884", footprint: "pushbutton", pins: ["A", "B"] })
		c.values.pins = [{ signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }, { signal: "BUTTON", gpio: 3, partRef: "SW1", partPin: "A" }]
		// The button reachable through the case, like the beacon's (button-unreachable otherwise).
		c.values.connectors = [...(c.values.connectors ?? []), { ref: "SW1", kind: "button", edge: "top", offsetMm: 25, widthMm: 4, heightMm: 3 }]
		c.values.requirements = { ...c.values.requirements!, dutyCycle: { activeMs: 330, periodS: 60, sleepUa: 10 } }
		const firmware = await buildFirmware(pio!, root, dir, c, 4)
		assert.equal(firmware.ok, true, firmware.log)
		assert.equal(firmware.sensor, null)
		assert.deepEqual(checkConsistency(c, { firmware }), [])
		const bin = readFileSync(join(dir, ".pio/build/esp32c3/firmware.bin")).toString("latin1")
		assert.ok(bin.includes("SENSOR NONE"), "the no-sensor path is compiled in")
		assert.ok(!bin.includes("HISTORY slot"), "no history writes")
		assert.ok(!bin.includes("SENSOR FAIL"), "no sensor reading")
		assert.equal(firmware.pins.BUTTON, 3)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

// model.h sizes a tensor arena in RAM and a weights placeholder in flash, so the build's own figures include the model.
// Measured 5 Nov 2026 on the wake-word design: RAM +23,552 B (the arena exactly), flash +54,396 B (54,272 B of weights
// and the boot line).
test("the model's arena and weights are counted in the firmware's own RAM and flash", { skip, timeout: 900_000 }, async () => {
	const used = (log: string, what: "RAM" | "Flash") => Number(new RegExp(`${what}:.*used (\\d+) bytes`).exec(log)?.[1])
	const sizes = async (withModel: boolean) => {
		const dir = await mkdtemp(join(tmpdir(), "bringup-fw-"))
		try {
			const c = fixtureContract()
			if (withModel) c.values.model = { ...WAKE_WORD_MODEL }
			const firmware = await buildFirmware(pio!, root, dir, c, 6)
			assert.equal(firmware.ok, true, firmware.log)
			assert.match(readFileSync(join(dir, "include/model.h"), "utf8"), withModel ? /MODEL_ARENA_BYTES 23552/ : /MODEL_PRESENT 0/)
			return { ram: used(firmware.log, "RAM"), flash: used(firmware.log, "Flash") }
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}
	const [without, withModel] = [await sizes(false), await sizes(true)]
	assert.ok(Number.isFinite(without.ram) && Number.isFinite(withModel.flash), JSON.stringify({ without, withModel }))
	assert.equal(withModel.ram - without.ram, 23 * 1024, "RAM grows by the arena")
	const flash = withModel.flash - without.flash
	assert.ok(flash >= 53 * 1024 && flash < 53 * 1024 + 1024, `flash grows by the weights (+${flash} B)`)
})

test("with a microphone model, bringup collect-firmware builds the data-collection firmware and records its sensor path", { skip, timeout: 900_000 }, async () => {
	const { main } = await import("../src/main.ts")
	const { mkdir, writeFile } = await import("node:fs/promises")
	const run = await mkdtemp(join(tmpdir(), "bringup-run-"))
	try {
		const c = fixtureContract()
		c.values.model = { ...WAKE_WORD_MODEL }
		c.values.parts = [...c.values.parts!, MIC_PART]
		c.values.pins = [...c.values.pins!, ...MIC_PINS]
		await mkdir(join(run, "firmware"), { recursive: true })
		await writeFile(join(run, "contract.json"), JSON.stringify(c))
		const firmware = await buildFirmware(pio!, root, join(run, "firmware/rev-6"), c, 6)
		assert.equal(firmware.ok, true, firmware.log)
		assert.equal(await main(["collect-firmware", run]), 0)
		const collect = JSON.parse(readFileSync(join(run, "collect.json"), "utf8"))
		assert.deepEqual([collect.ok, collect.revision, collect.pathHash], [true, 6, pathHash(sensorPath(c)!)])
		assert.ok(existsSync(join(run, "firmware/rev-6/.pio/build/esp32c3_collect/firmware.bin")))
		// Without the mic's I2S pins it can't read the microphone, and the build says why.
		c.values.pins = c.values.pins!.filter((p) => p.partRef !== "U5")
		await buildFirmware(pio!, root, join(run, "firmware/rev-7"), c, 7)
		assert.equal(await main(["collect-firmware", run]), 2)
		assert.equal(JSON.parse(readFileSync(join(run, "collect.json"), "utf8")).ok, false)
	} finally {
		await rm(run, { recursive: true, force: true })
	}
})
