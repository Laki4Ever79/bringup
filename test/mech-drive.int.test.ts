// Firmware in the loop, end to end: the scripted rover's real firmware (simulation build) in QEMU drives the MuJoCo
// rover over the course. Needs PlatformIO, QEMU and MuJoCo (.venv); skipped otherwise.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { prepareFirmware } from "../src/tools/firmware.ts"
import { chassisSpec } from "../src/tools/chassis.ts"
import { runDrive } from "../src/tools/drive.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { tempDir } from "./helpers.ts"

const ROOT = resolve(import.meta.dirname, "..")
const pio = join(ROOT, ".venv/bin/pio"), python = join(ROOT, ".venv/bin/python"), qemu = join(ROOT, "tools/qemu/bin/qemu-system-riscv32")
const skip = existsSync(pio) && existsSync(python) && existsSync(qemu) ? false : "needs PlatformIO, QEMU and .venv with MuJoCo"
const rover = (): ContractSnapshot => ({ revision: 5, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })

test("the scripted rover's firmware drives the course: climbs the step, turns away from the wall, keeps driving", { skip, timeout: 1_200_000 }, async () => {
	const s = rover()
	const fw = tempDir()
	await prepareFirmware(ROOT, fw, s)
	// A relative output dir, as `--out out/x` gives: the bridge runs from py/ (the e2e run of 11 Nov lost its spec.json).
	const r = await runDrive({ root: ROOT, python, pio, fwDir: fw, spec: chassisSpec(s)!, outDir: relative(process.cwd(), tempDir()), courseS: 20 }, 5)
	assert.equal(r.result, "pass", JSON.stringify(r, null, 1))
	assert.ok((r.topSpeedMps ?? 0) >= 0.27)
})

// A pull-cord start (match.h): the firmware waits for the cord, which the simulation pulls at its first tick, then
// drives the same course; the 100 s match outlasts it.
test("with a pull-cord start the rover's firmware still drives the course", { skip, timeout: 1_200_000 }, async () => {
	const s = rover()
	s.values.parts!.push({ ref: "JS1", role: "start", mpn: "PZ254V-11-02P", lcsc: "C492401", footprint: "pinrow2", pins: ["START", "GND"] })
	const used = new Set(s.values.pins!.map((p) => p.gpio))
	s.values.pins!.push({ signal: "START", gpio: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((g) => !used.has(g))!, partRef: "JS1", partPin: "START" })
	s.values.mechanics!.safety = { start: { connector: "JS1", cordMm: 600, matchS: 100 } }
	const fw = tempDir()
	assert.match(await prepareFirmware(ROOT, fw, s), /#define MATCH_MS 100000UL/)
	const r = await runDrive({ root: ROOT, python, pio, fwDir: fw, spec: chassisSpec(s)!, outDir: tempDir(), courseS: 20 }, 5)
	assert.equal(r.result, "pass", JSON.stringify(r, null, 1))
})

test("a firmware that never answers on UART1 is \"not run\", not a hang", { skip, timeout: 1_200_000 }, async () => {
	const s = rover()
	const fw = tempDir()
	await prepareFirmware(ROOT, fw, s)
	const r = await runDrive({ root: ROOT, python, pio, fwDir: fw, spec: chassisSpec(s)!, outDir: tempDir(), env: "esp32c3", courseS: 20 }, 5)
	assert.equal(r.result, "not run")
	assert.match(r.reason, /didn't answer within 60 s/)
})

// Under Eurobot's rules (motion.rules) the base stops for the opponent ahead, waits without turning, and drives on when
// it leaves (rover_hold.h): an opponent appears 0.4 m ahead at 1 s and leaves at 4 s. The room's walls still come after.
test("under Eurobot's rules the base stops 150 mm short of the opponent, holds without turning, and drives on when it leaves", { skip, timeout: 1_200_000 }, async () => {
	const { EUROBOT_BOARD } = await import("../src/inference/scripts.ts")
	const s: ContractSnapshot = { revision: 5, versions: {} as never, values: JSON.parse(JSON.stringify(EUROBOT_BOARD)) }
	const fw = tempDir()
	assert.match(await prepareFirmware(ROOT, fw, s), /#define ROVER_HOLD_MM \d+/)
	const spec = { ...chassisSpec(s)!, opponent: { appearS: 1, leaveS: 4, aheadM: 0.4, radiusM: 0.1, gapMm: 150 } }
	const r = await runDrive({ root: ROOT, python, pio, fwDir: fw, spec, outDir: tempDir(), courseS: 30 }, 5)
	const seg = (n: string) => r.segments?.find((x: { name: string }) => x.name === n)
	for (const n of ["stopped for the opponent", "held, didn't turn", "drove on after it left"]) assert.ok(seg(n)?.pass, JSON.stringify(seg(n)))
	assert.equal(r.result, "pass", JSON.stringify(r, null, 1))
})

// Odometry and go-to-point (rover_odo.h): the Eurobot base's firmware, built with a target, drives there on its wheel
// encoders; the physics, not the odometry, judges where its axle's middle ends.
test("with wheel encoders the base drives to a point 500 mm ahead and 300 mm left, within 20 mm, and stops there", { skip, timeout: 1_200_000 }, async () => {
	const { EUROBOT_BOARD } = await import("../src/inference/scripts.ts")
	const s: ContractSnapshot = { revision: 5, versions: {} as never, values: JSON.parse(JSON.stringify(EUROBOT_BOARD)) }
	const fw = tempDir()
	assert.match(await prepareFirmware(ROOT, fw, s), /#define ROVER_MM_PER_COUNT/)
	const spec = { ...chassisSpec(s)!, target: { xMm: 500, yMm: 300, tolMm: 20 } }
	const r = await runDrive({ root: ROOT, python, pio, fwDir: fw, spec, outDir: tempDir(), courseS: 12, buildFlags: "-DROVER_GOTO_X_MM=500.0f -DROVER_GOTO_Y_MM=300.0f" }, 5)
	assert.equal(r.result, "pass", JSON.stringify(r, null, 1))
})

// The brief's words: "within 2 cm after a full lap". A route round a 600 x 400 mm rectangle and back to the start, the
// odometry carried throughout; the physics judges how far from the start the axle's middle ends.
test("with wheel encoders the base laps a 600 x 400 mm rectangle and ends within 20 mm of where it started", { skip, timeout: 1_200_000 }, async () => {
	const { EUROBOT_BOARD } = await import("../src/inference/scripts.ts")
	const s: ContractSnapshot = { revision: 5, versions: {} as never, values: JSON.parse(JSON.stringify(EUROBOT_BOARD)) }
	const fw = tempDir()
	await prepareFirmware(ROOT, fw, s)
	const spec = { ...chassisSpec(s)!, target: { xMm: 0, yMm: 0, tolMm: 20 } }
	const r = await runDrive({ root: ROOT, python, pio, fwDir: fw, spec, outDir: tempDir(), courseS: 40, buildFlags: "-DROVER_GOTO_LAP_W_MM=600.0f -DROVER_GOTO_LAP_H_MM=400.0f" }, 5)
	assert.equal(r.result, "pass", JSON.stringify(r, null, 1))
})
