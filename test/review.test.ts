import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DeveloperMessageItem, ModelMessageItem, UserMessageItem, type ContextItem } from "@mozaik-ai/core"
import { parseArgs } from "../src/main.ts"
import { ROOT, runDesign } from "../src/run.ts"
import { LOGGER_DESIGN, mockScripts } from "../src/inference/scripts.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { state } from "../src/runtime.ts"
import type { Env } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

// One runtime per process: let the previous run's loops wind down first.
afterEach(() => new Promise((r) => setTimeout(r, 300)))

const brief = readFileSync(join(ROOT, "briefs/logger.md"), "utf8")
// No tools at all: stubbed hardware, catalog-only grounding, no power simulation.
const bare: Env = { root: ROOT, tsci: null, kicad: null, python: null, pio: null }

type Finding = { severity: "blocker" | "major" | "minor"; fields: string[]; issue: string; suggestion: string }

const lastUserText = (items: ContextItem[]) => {
	const u = items.findLast((i) => i instanceof UserMessageItem) as UserMessageItem | undefined
	return u?.content.text ?? ""
}
const isFirstStep = (items: ContextItem[]) => items.at(-1) instanceof UserMessageItem

// A reviewer that gives the scripted verdicts in order, one per review, repeating the last one.
function reviewer(verdicts: { verdict: "pass" | "fail"; findings: Finding[] }[], seen: ContextItem[][] = []): Script {
	let n = 0
	return (items) => {
		if (!isFirstStep(items)) return [ModelMessageItem.rehydrate({ text: "review submitted" })]
		seen.push([...items])
		const v = verdicts[Math.min(n++, verdicts.length - 1)]
		return [toolCall("submit_review", v)]
	}
}

// The mock architect, plus a fix for review findings: it narrows the board to 45 mm.
function architectThatFixes(): Script {
	const base = mockScripts()["mock-architect"]
	return (items) => {
		if (lastUserText(items).startsWith("Review findings")) {
			if (!isFirstStep(items)) return [ModelMessageItem.rehydrate({ text: "fixed" })]
			const outline = state().contract.get("outline")!
			return [toolCall("propose_contract_change", { field: "outline", value: { ...outline, widthMm: 45 }, baseVersion: state().contract.version("outline"), reason: "review: narrower board" })]
		}
		return base(items)
	}
}

async function run(opts: { scripts?: Record<string, Script>; review?: boolean; maxReviewRounds?: number } = {}) {
	const outDir = tempDir()
	const result = await runDesign({ brief, mock: true, outDir, env: bare, noHardware: true, timeoutMs: 60_000, ...opts, scripts: { ...mockScripts(), ...opts.scripts } })
	const trace = readFileSync(join(outDir, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const report = readFileSync(join(outDir, "report.md"), "utf8")
	return { result, trace, report, reviews: trace.filter((e) => e.type === "review.completed").map((e) => e.payload) }
}

const major: Finding = { severity: "major", fields: ["outline"], issue: "50 mm is wider than the pocket case allows", suggestion: "narrow the board to 45 mm" }
const blocker: Finding = { severity: "blocker", fields: ["rails"], issue: "the LDO's quiescent current misses the 6-month target", suggestion: "pick a low-Iq LDO" }

test("the default mock reviewer passes and the verdict is in the report", { timeout: 90_000 }, async () => {
	const r = await run()
	assert.equal(r.result.settled, true)
	assert.equal(r.trace.filter((e) => e.type === "design.ready").length, 1)
	assert.deepEqual(r.reviews.map((x) => x.verdict), ["pass"])
	assert.equal(r.reviews[0].findings.length, 1)
	assert.equal(r.reviews[0].findings[0].severity, "minor")
	assert.match(r.report, /## Brief review/)
	assert.match(r.report, /Verdict: pass after 1 review/)
	const settledAt = r.trace.findIndex((e) => e.type === "design.settled")
	assert.ok(r.trace.findIndex((e) => e.type === "review.completed") < settledAt, "settles only after the review")
})

test("a failing review sends the finding to the field's owner, and the fixed design is reviewed again", { timeout: 90_000 }, async () => {
	const r = await run({ scripts: { "mock-reviewer": reviewer([{ verdict: "fail", findings: [major] }, { verdict: "pass", findings: [] }]), "mock-architect": architectThatFixes() } })
	assert.equal(r.result.settled, true)
	assert.deepEqual(r.reviews.map((x) => x.verdict), ["fail", "pass"])
	const outlineChanges = r.trace.filter((e) => e.type === "contract.changed" && e.payload.field === "outline")
	assert.equal(outlineChanges.at(-1).payload.by, "architect")
	assert.equal(JSON.parse(readFileSync(join(r.result.outDir, "contract.json"), "utf8")).values.outline.widthMm, 45)
	assert.ok(r.reviews[1].revision > r.reviews[0].revision, "the second review saw the changed design")
	assert.match(r.report, /Verdict: pass after 2 reviews/)
})

test("still failing after the last fix round: settles with the findings recorded, settled when no blocker", { timeout: 90_000 }, async () => {
	const r = await run({ scripts: { "mock-reviewer": reviewer([{ verdict: "fail", findings: [major] }]), "mock-architect": architectThatFixes() } })
	assert.deepEqual(r.reviews.map((x) => x.verdict), ["fail", "fail"])
	assert.equal(r.result.settled, true)
	assert.match(r.report, /Verdict: fail after 2 reviews/)
	assert.match(r.report, /major.*outline.*wider than the pocket case/)
})

test("still failing with a blocker after the last fix round: unsettled", { timeout: 90_000 }, async () => {
	const r = await run({ scripts: { "mock-reviewer": reviewer([{ verdict: "fail", findings: [blocker] }]), "mock-architect": architectThatFixes() } })
	assert.equal(r.result.settled, false)
	assert.equal(r.trace.findLast((e) => e.type === "design.settled").payload.settled, false)
	assert.match(r.report, /blocker.*rails.*quiescent current/)
})

test("an owner that changes nothing after a failing review ends the run with the findings", { timeout: 90_000 }, async () => {
	const r = await run({ scripts: { "mock-reviewer": reviewer([{ verdict: "fail", findings: [major] }]) } })
	assert.deepEqual(r.reviews.map((x) => x.verdict), ["fail"])
	assert.equal(r.result.settled, true)
	assert.match(r.report, /Verdict: fail after 1 review/)
})

test("a reviewer that never submits a verdict does not hang the run", { timeout: 90_000 }, async () => {
	const r = await run({ scripts: { "mock-reviewer": () => [ModelMessageItem.rehydrate({ text: "looks fine" })] } })
	assert.equal(r.reviews.length, 0)
	assert.equal(r.result.settled, true)
	assert.match(r.report, /no verdict/i)
})

test("--no-review skips the gate", { timeout: 90_000 }, async () => {
	const r = await run({ review: false })
	assert.equal(r.result.settled, true)
	assert.equal(r.trace.filter((e) => e.type === "design.ready" || e.type === "review.completed").length, 0)
	assert.match(r.report, /Brief review: skipped/)
	assert.equal((parseArgs([join(ROOT, "briefs/logger.md"), "--no-review"]) as { review: boolean }).review, false)
	assert.equal((parseArgs([join(ROOT, "briefs/logger.md")]) as { review: boolean }).review, true)
})

test("the reviewer sees only the brief, the contract and the check results, never another agent's turn", { timeout: 90_000 }, async () => {
	const seen: ContextItem[][] = []
	const r = await run({ scripts: { "mock-reviewer": reviewer([{ verdict: "pass", findings: [] }], seen) } })
	assert.equal(r.result.settled, true)
	assert.equal(seen.length, 1)
	const items = seen[0]
	assert.deepEqual(items.map((i) => i.constructor), [DeveloperMessageItem, UserMessageItem], "a fresh context: instruction plus one message")
	const text = lastUserText(items)
	assert.ok(text.includes(brief.trim().split("\n")[0]), "contains the brief")
	assert.ok(text.includes(`"widthMm": ${LOGGER_DESIGN.outline.widthMm}`), "contains the contract")
	assert.match(text, /power was not simulated/i)
	assert.match(text, /## Board-generated wiring \(added by the board generator, not in the contract\)/)
	assert.match(text, /## Part facts \(from the catalog\)\n- U1 ESP32-C3-MINI-1: 4 MB on-module flash/)
	assert.match(text, /5\.1k \(C25905\): USB-C CC1/)
	assert.match(text, /USB_DP: .*U1\.GPIO19/)
	// Words only the other agents wrote: their turn messages, model answers and proposal reasons.
	for (const other of ["contract drafted", "initial requirements from the brief", "parts from the catalog", "firmware drives a status LED", "Brief from the engineer", "pins are sufficient"]) {
		assert.ok(!text.includes(other), `reviewer saw another agent's text: "${other}"`)
	}
})

test("the reviewer gets peak, average and the battery-life arithmetic computed in code", { timeout: 90_000 }, async () => {
	const seen: ContextItem[][] = []
	const r = await run({ scripts: { "mock-reviewer": reviewer([{ verdict: "pass", findings: [] }], seen) } })
	const text = lastUserText(seen[0])
	assert.match(text, /Power budget \(computed in code/)
	assert.match(text, /3V3: peak 120 mA, average 0\.0\d+ mA/)
	assert.match(text, /Duty cycle: \d+ ms active every 300 s/)
	assert.match(text, /Estimated battery life: 500 mAh \/ .* = \d+ days vs target 180 days/)
	assert.match(r.report, /^- Estimated battery life: \d+ days vs target 180 days/m)
})
