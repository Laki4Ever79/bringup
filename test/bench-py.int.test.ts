import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, runDesign } from "../src/run.ts"
import { openBench } from "../src/bench/open.ts"
import { startBridge } from "../src/tools/bench-bridge.ts"
import type { Env } from "../src/tools/env.ts"
import { tempDir, waitFor } from "./helpers.ts"

const python = join(ROOT, ".venv/bin/python")
const bare: Env = { root: ROOT, tsci: null, kicad: null, python: null, pio: null }

// The whole bring-up loop against af's real bridge (py/bench.py --source fake), with no board: flash, boot rev, IMU,
// LED, a 20 s duty-cycle window (about six wakes) and the measurement. The fake never proposes to the contract.
test("--bench fake: the bench drives py/bench.py through flash, checks and a measurement", { skip: !existsSync(python) && "no .venv python", timeout: 180_000 }, async () => {
	const out = tempDir()
	let stop: () => void = () => {}
	const until = new Promise<void>((r) => (stop = r))
	const stderr: string[] = []
	const run = runDesign({
		brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"),
		mock: true,
		outDir: out,
		env: bare,
		noHardware: true,
		review: false,
		bench: {
			open: () => openBench({ root: ROOT, source: "fake", outDir: out, start: (a) => startBridge(python, [...a, "--fake-speed", "10"], { cwd: ROOT, onStderr: (t) => stderr.push(t) }), log: () => {} }),
			until,
			timings: { windowMs: 20_000, liveCheckMs: 3000 },
		},
	})
	const trace = () => (existsSync(join(out, "trace.jsonl")) ? readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; payload: any }) : [])
	await waitFor(() => trace().some((e) => e.type === "bench.verdict"), 120_000)
	stop()
	await run
	const t = trace()
	const of = (type: string) => t.filter((e) => e.type === type).map((e) => e.payload)
	assert.equal(of("bench.connected")[0].source, "fake")
	const flashed = of("bench.flashed")[0]
	assert.equal(flashed.ok, true, `${flashed.stage}: ${flashed.error}\n${stderr.join("")}`)
	const verdict = of("bench.verdict")[0]
	assert.deepEqual(verdict.checks.filter((c: { pass: boolean }) => !c.pass), [], JSON.stringify(verdict.checks))
	const m = of("bench.measured")[0]
	assert.ok(m.cycles >= 5, `cycles ${m.cycles}`)
	assert.ok(m.averageMa > 0.03 && m.averageMa < 0.07, `averageMa ${m.averageMa}`)
	assert.equal(m.source, "fake")
	assert.ok(of("bench.telemetry").some((b) => b.samples.some((s: { tilt?: number }) => typeof s.tilt === "number")))
	assert.ok(!t.some((e) => e.type === "change.proposed" && e.payload.by === "bench"), "the fake bench never proposes")
	assert.ok(existsSync(join(out, "bench/bench.jsonl")), "the bridge records the session")
	assert.match(readFileSync(join(out, "report.md"), "utf8"), /fake bench/)
})

// The stage fallback: no board, so the newest recording plays. Badged replay everywhere, measured, never proposed.
test("--bench with no board falls back to the recorded session and measures it as a replay", { skip: (!existsSync(python) || !existsSync(join(ROOT, "fixtures/bench/synthetic.jsonl"))) && "no .venv python or no recording", timeout: 240_000 }, async () => {
	const out = tempDir()
	let stop: () => void = () => {}
	const until = new Promise<void>((r) => (stop = r))
	const run = runDesign({
		brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"),
		mock: true,
		outDir: out,
		env: bare,
		noHardware: true,
		review: false,
		bench: { open: () => openBench({ root: ROOT, source: "replay", outDir: out, start: (a) => startBridge(python, a, { cwd: ROOT }), log: () => {} }), until, timings: { windowMs: 50_000, liveCheckMs: 3000 } },
	})
	const trace = () => (existsSync(join(out, "trace.jsonl")) ? readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; payload: any }) : [])
	await waitFor(() => trace().some((e) => e.type === "bench.verdict"), 200_000)
	stop()
	await run
	const of = (type: string) => trace().filter((e) => e.type === type).map((e) => e.payload)
	assert.equal(of("bench.flashed")[0].simulated, true)
	const m = of("bench.measured")[0]
	assert.ok(m, `no measurement; verdict ${JSON.stringify(of("bench.verdict")[0])}`)
	assert.equal(m.source, "replay")
	assert.ok(m.cycles >= 5 && Math.abs(m.floorMa - 6) < 1, `cycles ${m.cycles}, floor ${m.floorMa}`)
	assert.ok(!trace().some((e) => e.type === "change.proposed" && e.payload.by === "bench"))
	assert.match(readFileSync(join(out, "report.md"), "utf8"), /REPLAY/)
})
