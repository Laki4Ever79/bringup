// The rover firmware (templates/fw-rover): the header made from the contract, the template a robot gets, and both
// builds compiling.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { roverHeader, unassignedRoverPins } from "../src/mechanics/firmware.ts"
import { prepareFirmware } from "../src/tools/firmware.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { defaultCheckCatalog, mechanicsCheckOver, type MechFigure } from "../src/mechanics/checks.ts"
import { byMpn } from "../src/mechanics/catalog.ts"
import { loadedSpeedMps, MIN_CRUISE_DUTY, motorAt } from "../src/mechanics/model.ts"
import { tempDir, slow } from "./helpers.ts"

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
	assert.ok(cruise > 0.3 && cruise <= 1, `cruise duty ${cruise}`)
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

test("the rover firmware reads the SHTC3 too (real rover run 10 picked it); a sensor it has no driver for stays a mismatch", () => {
	const s = rover()
	const u2 = (s.values.parts ?? []).find((p) => p.role === "sensor")!
	u2.mpn = "SHTC3-TR-2.5KS"
	assert.match(roverHeader(s), /#define SENSOR_SHTC3 1/)
	u2.mpn = "BME280"
	assert.doesNotMatch(roverHeader(s), /SENSOR_/)
})

test("a robot's firmware comes from the rover template with its header", async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, rover())
	assert.ok(existsSync(join(dir, "src/rover.cpp")) && existsSync(join(dir, "SIM.md")))
	assert.match(readFileSync(join(dir, "include/hw_pins.h"), "utf8"), /#define MOT_AIN1 4/)
})

// The brief's must-have: the payload readings over Bluetooth LE. The rover broadcasts them as BTHome v2 with the
// logger's encoder (include/bthome.h, checked against the spec by test/bthome.test.ts); the board build advertises.
test("a robot's firmware reports each payload reading over Bluetooth LE (BTHome), with the logger's encoder", async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, rover())
	assert.equal(readFileSync(join(dir, "include/bthome.h"), "utf8"), readFileSync(join(ROOT, "templates/fw/include/bthome.h"), "utf8"))
	assert.match(readFileSync(join(dir, "src/hw.h"), "utf8"), /void hw_report\(bool ok, float temp_c, float rh\)/)
	assert.match(readFileSync(join(dir, "src/main.cpp"), "utf8"), /hw_report\(ok, t, rh\)/)
	const board = readFileSync(join(dir, "src/hw_board.cpp"), "utf8")
	assert.match(board, /bthomeServiceData\(/)
	assert.match(board, /NimBLEDevice::init/)
	assert.match(readFileSync(join(dir, "platformio.ini"), "utf8"), /\[env:esp32c3\][^[]*h2zero\/NimBLE-Arduino@2\.5\.2/)
})

test("the board, the simulation and the bench-motor builds compile", { skip: slow || (existsSync(pio) ? false : "needs PlatformIO"), timeout: 900_000 }, async () => {
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

// Final review: a pin left unassigned (-1) still had the drive build and boot a firmware that drives nothing.
test("the rover pins the contract hasn't assigned yet are named, so the drive waits instead of building", () => {
	assert.deepEqual(unassignedRoverPins(rover()), [])
	const s = rover()
	s.values.pins = (s.values.pins ?? []).filter((p) => p.signal !== "MOT_BIN2")
	assert.deepEqual(unassignedRoverPins(s), ["MOT_BIN2"])
})

// A wheel the catalog doesn't have used to crash the build ("reading 'diameterMm'"); it names the part instead.
test("the rover firmware names a mechanics part the catalog doesn't have", () => {
	const s = rover()
	s.values.mechanics = { ...s.values.mechanics!, drive: { ...s.values.mechanics!.drive, wheel: "NOT-A-WHEEL" } }
	assert.throws(() => roverHeader(s), /rover firmware not built: wheel NOT-A-WHEEL not in catalog\/mechanics\.json/)
	s.values.mechanics = { ...s.values.mechanics!, drive: { ...s.values.mechanics!.drive, wheel: "POLOLU-1430" } }
	assert.match(roverHeader(s), /#define/, "the part number alone is enough")
})

// Real rover run 8 (15 Nov): "firmware drives BUTTON on ?" for pins the rover firmware didn't name; nobody could fix it.
test("the rover header names every contract pin, so the firmware's pin table covers the pin map", async () => {
	const { parsePinsHeader } = await import("../src/codegen/firmware.ts")
	const s = rover()
	s.values.pins = [...s.values.pins!, { signal: "BUTTON", gpio: 3, partRef: "SW1", partPin: "A" }, { signal: "USB_DP", gpio: 19, partRef: "J1", partPin: "DP" }]
	const pins = parsePinsHeader(roverHeader(s))
	for (const p of s.values.pins!) assert.equal(pins[p.signal], p.gpio, p.signal)
})

// The rover-pi run (15 Nov): with the caster's drag gone from the simulation, the 0.8 "under load" derate made the
// rover cruise at 0.42 m/s for a 0.3 m/s target and turn 1.4× too far, into the side wall. The duty now follows the
// motor's own load line (its resistance, the rolling load), so the speed the firmware plans is the speed it gets.
test("the cruise duty puts the target speed on the motor's load line", () => {
	const s = rover()
	const h = roverHeader(s)
	const d = Number(/#define ROVER_CRUISE_DUTY ([\d.]+)f/.exec(h)![1])
	const cat = defaultCheckCatalog()!
	const motor = byMpn(cat.mech.motors, s.values.mechanics!.drive.motor)!, pack = byMpn(cat.mech.batteries, s.values.mechanics!.battery.pack)!
	const wheel = byMpn(cat.mech.wheels, s.values.mechanics!.drive.wheel)!
	// From a full pack (where the simulated drive starts): no load at all is the upper bound, and the rolling load takes
	// only a few per cent, so within 10 % of the target.
	const m = motorAt(motor, pack.fullV)
	const r = wheel.diameterMm / 2000
	const noLoadMps = m.noLoadRadS * d * r
	assert.ok(noLoadMps >= s.values.motion!.speedMps, `${noLoadMps} m/s with no load`)
	assert.ok(noLoadMps <= s.values.motion!.speedMps * 1.1, `${noLoadMps} m/s with no load, target ${s.values.motion!.speedMps}`)
})

// Premerge review (15 Nov): the duty was set at the pack's nominal 3.7 V but the simulation (and a charged rover) starts
// at the full 4.2 V, 1.135× more, so the rover cruised 13 % fast and the timed quarter turn overshot. Set for a full
// pack, the planned speed is what a fresh pack gives, and the most the rover ever goes.
test("the cruise duty is set for a full pack: the planned speed is what a fresh pack gives, never exceeded as it drains", () => {
	const s = rover()
	const d = Number(/#define ROVER_CRUISE_DUTY ([\d.]+)f/.exec(roverHeader(s))![1])
	const cat = defaultCheckCatalog()!
	const mech = s.values.mechanics!
	const motor = byMpn(cat.mech.motors, mech.drive.motor)!, pack = byMpn(cat.mech.batteries, mech.battery.pack)!, wheel = byMpn(cat.mech.wheels, mech.drive.wheel)!
	const massKg = 0.3
	const full = loadedSpeedMps(motor, pack, pack.fullV, d, massKg, wheel.diameterMm / 2000)
	const nominal = loadedSpeedMps(motor, pack, pack.nominalV, d, massKg, wheel.diameterMm / 2000)
	assert.ok(Math.abs(full - s.values.motion!.speedMps) < 0.01, `${full} m/s from a full pack, target ${s.values.motion!.speedMps}`)
	assert.ok(nominal < full, "slower as the pack drains")
})

// Premerge review (15 Nov): a 2S pack on the 50:1 motor needs about 0.2 duty for 0.3 m/s; the firmware raised it to a
// 0.3 floor and the rover ran 1.4× its planned speed. No floor now: the "Cruise duty" check names the gearing instead.
test("a motor geared too fast for the target isn't sped up to a duty floor; the Cruise duty check names it", () => {
	const s = rover()
	s.values.mechanics = { ...s.values.mechanics!, drive: { ...s.values.mechanics!.drive, motor: "POLOLU-2365 50:1 MP 6V" }, battery: { ...s.values.mechanics!.battery, pack: "GENSACE-GEA22002S20X6 2S 2200 mAh 20C LiPo XT60" } }
	const d = Number(/#define ROVER_CRUISE_DUTY ([\d.]+)f/.exec(roverHeader(s))![1])
	assert.ok(d < MIN_CRUISE_DUTY, `cruise ${d}: the duty the speed needs, not a floor`)
	const figures: MechFigure[] = []
	const v = mechanicsCheckOver(s.values.motion, s.values.mechanics, [{ name: "main", snapshot: s }], defaultCheckCatalog()!, figures)
	const fig = figures.find((f) => f.check === "Cruise duty")!
	assert.equal(fig.value, String(Math.round(d * 100) / 100), "the report's figure is the firmware's duty")
	assert.equal(fig.ok, false)
	assert.match(v.find((x) => x.kind === "mech-speed")?.message ?? "", /geared about [\d.]+× too fast/)
})

// Premerge review (15 Nov): the firmware's stop distance braked on floorMu·g, as if every wheel gripped, while the
// caster slides at 0.02 (the simulation) and the Stopping distance check braked on the wheels' share only. One model.
test("the firmware's stop distance brakes on the drive wheels' share of the weight, as the Stopping distance check", async () => {
	const { brakeMm } = await import("../src/mechanics/model.ts")
	const s = rover()
	const h = roverHeader(s)
	const stop = Number(/#define ROVER_STOP_MM (\d+)/.exec(h)![1])
	const figures: MechFigure[] = []
	mechanicsCheckOver(s.values.motion, s.values.mechanics, [{ name: "main", snapshot: s }], defaultCheckCatalog()!, figures)
	// The check's stopping figure is braking plus one sensor period; the firmware's stop is the wall distance plus 1.5× it.
	const checkMm = Number(figures.find((f) => f.check === "Stopping distance")!.value.split(" ")[0])
	assert.ok(Math.abs(stop - (s.values.motion!.stopBeforeWallMm + 1.5 * checkMm)) <= 1.5, `firmware ${stop} mm, check ${checkMm} mm`)
	// And it is longer than braking on every wheel at floorMu·g (the caster barely brakes).
	assert.ok(brakeMm(0.3, 0.5) > brakeMm(0.3, 1) * 1.5)
})
