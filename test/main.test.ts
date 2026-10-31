import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { main, parseArgs } from "../src/main.ts"
import { ROOT } from "../src/run.ts"
import { missingTools } from "../src/report.ts"
import type { Env } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

// One runtime per process: let the previous run's loops wind down first.
afterEach(() => new Promise((r) => setTimeout(r, 300)))

const brief = join(ROOT, "briefs/logger.md")
// A fresh clone after `npm ci`: no Docker image, no .venv, no tools/node.
const bare = async (): Promise<Env> => ({ root: ROOT, tsci: null, kicad: null, python: null, pio: null })

test("parseArgs reads the brief and flags", () => {
	assert.deepEqual(parseArgs([brief, "--mock", "--no-hardware", "--out", "/tmp/x"]), { briefPath: brief, mock: true, noHardware: true, review: true, engineerApproval: false, outDir: "/tmp/x" })
	assert.deepEqual(parseArgs(["--out", "/tmp/x", brief]), { briefPath: brief, mock: false, noHardware: false, review: true, engineerApproval: false, outDir: "/tmp/x" })
})

test("parseArgs reads repeated --change requests, in order, without taking one for the brief", () => {
	const a = parseArgs(["--change", "make the board 40 mm wide", brief, "--mock", "--change", "the SHT40 is out of stock"]) as { briefPath: string; changes: string[] }
	assert.equal(a.briefPath, brief)
	assert.deepEqual(a.changes, ["make the board 40 mm wide", "the SHT40 is out of stock"])
	assert.match((parseArgs([brief, "--change"]) as { error: string }).error, /--change/)
	assert.match((parseArgs([brief, "--change", "--mock"]) as { error: string }).error, /--change/)
})

test("parseArgs rejects --out without a value instead of crashing", () => {
	assert.match((parseArgs([brief, "--out"]) as { error: string }).error, /--out/)
	assert.match((parseArgs([brief, "--out", "--mock"]) as { error: string }).error, /--out/)
})

test("parseArgs rejects a missing brief", () => {
	assert.match((parseArgs(["--mock"]) as { error: string }).error, /brief/)
	assert.match((parseArgs(["nope.md"]) as { error: string }).error, /nope\.md/)
})

test("missingTools names each missing tool with its install command", () => {
	const missing = missingTools({ root: ROOT, tsci: null, kicad: "docker", python: null, pio: "/x/pio" })
	assert.deepEqual(missing.map((m) => m.tool), ["tscircuit", "python with build123d"])
	assert.ok(missing.every((m) => m.install.length > 0))
})

test("a run with no tools at all and --no-hardware settles with 0 violations", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const start = Date.now()
	assert.equal(await main([brief, "--mock", "--no-hardware", "--out", out], { detect: bare }), 0)
	const report = readFileSync(join(out, "report.md"), "utf8")
	assert.match(report, /^Status: settled/m)
	assert.match(report, /^Violations: 0$/m)
	assert.match(report, /stubbed/i)
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const ready = new Set(trace.filter((e) => e.type === "artifact.ready").map((e) => e.payload.kind))
	assert.deepEqual([...ready].sort(), ["board", "enclosure", "firmware"])
	assert.ok(trace.some((e) => e.type === "change.decided"), "change control still runs")
	assert.deepEqual(trace.find((e) => e.type === "run.started")?.payload, { review: true, engineerApproval: false, noHardware: true, bench: false }, "the run's options are in the trace, for the dashboard")
	console.log(`no-hardware run took ${Date.now() - start} ms`)
})

test("a run with missing tools ends unsettled with a report instead of exiting 1", { timeout: 120_000 }, async () => {
	const out = tempDir()
	assert.equal(await main([brief, "--mock", "--out", out], { detect: bare }), 2)
	const report = readFileSync(join(out, "report.md"), "utf8")
	assert.match(report.split("\n").slice(0, 4).join("\n"), /^Status: UNSETTLED — missing tools: tscircuit, KiCad 10, python with build123d, PlatformIO/m)
	const top = report.slice(0, report.indexOf("## Design"))
	assert.match(top, /## Missing tools/)
	assert.match(top, /docker pull kicad\/kicad:10\.0/)
	assert.match(report, /board failed: tscircuit build failed: tsci is not installed/)
})

test("parseArgs reads --review-rounds", () => {
	const brief = new URL("../briefs/logger.md", import.meta.url).pathname
	assert.equal((parseArgs([brief, "--review-rounds", "2"]) as { reviewRounds?: number }).reviewRounds, 2)
	assert.ok("error" in parseArgs([brief, "--review-rounds", "zero"]))
})

test("parseArgs reads --bench with an optional source, and --bench-replay", () => {
	const brief = new URL("../briefs/logger.md", import.meta.url).pathname
	assert.equal((parseArgs([brief, "--mock"]) as { bench?: string }).bench, undefined)
	assert.equal((parseArgs([brief, "--bench"]) as { bench?: string }).bench, "real")
	assert.equal((parseArgs(["--bench", brief]) as { briefPath: string }).briefPath, brief, "the brief after --bench is not its source")
	assert.equal((parseArgs([brief, "--bench", "fake"]) as { bench?: string }).bench, "fake")
	const replay = parseArgs([brief, "--bench", "replay", "--bench-replay", "/rec.jsonl"]) as { bench?: string; benchReplay?: string }
	assert.deepEqual([replay.bench, replay.benchReplay], ["replay", "/rec.jsonl"])
	assert.ok("error" in parseArgs([brief, "--bench-replay"]))
})

test("parseArgs reads --bench-no-meter, which only means something to the fake bench", () => {
	const brief = new URL("../briefs/logger.md", import.meta.url).pathname
	assert.equal((parseArgs([brief, "--bench", "fake", "--bench-no-meter"]) as { benchNoMeter?: boolean }).benchNoMeter, true)
	assert.equal((parseArgs([brief, "--bench", "fake"]) as { benchNoMeter?: boolean }).benchNoMeter, undefined)
})

test("parseArgs reads --bench-no-imu for the fake bench (a bare S3 with --bench-no-meter)", () => {
	const brief = new URL("../briefs/logger.md", import.meta.url).pathname
	const a = parseArgs([brief, "--bench", "fake", "--bench-no-meter", "--bench-no-imu"]) as { benchNoMeter?: boolean; benchNoImu?: boolean }
	assert.deepEqual([a.benchNoMeter, a.benchNoImu], [true, true])
})
