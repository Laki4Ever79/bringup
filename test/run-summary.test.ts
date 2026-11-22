// The one-screen run summary (src/runner/summary.ts): each artifact's own verdict, what changed since the last run of
// the same brief, and an exit code (`bringup summary`, the MCP's run_summary). text-to-cad's lesson 6, 22 Nov 2026.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { previousRun, runSummary, summaryDelta, summaryExitCode } from "../src/runner/summary.ts"
import { tempDir } from "./helpers.ts"

function run(out: string, name: string, brief: string, status: string, violations: string[], clashes: number) {
	const dir = join(out, name)
	mkdirSync(join(dir, "chassis", "rev-4"), { recursive: true })
	writeFileSync(join(dir, "brief.md"), brief)
	writeFileSync(join(dir, "report.md"), `# Bringup report\n\nStatus: ${status}\nModels: mock\nViolations: ${violations.length}\n${violations.map((v) => `- ${v}\n`).join("")}\n## Design\n`)
	writeFileSync(join(dir, "chassis", "rev-4", "mounts.json"), JSON.stringify({ interference: { pairs: 28, clashes: Array(clashes).fill({}), unmeasured: [] } }))
	writeFileSync(join(dir, "chassis", "rev-4", "chassis.stl"), "solid")
	return dir
}

test("the summary finds the last run of the same brief and says what changed, before → after", () => {
	const out = tempDir()
	const a = run(out, "20261101-100000", "rover", "UNSETTLED at contract revision 4", ["part-interference: chassis and battery: 596.7 mm³"], 1)
	run(out, "20261101-110000", "a logger", "settled at contract revision 9", [], 0)
	const b = run(out, "20261101-120000", "rover", "settled at contract revision 12", [], 0)
	assert.equal(previousRun(b), a, "the older run of the same brief, not the logger in between")
	assert.equal(previousRun(a), null)
	const delta = summaryDelta(runSummary(a, "a"), runSummary(b, "b"))
	assert.deepEqual(delta, [
		"status: UNSETTLED at contract revision 4 → settled at contract revision 12",
		"open violations: 1 → 0",
		"chassis: interference: 28 pairs, 1 clash(es), 0 unmeasured → interference: 28 pairs, 0 clash(es), 0 unmeasured",
	])
	assert.equal(summaryExitCode(runSummary(b, "b")), 0)
	assert.equal(summaryExitCode(runSummary(a, "a")), 2)
	mkdirSync(join(out, "empty"))
	assert.equal(summaryExitCode(runSummary(join(out, "empty"), "empty")), 1, "no report: not settled, not unsettled")
})
