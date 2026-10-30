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
