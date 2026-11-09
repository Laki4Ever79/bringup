// Time and cost estimates on the plan screen (src/system/estimate.ts), from runs recorded in out/.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { estimate } from "../src/system/estimate.ts"
import { scriptedPlan } from "../src/system/architect.ts"
import type { Plan } from "../src/system/plan.ts"
import { tempDir } from "./helpers.ts"

const plan: Plan = { ...scriptedPlan("a logger and a beacon over a cable"), id: "p", version: 1, spendUsd: null }

function fakeRun(dir: string, minutes: number, opts: { mock?: boolean; usd?: number } = {}) {
	mkdirSync(dir, { recursive: true })
	const start = Date.parse("2026-11-09T10:00:00Z")
	const lines = [
		{ at: new Date(start).toISOString(), type: "run.started", payload: { mock: opts.mock ?? false } },
		...(minutes >= 0 ? [{ at: new Date(start + minutes * 60_000).toISOString(), type: "design.settled", payload: { settled: true } }] : []),
	]
	writeFileSync(join(dir, "trace.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
	if (opts.usd !== undefined) writeFileSync(join(dir, "usage.jsonl"), JSON.stringify({ at: "x", model: "gpt-5.4-mini", source: "agents", inputTokens: 1, cachedTokens: 0, outputTokens: 1, usd: opts.usd }) + "\n")
}

test("with no recorded runs there is no estimate", () => {
	const e = estimate(plan, tempDir())
	assert.equal(e.minutes, null)
	assert.equal(e.usd, null)
})

test("time comes from real runs only, boards in parallel; cost waits for three runs with usage", () => {
	const out = tempDir()
	fakeRun(join(out, "r1"), 40)
	fakeRun(join(out, "r2"), 50, { usd: 1 })
	fakeRun(join(out, "system-x", "boards", "logger"), 60, { usd: 2 })
	fakeRun(join(out, "m1"), 1, { mock: true, usd: 0 })
	fakeRun(join(out, "never"), -1)
	const e = estimate(plan, out)
	assert.deepEqual(e.minutes, [40, 60])
	assert.equal(e.usd, null, "only two real runs have usage")
	assert.match(e.basis, /3 recorded runs that settled \(1 more never settled\)/)
	fakeRun(join(out, "r3"), 45, { usd: 3 })
	const e2 = estimate(plan, out)
	assert.deepEqual(e2.usd, [2, 6], "per board 1–3 dollars, two boards")
})
