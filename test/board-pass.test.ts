import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runResult, silkOf, table } from "../scripts/board-pass.ts"

// A mock run's folder as the runner leaves it: report.md's status, trace.jsonl's board builds.
test("a mock run's result: the verdict from its report, the board builds and their time from its trace, the last board's DRC", () => {
	const dir = mkdtempSync(join(tmpdir(), "board-pass-test-"))
	try {
		writeFileSync(join(dir, "report.md"), "# Report\n\nStatus: settled at contract revision 13\n\nViolations: 0\n")
		const ev = (type: string, payload: object) => JSON.stringify({ type, payload })
		writeFileSync(join(dir, "trace.jsonl"), [
			ev("artifact.ready", { kind: "enclosure", revision: 4, skipped: "no case" }),
			ev("artifact.ready", { kind: "board", revision: 6, ms: 31278, drc: { errors: 0, unconnected: 2, byType: { silk_overlap: 1 } } }),
			ev("artifact.failed", { kind: "board", revision: 11, ms: 196095, error: "tscircuit build failed" }),
			ev("artifact.ready", { kind: "board", revision: 13, ms: 24868, drc: { errors: 0, unconnected: 0, byType: { silk_overlap: 15, silk_over_copper: 37 } } }),
		].join("\n") + "\n")
		const r = runResult("rover-nofr", dir, 999)
		assert.deepEqual(r, { case: "rover-nofr", verdict: "settled r13", seconds: 252, builds: 3, failed: 1, errors: 0, unconnected: 0, byType: { silk_overlap: 15, silk_over_copper: 37 }, silk: 52 })
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("a run that left no report says so, timed by the wall clock", () => {
	const dir = mkdtempSync(join(tmpdir(), "board-pass-test-"))
	try {
		assert.equal(runResult("rover", dir, 42).verdict, "no report")
		assert.equal(runResult("rover", dir, 42).seconds, 42)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("the table puts each case's before beside its after", () => {
	assert.equal(silkOf({ silk_overlap: 3, silk_over_copper: 35, text_height: 2 }), 38)
	const a = { case: "arm", verdict: "ROUTED 4L", seconds: 200, builds: 1, failed: 0, errors: 0, unconnected: 0, byType: { silk_overlap: 2 }, silk: 2 }
	const t = table([a], [{ ...a, seconds: 204, byType: { silk_over_copper: 46 }, silk: 46 }])
	assert.match(t, /\| arm \| ROUTED 4L · 204 s · 1 builds · DRC 0\/0 · silk 46 \| ROUTED 4L · 200 s · 1 builds · DRC 0\/0 · silk 2 \|/)
	assert.match(t, /arm: silk_overlap 2 \[silk_over_copper 46\]/)
})

test("a regression: no longer settled, more DRC errors or unconnected; over 25 % slower is a warning; a new case is none", async () => {
	const { regressions, slowdowns } = await import("../scripts/board-pass.ts")
	const r = (o: object) => ({ case: "rover-nofr", verdict: "settled r13", seconds: 400, builds: 7, failed: 1, errors: 0, unconnected: 0, byType: {}, silk: 0, ...o })
	assert.deepEqual(regressions([r({ seconds: 300 })], [r({})]), [])
	assert.deepEqual(slowdowns([r({ seconds: 500 })], [r({})]), [], "25 % slower exactly is within")
	assert.deepEqual(slowdowns([r({ seconds: 501 })], [r({})]), ["rover-nofr: 400 s → 501 s (over 25 % slower)"])
	assert.deepEqual(regressions([r({ seconds: 900 })], [r({})]), [], "time alone never fails")
	assert.deepEqual(regressions([r({ verdict: "unsettled at revision 16" })], [r({})]), ["rover-nofr: settled r13 → unsettled at revision 16"])
	assert.deepEqual(regressions([r({ case: "cnc", errors: 2, unconnected: 3 })], [r({ case: "cnc" })]), ["cnc: DRC errors 0 → 2", "cnc: unconnected 0 → 3"])
	assert.deepEqual(regressions([r({ case: "arm" })], [r({})]), [], "no before for arm: new, not a regression")
})

test("repeated builds of one contract: ROUTED when every try routed clean, VARIES when some did, FAILED when none", async () => {
	const { repeatResult } = await import("../scripts/board-pass.ts")
	const ok = { case: "repeat49", verdict: "ROUTED", seconds: 25, builds: 1, failed: 0, errors: 0, unconnected: 0, byType: {}, silk: 0 }
	const bad = { ...ok, verdict: "FAILED: tscircuit build failed", seconds: 190, builds: 0, failed: 1, errors: null, unconnected: null }
	assert.equal(repeatResult("repeat49", [ok, ok, ok]).verdict, "ROUTED 3/3")
	assert.equal(repeatResult("repeat49", [ok, bad, ok]).verdict, "VARIES 2/3")
	assert.equal(repeatResult("repeat49", [bad, bad, bad]).verdict, "FAILED 0/3")
	assert.equal(repeatResult("repeat49", [ok, bad, ok]).seconds, 240)
})
