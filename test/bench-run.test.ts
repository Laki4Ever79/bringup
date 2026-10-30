import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, runDesign } from "../src/run.ts"
import { appendRequest } from "../src/runner/requests.ts"
import type { Env } from "../src/tools/env.ts"
import { FakeBridge } from "./bench-fake.ts"
import { tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 300)))

const bare: Env = { root: ROOT, tsci: null, kicad: null, python: null, pio: null }
const brief = readFileSync(join(ROOT, "briefs/logger.md"), "utf8")

const traceOf = (out: string) =>
	existsSync(join(out, "trace.jsonl"))
		? readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; producerId: string; payload: any })
		: []

test("--bench keeps the run alive after settling: flash, measure, the architect takes the measured average, the design settles again", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const fake = new FakeBridge()
	let stop: () => void = () => {}
	const until = new Promise<void>((r) => (stop = r))
	const run = runDesign({
		brief,
		mock: true,
		outDir: out,
		env: bare,
		noHardware: true,
		review: false,
		bench: { open: async () => ({ bridge: fake, hello: await fake.hello }), until, timings: { windowMs: 40, liveCheckMs: 30, bootTimeoutMs: 1000, batchMs: 50 } },
	})
	// The measured rails are applied and the design settles a second time on them.
	await waitFor(() => {
		const t = traceOf(out)
		const applied = t.findIndex((e) => e.type === "contract.changed" && e.payload.field === "rails" && e.payload.by === "bench")
		return applied >= 0 && t.slice(applied).some((e) => e.type === "design.settled")
	}, 60_000)
	const firstReport = readFileSync(join(out, "report.md"), "utf8")
	assert.match(firstReport, /^## Bring-up$/m, "the report is written on every settle, not only at the end")
	stop()
	const result = await run
	assert.equal(result.settled, true)
	const trace = traceOf(out)
	const types = trace.map((e) => e.type)
	assert.ok(types.indexOf("design.settled") < types.indexOf("bench.flashing"), "nothing flashes before the first settle")
	assert.equal(types.filter((t) => t === "design.settled").length, 2)
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	const rail = contract.values.rails.find((r: { name: string }) => r.name === "3V3")
	assert.equal(rail.averageSource, "measured")
	const report = readFileSync(join(out, "report.md"), "utf8")
	assert.match(report, /Verdict: pass at firmware rev/)
	assert.match(report, /approved by architect/)
	assert.ok(fake.closed, "the bridge is closed when the run ends")
})

test("--bench reflashes when a change request changes the firmware behavior after settling", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const fake = new FakeBridge({ meter: false })
	let stop: () => void = () => {}
	const until = new Promise<void>((r) => (stop = r))
	const run = runDesign({
		brief,
		mock: true,
		outDir: out,
		env: bare,
		noHardware: true,
		review: false,
		bench: { open: async () => ({ bridge: fake, hello: await fake.hello }), until, timings: { windowMs: 40, liveCheckMs: 30, bootTimeoutMs: 1000, batchMs: 50 } },
	})
	await waitFor(() => traceOf(out).some((e) => e.type === "bench.verdict"), 60_000)
	appendRequest(out, "blink faster when tilted")
	await waitFor(() => traceOf(out).filter((e) => e.type === "bench.verdict").length >= 2, 60_000)
	stop()
	await run
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	assert.deepEqual(contract.values.behavior, { blinkMs: 1000, tiltBlinkMs: 100, tiltDeg: 20 })
	const flashes = fake.commands.filter((c) => c.cmd === "flash").map((c) => c.dir as string)
	assert.equal(flashes.length, 2)
	assert.match(readFileSync(join(flashes[1], "include/behavior.h"), "utf8"), /BEHAVIOR_TILT_BLINK_MS 100/)
	const changed = traceOf(out).find((e) => e.type === "contract.changed" && e.payload.field === "behavior")
	assert.equal(changed?.payload.by, "firmware")
})
