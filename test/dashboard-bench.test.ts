import assert from "node:assert/strict"
import { test } from "node:test"
import { attitude, benchState, checkPills, flashSteps, lowPass, TelemetryBuffer } from "../src/dashboard/model.js"
import { tiltMatrix, applyTilt } from "../src/dashboard/scene3d.js"

let seq = 0
const ev = (type: string, payload: object) => ({ seq: seq++, at: "2026-10-31T12:00:00.000Z", type, producerId: "bench", payload })
const connected = (source = "real", meter = true) => ev("bench.connected", { source, ports: { dut: "/dev/ttyACM0", fixture: null, telemetry: null }, meter })
const checks = (failed: string[] = []) =>
	["boot", "imu", "led", "battery"].map((name) => ({ name, pass: !failed.includes(name), detail: `${name} detail` }))

test("bench state: nothing until the bridge connects, then the latest flash, verdict and measurement", () => {
	assert.equal(benchState([]), null)
	const s0 = benchState([connected("replay")])!
	assert.deepEqual([s0.source, s0.meter, s0.flash, s0.verdict, s0.measured], ["replay", true, null, null, null])
	const s = benchState([
		connected(),
		ev("bench.flashing", { revision: 9, stage: "build", pct: 0 }),
		ev("bench.flashing", { revision: 9, stage: "write", pct: 40 }),
	])!
	assert.deepEqual(s.flash, { revision: 9, stage: "write", pct: 40, ok: null, error: null })
	const done = benchState([
		connected(),
		ev("bench.flashing", { revision: 9, stage: "boot", pct: 100 }),
		ev("bench.flashed", { revision: 9, ok: true, ms: 21000 }),
		ev("bench.measured", { revision: 9, averageMa: 0.046 }),
		ev("bench.verdict", { revision: 9, pass: true, source: "real", checks: checks() }),
		ev("bench.flashing", { revision: 11, stage: "build", pct: 0 }),
	])!
	assert.equal(done.flash!.revision, 11, "a new flash replaces the finished one")
	assert.equal(done.flash!.ok, null)
	assert.equal(done.verdict!.revision, 9, "the verdict stays until the new one arrives")
	assert.equal(done.measured!.averageMa, 0.046)
})

test("flash steps: build → connect → write % → boot rev N, done ones ticked, a failure marks its step", () => {
	const at = (stage: string, pct = 0, extra: object = {}) => ({ revision: 9, stage, pct, ok: null, error: null, ...extra })
	assert.deepEqual(flashSteps(at("write", 40)).map((s: any) => [s.key, s.state, s.label]), [
		["build", "done", "build"],
		["connect", "done", "connect"],
		["write", "active", "write 40 %"],
		["boot", "todo", "boot rev 9"],
	])
	assert.deepEqual(flashSteps(at("boot", 100, { ok: true })).map((s: any) => s.state), ["done", "done", "done", "done"])
	const failed = flashSteps(at("write", 30, { ok: false, error: "no serial data", stage: "connect" }))
	assert.deepEqual(failed.map((s: any) => s.state), ["done", "failed", "todo", "todo"])
	assert.equal(flashSteps(at("pins", 0, { ok: false, error: "GPIO4" }))[0].state, "failed", "a refusal before the build fails the first step")
})

test("the Bench pill appears once the bench connects, keyed to the verdict's revision", () => {
	assert.equal(checkPills([]).some((p: any) => p.key === "bench"), false)
	const waiting = checkPills([connected()]).find((p: any) => p.key === "bench")
	assert.equal(waiting.state, "pending")
	const flashing = checkPills([connected(), ev("bench.flashing", { revision: 9, stage: "write", pct: 10 })]).find((p: any) => p.key === "bench")
	assert.equal(flashing.state, "running")
	const failed = checkPills([connected(), ev("bench.verdict", { revision: 9, pass: false, source: "real", checks: checks(["imu"]) })]).find((p: any) => p.key === "bench")
	assert.deepEqual([failed.state, failed.count, failed.revision], ["error", 1, 9])
	assert.ok(failed.items.some((x: string) => x.startsWith("✗ imu")))
	const replay = checkPills([connected("replay"), ev("bench.verdict", { revision: 9, pass: true, source: "replay", checks: checks() })]).find((p: any) => p.key === "bench")
	assert.deepEqual([replay.state, replay.label], ["ok", "Bench · REPLAY"])
})

test("the DRC pill comes from the newest board build's KiCad DRC", () => {
	assert.equal(checkPills([ev("artifact.ready", { kind: "board", revision: 4 })]).some((p: any) => p.key === "drc"), false, "no DRC ran: no pill")
	const drc = { rules: "JLCPCB 2-layer", errors: 6, warnings: 2, unconnected: 0, byType: { clearance: 4, track_width: 2 }, firstError: "Clearance violation (0.08 mm)" }
	const pill = checkPills([ev("artifact.ready", { kind: "board", revision: 4, drc })]).find((p: any) => p.key === "drc")
	assert.deepEqual([pill.state, pill.count, pill.revision, pill.label], ["error", 6, 4, "DRC"])
	assert.ok(pill.items.includes("6 errors · 2 warnings · 0 unconnected (JLCPCB 2-layer)"))
	assert.ok(pill.items.includes("clearance × 4"))
	assert.ok(pill.items.includes("first: Clearance violation (0.08 mm)"))
	const clean = checkPills([ev("artifact.ready", { kind: "board", revision: 4, drc }), ev("artifact.ready", { kind: "board", revision: 5, drc: { ...drc, errors: 0, warnings: 0, byType: {}, firstError: null } })]).find((p: any) => p.key === "drc")
	assert.deepEqual([clean.state, clean.revision], ["ok", 5])
	const unconnected = checkPills([ev("artifact.ready", { kind: "board", revision: 5, drc: { ...drc, errors: 0, unconnected: 3 } })]).find((p: any) => p.key === "drc")
	assert.deepEqual([unconnected.state, unconnected.count], ["error", 3])
})

test("attitude from the accelerometer: flat is level, tipping about x is roll, about y is pitch", () => {
	const flat = attitude(0, 0, 1)
	assert.ok(Math.abs(flat.pitch) < 1e-9 && Math.abs(flat.roll) < 1e-9)
	const rolled = attitude(0, 1, 1)
	assert.ok(Math.abs(rolled.roll - Math.PI / 4) < 1e-9)
	const pitched = attitude(-1, 0, 1)
	assert.ok(Math.abs(pitched.pitch - Math.PI / 4) < 1e-9)
	const smoothed = lowPass({ pitch: 0, roll: 0 }, { pitch: 1, roll: -1 }, 0.25)
	assert.deepEqual(smoothed, { pitch: 0.25, roll: -0.25 })
})

test("the telemetry buffer keeps a 30 s window of current and tilt, and drops the rest", () => {
	const b = new TelemetryBuffer(30_000)
	b.add([{ at: 1000, mA: 6 }, { at: 1010, tilt: 12, ax: 0, ay: 0, az: 1 }])
	b.add([{ at: 40_000, mA: 60 }])
	assert.deepEqual(b.current.map((s: any) => s.at), [40_000])
	assert.deepEqual(b.tilt, [])
	b.add([{ at: 40_010, tilt: 25, ax: 0.1, ay: 0.4, az: 0.9 }])
	assert.deepEqual(b.tilt.map((s: any) => s.tilt), [25])
	assert.equal(b.lastImu!.ay, 0.4)
})

test("tilt rotates the scene about its centre: identity when level, roll turns +y toward +z", () => {
	const level = tiltMatrix(0, 0)
	assert.deepEqual(applyTilt(level, [1, 2, 3], [0, 0, 0]), [1, 2, 3])
	const rolled = applyTilt(tiltMatrix(0, Math.PI / 2), [0, 1, 0], [0, 0, 0])
	assert.ok(Math.abs(rolled[0]) < 1e-9 && Math.abs(rolled[1]) < 1e-9 && Math.abs(rolled[2] - 1) < 1e-9, String(rolled))
	const aroundCentre = applyTilt(tiltMatrix(0, Math.PI / 2), [10, 1, 0], [10, 0, 0])
	assert.ok(Math.abs(aroundCentre[0] - 10) < 1e-9 && Math.abs(aroundCentre[2] - 1) < 1e-9)
})
