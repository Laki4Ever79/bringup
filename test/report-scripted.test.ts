import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { writeReport } from "../src/report.ts"
import { BringupState } from "../src/runtime.ts"
import type { Env } from "../src/tools/env.ts"
import { checkPills } from "../src/dashboard/model.js"
import { tempDir } from "./helpers.ts"

const env: Env = { root: ".", tsci: "tsci", kicad: "docker", python: "python", pio: "pio", qemu: "qemu" }

function report(mock: boolean | undefined): string {
	const s = new BringupState(tempDir())
	s.review.enabled = true
	s.review.results.push({ round: 1, revision: 7, verdict: "pass", findings: [] })
	return readFileSync(writeReport(s.outDir, s, env, true, mock === undefined ? {} : { mock }), "utf8")
}

// A mock run's reviewer, owners and agents follow scripts: nothing in the report may read like a model judged it.
test("report: a --mock run labels the brief review and the approvals as scripted", () => {
	const text = report(true)
	assert.match(text, /^Models: mock \(scripted agents: no model judged this design\)$/m)
	assert.match(text, /^Verdict: pass \(scripted reviewer, not a model verdict\) after 1 review/m)
	assert.match(text, /^- Review 1 of revision 7: pass \(scripted\)$/m)
	assert.match(text, /^- Change requests held by interception: 0 \(approved 0, rejected 0; by scripted owners\)$/m)
})

test("report: a real-model run keeps the plain verdict", () => {
	for (const text of [report(false), report(undefined)]) {
		assert.match(text, /^Verdict: pass after 1 review/m)
		assert.doesNotMatch(text, /scripted/)
	}
})

const ev = (type: string, payload: object) => ({ seq: 0, at: "2026-10-31T12:00:00.000Z", type, producerId: "x", payload })

test("the Review pill of a --mock run says scripted, in its label and its popover", () => {
	const events = [ev("run.started", { review: true, mock: true }), ev("design.ready", { revision: 7 }), ev("review.completed", { revision: 7, verdict: "pass", findings: [] })]
	const p = (checkPills(events) as any[]).find((x) => x.key === "review")
	assert.equal(p.label, "Review · scripted")
	assert.equal(p.state, "ok")
	assert.deepEqual(p.items, ["pass from the scripted reviewer (--mock), not a model verdict"])
	const real = (checkPills([ev("run.started", { review: true, mock: false }), ...events.slice(1)]) as any[]).find((x) => x.key === "review")
	assert.deepEqual([real.label, real.items], ["Review", []])
})
