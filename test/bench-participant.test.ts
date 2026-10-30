import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join as path } from "node:path"
import { createHuman, ModelMessageItem, UserMessageItem, type SemanticEvent } from "@mozaik-ai/core"
import { BringupState, emit, join, startRuntime } from "../src/runtime.ts"
import { createChangeDesk, ownerReviewsChanges } from "../src/change-control.ts"
import { createRoleAgent } from "../src/agents/common.ts"
import { createBench, type Bench } from "../src/agents/bench.ts"
import { pinsHeader } from "../src/codegen/firmware.ts"
import { makeEvent, type Payloads } from "../src/events.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { CORE_FIELDS, type FieldName } from "../src/contract/types.ts"
import { FakeBridge } from "./bench-fake.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

const STATUS_LED = { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }

const approver: Script = (items) => {
	const last = items.at(-1)
	const id = last instanceof UserMessageItem ? /proposalId=([\w-]+)/.exec(last.content.text)?.[1] : undefined
	return id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "measured beats estimated" })] : [ModelMessageItem.rehydrate({ text: "decided" })]
}

let bench: Bench | null = null
afterEach(async () => {
	await bench?.close()
	bench = null
})

function setup(fake: FakeBridge, opts: { pins?: typeof LOGGER_DESIGN.pins; windowMs?: number } = {}) {
	const state = new BringupState(tempDir(), 2000)
	writeFileSync(path(state.outDir, "brief.md"), "BLE logger on a 500 mAh cell, six months.\n")
	startRuntime(state, inferenceConfig(true, { "mock-architect": approver }), null)
	const events = recorder()
	const desk = createChangeDesk()
	join(desk)
	createRoleAgent({ role: "architect", instruction: "owner", handlers: [ownerReviewsChanges("architect")], mock: true })
	const values = { ...LOGGER_DESIGN, pins: opts.pins ?? [...LOGGER_DESIGN.pins, STATUS_LED] }
	for (const f of CORE_FIELDS) {
		const r = state.contract.propose({ field: f, value: values[f as keyof typeof values], by: f === "parts" ? "parts" : "architect", baseVersion: 0 } as never)
		assert.equal(r.status, "applied", f)
	}
	bench = createBench({ bridge: fake, hello: { source: fake.opts.source ?? "real", ports: { dut: "/dev/x", fixture: null, telemetry: null }, meter: fake.opts.meter ?? true }, windowMs: opts.windowMs ?? 40, liveCheckMs: 30, bootTimeoutMs: 400, batchMs: 15 })
	join(bench)
	// A compiled firmware at the current revision, as the firmware builder leaves it.
	const firmware = (revision = state.contract.revision) => {
		const dir = path(state.outDir, "firmware", `rev-${revision}`)
		mkdirSync(path(dir, "include"), { recursive: true })
		writeFileSync(path(dir, "include/pins.h"), pinsHeader({ ...state.contract.snapshot(), revision }))
		state.artifacts.firmware = { revision, ok: true, pins: {}, log: "" }
		return revision
	}
	const send = <T extends keyof Payloads>(type: T, payload: Payloads[T]) => emit(makeEvent(type, desk.getId(), payload), desk.getId())
	const of = <T extends keyof Payloads>(type: T) => events.filter((e) => e.type === type).map((e) => (e as SemanticEvent<T, Payloads[T]>).payload)
	return { state, events, fake, firmware, send, of }
}

test("the bench waits for the design to settle, then flashes the current firmware and checks the boot", async () => {
	const t = setup(new FakeBridge())
	const rev = t.firmware()
	t.send("artifact.ready", { kind: "firmware", revision: rev })
	await new Promise((r) => setTimeout(r, 60))
	assert.equal(t.fake.commands.filter((c) => c.cmd === "flash").length, 0, "nothing flashes before the first settle")
	t.send("design.settled", { revision: rev, settled: true })
	await waitFor(() => t.of("bench.verdict").length > 0)
	const flash = t.fake.commands.find((c) => c.cmd === "flash")!
	assert.equal(flash.dir, path(t.state.outDir, "firmware", `rev-${rev}`))
	assert.equal(flash.env, "esp32s3_bench")
	const stages = t.of("bench.flashing").map((f) => f.stage)
	assert.deepEqual([...new Set(stages)], ["build", "connect", "write", "boot"])
	assert.ok(t.of("bench.flashing").every((f) => f.revision === rev))
	assert.deepEqual(t.of("bench.flashed").map((f) => [f.revision, f.ok]), [[rev, true]])
	const verdict = t.of("bench.verdict")[0]
	assert.equal(verdict.revision, rev)
	assert.deepEqual(verdict.checks.map((c) => [c.name, c.pass]), [["boot", true], ["imu", true], ["led", true], ["battery", true]])
	assert.equal(verdict.pass, true)
})

test("after the first settle every new firmware is flashed at once, without waiting for another settle", async () => {
	const t = setup(new FakeBridge())
	const first = t.firmware()
	t.send("design.settled", { revision: first, settled: true })
	await waitFor(() => t.of("bench.verdict").length === 1)
	t.state.contract.propose({ field: "behavior", value: { blinkMs: 1000, tiltBlinkMs: 100, tiltDeg: 20 }, by: "firmware", baseVersion: 0 })
	const next = t.firmware()
	t.send("artifact.ready", { kind: "firmware", revision: next })
	await waitFor(() => t.of("bench.verdict").length === 2, 5000)
	assert.deepEqual(t.of("bench.flashed").map((f) => f.revision), [first, next])
	assert.equal(t.of("bench.verdict")[1].revision, next)
})

test("the measured average goes to the contract through change control, once, when it differs by over 10 %", async () => {
	const t = setup(new FakeBridge())
	const rev = t.firmware()
	t.send("design.settled", { revision: rev, settled: true })
	await waitFor(() => t.of("change.resolved").length > 0, 5000)
	const m = t.of("bench.measured")[0]
	assert.equal(m.rail, "3V3")
	assert.equal(m.cycles, 8)
	assert.equal(m.source, "real")
	// 10 800 µC per wake over the 300 s period is 36 µA, plus 10 µA asleep: about 0.046 mA, vs 0.0375 estimated.
	assert.ok(Math.abs(m.averageMa - 0.046) < 0.004, `averageMa ${m.averageMa}`)
	assert.equal(m.estimateMa, 0.0375)
	assert.equal(m.sleepUa, 10)
	// For the dashboard's measured-vs-estimated gauge: 500 mAh / (0.046 mA + the AP2112K's 55 µA) / 24 h.
	assert.deepEqual([m.capacityMah, m.regulatorIqUa, m.targetDays], [500, 55, 180])
	assert.ok(Math.abs(m.days! - 500 / (m.averageMa + 0.055) / 24) < 0.01, `days ${m.days}`)
	const proposed = t.of("change.proposed")
	assert.deepEqual(proposed.map((p) => [p.field, p.by]), [["rails", "bench"]])
	await waitFor(() => t.of("contract.changed").length > 0)
	const rail = t.state.contract.get("rails")!.find((r) => r.name === "3V3")!
	assert.equal(rail.averageSource, "measured")
	assert.equal(rail.measuredRevision, rev)
	assert.equal(rail.averageMa, m.averageMa)
	assert.equal(rail.loadMa, 120, "nothing but the measurement changed")
	// The same firmware measured again proposes nothing more.
	t.send("design.settled", { revision: t.state.contract.revision, settled: true })
	await new Promise((r) => setTimeout(r, 200))
	assert.equal(t.of("change.proposed").length, 1)
})

// 8 250 µC per wake over 300 s is 27.5 µA, plus 10 µA asleep: the contract's 0.0375 mA exactly.
test("a measurement within 10 % of the contract is reported but not proposed", async () => {
	const t = setup(new FakeBridge({ duty: { floorMa: 6, awakeMa: 6 + 8250 / 180, awakeMs: 180, periodMs: 3000, cycles: 8 } }))
	t.send("design.settled", { revision: t.firmware(), settled: true })
	await waitFor(() => t.of("bench.verdict").length > 0, 5000)
	const m = t.of("bench.measured")[0]
	assert.ok(Math.abs(m.averageMa - 0.0375) / 0.0375 < 0.1, `averageMa ${m.averageMa}`)
	assert.equal(t.of("change.proposed").length, 0)
})

test("a replay is badged replay and never proposes to the contract", async () => {
	const t = setup(new FakeBridge({ source: "replay", recordedRev: 3 }))
	const rev = t.firmware()
	t.send("design.settled", { revision: rev, settled: true })
	await waitFor(() => t.of("bench.verdict").length > 0, 5000)
	assert.equal(t.of("bench.flashed")[0].simulated, true)
	assert.equal(t.of("bench.measured")[0].source, "replay")
	assert.equal(t.of("bench.verdict")[0].source, "replay")
	assert.match(t.of("bench.verdict")[0].checks.find((c) => c.name === "boot")!.detail, /replay.*rev 3/)
	await new Promise((r) => setTimeout(r, 100))
	assert.equal(t.of("change.proposed").length, 0)
})

test("a board that boots another revision fails the flash at the boot stage", async () => {
	const t = setup(new FakeBridge({ bootRev: 99 }))
	const rev = t.firmware()
	t.send("design.settled", { revision: rev, settled: true })
	await waitFor(() => t.of("bench.verdict").length > 0, 5000)
	const flashed = t.of("bench.flashed")[0]
	assert.deepEqual([flashed.ok, flashed.stage], [false, "boot"])
	assert.match(flashed.error!, /99/)
	assert.equal(t.of("bench.verdict")[0].pass, false)
	assert.equal(t.of("bench.measured").length, 0)
})

test("a failed upload is reported with the bridge's stage and error", async () => {
	const t = setup(new FakeBridge({ flash: () => ({ ok: false, stage: "permission", error: "Permission denied: /dev/ttyACM0", ms: 5 }) }))
	t.send("design.settled", { revision: t.firmware(), settled: true })
	await waitFor(() => t.of("bench.flashed").length > 0)
	assert.deepEqual(t.of("bench.flashed").map((f) => [f.ok, f.stage]), [[false, "permission"]])
	assert.match(t.of("bench.flashed")[0].error!, /dialout/, "says how to fix the permission")
})

test("the bench refuses to flash a design whose pins collide with the bench's own GPIO4 or GPIO17", async () => {
	const t = setup(new FakeBridge(), { pins: [...LOGGER_DESIGN.pins, { ...STATUS_LED, gpio: 4 }] })
	t.send("design.settled", { revision: t.firmware(), settled: true })
	await waitFor(() => t.of("bench.flashed").length > 0)
	const flashed = t.of("bench.flashed")[0]
	assert.deepEqual([flashed.ok, flashed.stage], [false, "pins"])
	assert.match(flashed.error!, /STATUS_LED.*GPIO4/)
	assert.equal(t.fake.commands.filter((c) => c.cmd === "flash").length, 0)
})

test("a bare S3 with no IMU fitted and no meter: imu is 'not fitted', neutral, and the verdict passes on boot and LED", async () => {
	const t = setup(new FakeBridge({ imu: false, meter: false }))
	t.send("design.settled", { revision: t.firmware(), settled: true })
	await waitFor(() => t.of("bench.verdict").length > 0, 5000)
	const v = t.of("bench.verdict")[0]
	const checks = Object.fromEntries(v.checks.map((c) => [c.name, c]))
	assert.deepEqual([checks.imu.pass, checks.imu.skipped], [true, true])
	assert.match(checks.imu.detail, /not fitted/)
	assert.equal(checks.led.pass, true)
	assert.equal(v.pass, true)
	assert.equal(checks.battery, undefined)
	assert.equal(t.of("bench.measured").length, 0)
	assert.ok(!t.fake.commands.some((c) => c.cmd === "mode" && c.mode === "duty"))
})

test("an IMU that answered and then stopped is a failure, not 'not fitted'", async () => {
	const t = setup(new FakeBridge({ imu: "stops", meter: false }))
	t.send("design.settled", { revision: t.firmware(), settled: true })
	await waitFor(() => t.of("bench.verdict").length > 0, 5000)
	const imu = t.of("bench.verdict")[0].checks.find((c) => c.name === "imu")!
	assert.equal(imu.pass, false)
	assert.equal(imu.skipped, undefined)
	assert.match(imu.detail, /stopped answering.*no ACK/)
	assert.equal(t.of("bench.verdict")[0].pass, false)
})

test("telemetry reaches Mozaik in batches, tagged with the booted revision", async () => {
	const t = setup(new FakeBridge())
	t.fake.emit({ k: "s", rev: 0, ms: 0, ax: 0, ay: 0, az: 1, tilt: 0, led: 0 })
	t.fake.emit({ k: "i", mA: 12.5 })
	await waitFor(() => t.of("bench.telemetry").length > 0)
	const batch = t.of("bench.telemetry")[0]
	assert.equal(batch.samples.length, 2)
	assert.equal(batch.source, "real")
	assert.equal(batch.revision, null)
	assert.deepEqual(Object.keys(batch.samples[1]).sort(), ["at", "mA"])
	assert.ok(t.events.some((e) => e.type === "bench.connected"))
})

test("a board that panics or browns out after booting fails the boot check", async () => {
	const fake = new FakeBridge({ meter: false })
	const t = setup(fake)
	const rev = t.firmware()
	t.send("design.settled", { revision: rev, settled: true })
	await waitFor(() => t.of("bench.flashed").length > 0)
	fake.emit({ k: "boot", rev, reset: "brownout", mode: "live" })
	await waitFor(() => t.of("bench.verdict").length > 0, 5000)
	const boot = t.of("bench.verdict")[0].checks.find((c) => c.name === "boot")!
	assert.equal(boot.pass, false)
	assert.match(boot.detail, /brownout/)
})

test("without a battery capacity the measurement is reported but battery life is not judged, so it can't fail", async () => {
	const t = setup(new FakeBridge())
	writeFileSync(path(t.state.outDir, "brief.md"), "A blinky with a button.\n")
	t.send("design.settled", { revision: t.firmware(), settled: true })
	await waitFor(() => t.of("bench.verdict").length > 0, 5000)
	assert.equal(t.of("bench.measured")[0].days, null)
	const v = t.of("bench.verdict")[0]
	assert.equal(v.checks.some((c) => c.name === "battery"), false)
	assert.equal(v.pass, true)
})

test("a newer firmware cuts the running measurement short and is flashed at once", async () => {
	const t = setup(new FakeBridge(), { windowMs: 5000 })
	const first = t.firmware()
	t.send("design.settled", { revision: first, settled: true })
	await waitFor(() => t.fake.commands.some((c) => c.cmd === "mode" && c.mode === "duty"))
	t.state.contract.propose({ field: "behavior", value: { blinkMs: 1000, tiltBlinkMs: 100, tiltDeg: 20 }, by: "firmware", baseVersion: 0 })
	const next = t.firmware()
	const sent = Date.now()
	t.send("artifact.ready", { kind: "firmware", revision: next })
	await waitFor(() => t.of("bench.flashing").some((f) => f.revision === next), 2000)
	assert.ok(Date.now() - sent < 1500, "flashed without waiting out the 5 s window")
	await waitFor(() => t.of("bench.verdict").some((v) => v.revision === next), 8000)
	const old = t.of("bench.verdict").find((v) => v.revision === first)
	assert.ok(old, "the superseded firmware still gets its verdict on what was checked")
	assert.equal(old!.checks.some((c) => c.name === "battery"), false)
	assert.equal(t.of("bench.measured").some((m) => m.revision === first), false)
})

test("without a CP2102: a telemetry error while the port re-enumerates and a repeated boot line change nothing", async () => {
	const fake = new FakeBridge()
	const t = setup(fake)
	const rev = t.firmware()
	t.send("design.settled", { revision: rev, settled: true })
	await waitFor(() => t.of("bench.flashed").length > 0)
	// The bridge reopens the S3's own USB port after the flash: one error line, then the firmware resends its boot line.
	fake.emit({ k: "error", where: "telemetry", error: "port vanished: /dev/ttyACM0" })
	fake.emit({ k: "boot", rev, reset: "usb", mode: "live" })
	await waitFor(() => t.of("bench.verdict").length > 0, 5000)
	assert.equal(t.of("bench.flashed").length, 1)
	assert.equal(t.of("bench.verdict")[0].pass, true, JSON.stringify(t.of("bench.verdict")[0].checks))
	assert.equal(t.of("bench.measured").length, 1, "measured from the meter samples alone, with no cycle lines")
})

test("a null temperature (no sensor) is left out of the telemetry, not sent as 0 °C", async () => {
	const t = setup(new FakeBridge())
	t.fake.emit({ k: "s", rev: 0, ms: 0, ax: 0, ay: 0, az: 0, tilt: 0, tC: null, tSrc: "none", led: 1 })
	await waitFor(() => t.of("bench.telemetry").length > 0)
	const sample = t.of("bench.telemetry")[0].samples[0]
	assert.equal("tC" in sample, false)
	assert.equal(sample.led, 1)
})
