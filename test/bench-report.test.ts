import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { bringupSection } from "../src/bench/report.ts"
import { tempDir } from "./helpers.ts"

function trace(events: { type: string; payload: object; producerId?: string }[]): string {
	const dir = tempDir()
	const path = join(dir, "trace.jsonl")
	writeFileSync(path, events.map((e, seq) => JSON.stringify({ seq, at: "2026-10-31T10:00:00Z", producerId: e.producerId ?? "b", ...e })).join("\n") + "\n")
	return path
}

const checks = [
	{ name: "boot", pass: true, detail: "booted rev 9" },
	{ name: "imu", pass: true, detail: "the MPU-6050 answers" },
	{ name: "led", pass: true, detail: "STATUS_LED toggles" },
	{ name: "battery", pass: true, detail: "206 days measured vs target 180" },
]

test("the Bring-up section reports the last flash, the checks, the measurement and what the contract did with it", () => {
	const path = trace([
		{ type: "bench.connected", payload: { source: "real", ports: { dut: "/dev/ttyACM0", fixture: "/dev/ttyACM1", telemetry: "/dev/ttyUSB0" }, meter: true } },
		{ type: "bench.flashed", payload: { revision: 9, ok: true, ms: 21400 } },
		{ type: "bench.measured", payload: { revision: 9, rail: "3V3", cycles: 15, awakeMs: 183, chargeUc: 10800, floorMa: 6.1, averageMa: 0.046, estimateMa: 0.0375, sleepUa: 10, source: "real" } },
		{ type: "bench.verdict", payload: { revision: 9, pass: true, source: "real", checks } },
		{ type: "change.proposed", payload: { proposalId: "p1", field: "rails", by: "bench", reason: "measured", needsEngineer: false } },
		{ type: "change.resolved", payload: { proposalId: "p1", approved: true, reason: "measured beats estimated", decidedBy: ["architect"] } },
	])
	const text = bringupSection(path).join("\n")
	assert.match(text, /^## Bring-up$/m)
	assert.match(text, /real board/)
	assert.match(text, /Verdict: pass at firmware rev 9/)
	assert.match(text, /flashed in 21\.4 s/)
	for (const c of checks) assert.ok(text.includes(c.detail), c.name)
	assert.match(text, /0\.046 mA on 3V3.*15 wakes.*10800 µC.*estimate 0\.0375 mA/)
	assert.match(text, /floor 6\.1 mA/)
	assert.match(text, /approved by architect/)
})

test("a replay says so on every line that could be mistaken for a measurement", () => {
	const path = trace([
		{ type: "bench.connected", payload: { source: "replay", ports: { dut: null, fixture: null, telemetry: null }, meter: true } },
		{ type: "bench.flashed", payload: { revision: 4, ok: true, ms: 10, simulated: true } },
		{ type: "bench.measured", payload: { revision: 4, rail: "3V3", cycles: 15, awakeMs: 183, chargeUc: 10800, floorMa: 6.1, averageMa: 0.046, estimateMa: 0.0375, sleepUa: 10, source: "replay" } },
		{ type: "bench.verdict", payload: { revision: 4, pass: true, source: "replay", checks } },
	])
	const text = bringupSection(path).join("\n")
	assert.match(text, /REPLAY/)
	assert.match(text, /Measured \(REPLAY/)
	assert.match(text, /never proposed/)
})

test("a failed flash is reported with its stage, and nothing was measured", () => {
	const path = trace([
		{ type: "bench.connected", payload: { source: "real", ports: { dut: "/dev/ttyACM0", fixture: null, telemetry: null }, meter: false } },
		{ type: "bench.flashed", payload: { revision: 9, ok: false, stage: "permission", ms: 50, error: "Permission denied: add yourself to dialout" } },
		{ type: "bench.verdict", payload: { revision: 9, pass: false, source: "real", checks: [{ name: "boot", pass: false, detail: "Permission denied" }] } },
	])
	const text = bringupSection(path).join("\n")
	assert.match(text, /Verdict: FAIL at firmware rev 9/)
	assert.match(text, /flash failed at permission: Permission denied/)
	assert.match(text, /no meter/)
})

test("a bench that never got a settled design says so", () => {
	const text = bringupSection(trace([{ type: "bench.connected", payload: { source: "fake", ports: { dut: null, fixture: null, telemetry: null }, meter: true } }])).join("\n")
	assert.match(text, /fake bench/)
	assert.match(text, /nothing flashed/)
})

test("a skipped check (IMU not fitted) is listed as such, not as ok or FAIL", () => {
	const path = trace([
		{ type: "bench.connected", payload: { source: "real", ports: { dut: "/dev/ttyACM0", fixture: null, telemetry: "/dev/ttyACM0" }, meter: false } },
		{ type: "bench.flashed", payload: { revision: 9, ok: true, ms: 9000 } },
		{ type: "bench.verdict", payload: { revision: 9, pass: true, source: "real", checks: [{ name: "imu", pass: true, skipped: true, detail: "not fitted (no ACK at 0x68)" }] } },
	])
	const text = bringupSection(path).join("\n")
	assert.match(text, /^- imu: not checked, not fitted \(no ACK at 0x68\)$/m)
})

test("steps the person had to do at the bench are in the report, with what came of them", () => {
	const path = trace([
		{ type: "bench.connected", payload: { source: "real", ports: { dut: "/dev/ttyACM0", fixture: null, telemetry: "/dev/ttyACM0" }, meter: false } },
		{ type: "bench.instruction", payload: { revision: 2, action: "boot-reset", text: "Hold BOOT, tap RST, release BOOT", state: "waiting" } },
		{ type: "bench.instruction", payload: { revision: 2, action: "boot-reset", text: "Hold BOOT, tap RST, release BOOT", state: "done" } },
		{ type: "bench.instruction", payload: { revision: 3, action: "reset", text: "Tap RST", state: "waiting" } },
		{ type: "bench.instruction", payload: { revision: 3, action: "reset", text: "Tap RST", state: "timeout" } },
		{ type: "bench.flashed", payload: { revision: 3, ok: true, ms: 9000 } },
	])
	const text = bringupSection(path).join("\n")
	assert.match(text, /- Asked the person \(rev 2\): Hold BOOT, tap RST, release BOOT: done/)
	assert.match(text, /- Asked the person \(rev 3\): Tap RST: nobody did it within 180 s/)
})
