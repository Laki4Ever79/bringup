// The motor and sensor drivers the firmware is built with, run on the host against simulated chips (templates/drivers):
// the bytes each chip is sent, the waits its datasheet asks for, the CRC, the unit conversions and the motor driver's
// truth table. They run after every firmware build, on the design's own generated header.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { prepareFirmware } from "../src/tools/firmware.ts"
import { driverSet, runDriverTests } from "../src/tools/driver-tests.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { tempDir } from "./helpers.ts"

const ROOT = join(import.meta.dirname, "..")
const rover = (): ContractSnapshot => ({ revision: 3, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })
const logger = (mpn: string): ContractSnapshot => ({
	revision: 2,
	versions: {} as never,
	values: {
		parts: [
			{ ref: "U1", role: "mcu", mpn: "ESP32-C3-MINI-1", lcsc: "C2838502", footprint: "esp32_c3_mini_1", pins: [] },
			{ ref: "U2", role: "sensor", mpn, lcsc: null, footprint: "dfn", pins: [] },
		],
		pins: [
			{ signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" },
			{ signal: "I2C_SCL", gpio: 9, partRef: "U2", partPin: "SCL" },
		],
	} as never,
})

test("a robot's firmware is tested for its motor driver, its distance sensor and its payload sensor", () => {
	assert.deepEqual(driverSet(rover()), ["drv8833", "vl53l0x", "sht40"])
	assert.deepEqual(driverSet(logger("SHTC3")), ["shtc3"])
	assert.deepEqual(driverSet(logger("SHT40-AD1B")), ["sht40"])
})

test("the rover's drivers pass on the host with the rover's own header", async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, rover())
	const r = await runDriverTests(dir, rover())
	assert.equal(r.ok, true, r.log)
	assert.equal(r.failed.length, 0)
	for (const name of ["drv8833 forward", "drv8833 reverse", "drv8833 coast", "vl53l0x out of range", "sht40 crc"]) assert.ok(r.passed.some((p) => p.startsWith(name)), `${name} ran: ${r.passed.join(", ")}`)
})

test("the logger's SHTC3 driver passes on the host", async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, logger("SHTC3"))
	const r = await runDriverTests(dir, logger("SHTC3"))
	assert.equal(r.ok, true, r.log)
	assert.ok(r.passed.some((p) => p.startsWith("shtc3 wakes")), r.passed.join(", "))
})

// The tests are only worth having if a broken driver fails them.
const broken = async (s: ContractSnapshot, file: string, from: string | RegExp, to: string) => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, s)
	const path = join(dir, "include/drivers", file)
	const text = readFileSync(path, "utf8")
	const next = text.replace(from, to)
	assert.notEqual(next, text, `the mutation applies to ${file}`)
	writeFileSync(path, next)
	return runDriverTests(dir, s)
}

test("a driver that ignores the CRC fails", async () => {
	const r = await broken(rover(), "sensirion.h", /if \(crc8\(buf, 2\) != buf\[2\] \|\| crc8\(buf \+ 3, 2\) != buf\[5\]\) return false;/, "")
	assert.equal(r.ok, false)
	assert.ok(r.failed.some((f) => f.name.startsWith("sht40 crc")), JSON.stringify(r.failed))
})

test("a motor driver that drives the wrong input for forward fails", async () => {
	const r = await broken(rover(), "drv8833.h", "duty >= 0 ? level : 0", "duty >= 0 ? 0 : level")
	assert.equal(r.ok, false)
	assert.ok(r.failed.some((f) => f.name.startsWith("drv8833 forward")), JSON.stringify(r.failed))
})

test("an SHT40 read that doesn't wait out the measurement fails", async () => {
	const r = await broken(rover(), "sensirion.h", "delay(SHT4X_MEASURE_MS)", "delay(1)")
	assert.equal(r.ok, false)
	assert.ok(r.failed.some((f) => f.name.startsWith("sht40 waits")), JSON.stringify(r.failed))
})

test("without a host compiler the tests are skipped, not failed", async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, rover())
	const r = await runDriverTests(dir, rover(), { cxx: "/nonexistent/g++" })
	assert.equal(r.ok, null)
	assert.match(r.skipped ?? "", /no host C\+\+ compiler/)
})

test("a firmware whose drivers fail on the host is a violation for the firmware engineer; skipped tests are not", async () => {
	const { checkConsistency } = await import("../src/contract/consistency.ts")
	const s = rover()
	const fw = (driverTests: object) => ({ firmware: { revision: 3, ok: true, pins: {}, sensor: "SHT40", log: "", driverTests } }) as never
	const failed = checkConsistency(s, fw({ ok: false, drivers: ["sht40"], passed: 3, failed: [{ name: "sht40 crc rejects a corrupted reading", message: "accepted" }] })).find((v) => v.kind === "firmware-driver-test-failed")
	assert.ok(failed, "violation raised")
	assert.deepEqual(failed.affects, ["firmware"])
	assert.match(failed.message, /sht40 crc rejects a corrupted reading \(accepted\)/)
	const kinds = checkConsistency(s, fw({ ok: null, drivers: ["sht40"], passed: 0, failed: [], skipped: "no host C++ compiler" })).map((v) => v.kind)
	assert.ok(!kinds.includes("firmware-driver-test-failed"))
})
