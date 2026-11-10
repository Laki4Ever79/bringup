// The rover firmware (templates/fw-rover): the header made from the contract, the template a robot gets, and both
// builds compiling.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { roverHeader } from "../src/mechanics/firmware.ts"
import { prepareFirmware } from "../src/tools/firmware.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { tempDir } from "./helpers.ts"

const ROOT = resolve(import.meta.dirname, "..")
const pio = join(ROOT, ".venv/bin/pio")
const rover = (): ContractSnapshot => ({ revision: 3, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })

test("the rover header puts the contract's motor and I2C pins and the stopping numbers in one place", () => {
	const h = roverHeader(rover())
	assert.match(h, /#define MOT_AIN1 4\n/)
	assert.match(h, /#define MOT_BIN2 7\n/)
	assert.match(h, /#define I2C_SDA 8\n/)
	assert.match(h, /#define ROVER_PERIOD_MS 33\n/)
	assert.match(h, /#define ROVER_RANGE_MM 1200\n/)
	const stop = Number(/#define ROVER_STOP_MM (\d+)/.exec(h)![1])
	assert.ok(stop > 150 && stop < 400, `stop ${stop} mm: the brief's 150 mm plus braking and one period`)
	const cruise = Number(/#define ROVER_CRUISE_DUTY ([\d.]+)f/.exec(h)![1])
	assert.ok(cruise > 0.5 && cruise <= 1, `cruise duty ${cruise}`)
})

// The scripted rover's end-to-end run (11 Nov) stayed unsettled: the firmware checks saw no STATUS_LED and no sensor
// driver in hw_pins.h, though the rover firmware reads the SHT40.
test("the rover header declares what the rover firmware drives and reads, so the firmware checks pass", async () => {
	const { checkConsistency } = await import("../src/contract/consistency.ts")
	const { parsePinsHeader, parseSensorHeader } = await import("../src/codegen/firmware.ts")
	// As in the run: the firmware agent adds the status LED's pin.
	const s = rover()
	s.values.pins = [...(s.values.pins ?? []), { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }]
	const h = roverHeader(s)
	assert.match(h, /#define PIN_STATUS_LED 10\n/)
	assert.match(h, /#define SENSOR_SHT40 1\n/)
	const firmware = { revision: 3, ok: true, pins: parsePinsHeader(h), sensor: parseSensorHeader(h), log: "" }
	const kinds = checkConsistency(s, { firmware } as never).map((v) => v.kind)
	assert.ok(!kinds.includes("pin-mismatch") && !kinds.includes("sensor-mismatch"), kinds.join(", "))
})

test("a payload sensor the rover firmware can't read stays a sensor mismatch", () => {
	const s = rover()
	const u2 = (s.values.parts ?? []).find((p) => p.role === "sensor")!
	u2.mpn = "SHTC3"
	assert.doesNotMatch(roverHeader(s), /SENSOR_/)
})

test("a robot's firmware comes from the rover template with its header", async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, rover())
	assert.ok(existsSync(join(dir, "src/rover.cpp")) && existsSync(join(dir, "SIM.md")))
	assert.match(readFileSync(join(dir, "include/hw_pins.h"), "utf8"), /#define MOT_AIN1 4/)
})

test("the board, the simulation and the bench-motor builds compile", { skip: existsSync(pio) ? false : "needs PlatformIO", timeout: 900_000 }, async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, rover())
	const r = spawnSync(pio, ["run", "-d", dir, "-e", "esp32c3", "-e", "esp32c3_sim", "-e", "bench_motor"], { encoding: "utf8" })
	assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000))
})

test("the control logic's unit test passes on the host", { skip: existsSync(pio) ? false : "needs PlatformIO", timeout: 900_000 }, async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, rover())
	const r = spawnSync(pio, ["test", "-d", dir, "-e", "native"], { encoding: "utf8" })
	assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000))
})
