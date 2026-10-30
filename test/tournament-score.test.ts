import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { rankRows, scoreRun, scoreboardMarkdown, type ScoreRow } from "../src/tournament/score.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

// jlcsearch's exact LCSC lookup, answered from a price table.
function fakeFetch(prices: Record<string, number>): typeof fetch {
	return (async (input: string | URL | Request) => {
		const q = new URL(String(input)).searchParams.get("q") ?? ""
		const components = q in prices ? [{ lcsc: Number(q.slice(1)), stock: 100, price: prices[q] }] : []
		return new Response(JSON.stringify({ components }))
	}) as typeof fetch
}

const PRICES = { C2838502: 3, C2909890: 1.75, C2286: 0.01 }

function fakeRun(opts: { settled?: boolean; violations?: number; widthMm?: number; trace?: object[]; run?: object | null } = {}): string {
	const dir = tempDir()
	const c = fixtureContract()
	c.values.outline!.widthMm = opts.widthMm ?? 50
	writeFileSync(join(dir, "contract.json"), JSON.stringify(c))
	writeFileSync(join(dir, "variant.json"), JSON.stringify({ name: "narrow", constraint: "Board must be at most 40 mm wide." }))
	writeFileSync(
		join(dir, "report.md"),
		`# Bringup report\n\nStatus: ${opts.settled === false ? "UNSETTLED" : "settled"} at contract revision 6\nViolations: ${opts.violations ?? 0}\n`,
	)
	const trace = opts.trace ?? [
		{ seq: 0, at: "2026-10-31T10:00:00.000Z", type: "contract.changed", payload: {} },
		{ seq: 1, at: "2026-10-31T10:00:01.000Z", type: "change.proposed", payload: {} },
		{ seq: 2, at: "2026-10-31T10:00:02.000Z", type: "change.decided", payload: { approved: true } },
		{ seq: 3, at: "2026-10-31T10:00:20.000Z", type: "design.settled", payload: { settled: true } },
	]
	writeFileSync(join(dir, "trace.jsonl"), trace.map((l) => JSON.stringify(l)).join("\n") + "\n")
	if (opts.run !== null) writeFileSync(join(dir, "run.json"), JSON.stringify(opts.run ?? { startedAt: "2026-10-31T09:59:58.000Z", endedAt: "2026-10-31T10:00:25.500Z", exitCode: 0 }))
	return dir
}

test("scoreRun reads outcome, size and coordination from a run directory", async () => {
	const row = await scoreRun(fakeRun(), { fetch: fakeFetch(PRICES) })
	assert.equal(row.variant, "narrow")
	assert.equal(row.settled, true)
	assert.equal(row.violations, 0)
	assert.equal(row.boardAreaMm2, 1500)
	assert.equal(row.revisions, 6)
	assert.equal(row.heldChanges, 1)
	assert.equal(row.wallSeconds, 27.5)
	assert.equal(row.exitCode, 0)
})

test("BOM cost sums live unit prices and counts parts it could not price", async () => {
	const row = await scoreRun(fakeRun(), { fetch: fakeFetch(PRICES) })
	assert.equal(row.bomCostUsd, 4.76)
	assert.equal(row.unpricedParts, 0)
	const partial = await scoreRun(fakeRun(), { fetch: fakeFetch({ C2838502: 3 }) })
	assert.equal(partial.bomCostUsd, 3)
	assert.equal(partial.unpricedParts, 2)
})

test("BOM cost is null when offline", async () => {
	const offline = (async () => { throw new TypeError("fetch failed") }) as typeof fetch
	const row = await scoreRun(fakeRun(), { fetch: offline })
	assert.equal(row.bomCostUsd, null)
	assert.equal(row.unpricedParts, 3)
})

test("without run.json, wall time is the trace's span", async () => {
	const row = await scoreRun(fakeRun({ run: null }), { fetch: fakeFetch(PRICES) })
	assert.equal(row.wallSeconds, 20)
	assert.equal(row.exitCode, null)
})

test("a run that crashed before writing anything scores as unsettled", async () => {
	const dir = tempDir()
	mkdirSync(dir, { recursive: true })
	const row = await scoreRun(dir, { fetch: fakeFetch(PRICES) })
	assert.equal(row.settled, false)
	assert.equal(row.violations, null)
	assert.equal(row.boardAreaMm2, null)
	assert.equal(row.bomCostUsd, null)
})

const row = (variant: string, r: Partial<ScoreRow>): ScoreRow => ({
	variant, settled: true, violations: 0, bomCostUsd: 5, unpricedParts: 0, boardAreaMm2: 1500, revisions: 6, heldChanges: 1, wallSeconds: 20, exitCode: 0, startedAt: null, endedAt: null, dir: "/x", ...r,
})

test("ranking: settled first, then fewest violations, then cost, then area", () => {
	const ranked = rankRows([
		row("unsettled", { settled: false, violations: 0, bomCostUsd: 1 }),
		row("violating", { violations: 2, bomCostUsd: 1 }),
		row("pricey", { bomCostUsd: 9 }),
		row("big", { boardAreaMm2: 2000 }),
		row("small", { boardAreaMm2: 1200 }),
		row("unpriced", { bomCostUsd: null }),
	])
	assert.deepEqual(ranked.map((r) => r.variant), ["small", "big", "pricey", "unpriced", "violating", "unsettled"])
})

test("scoreboard markdown lists every variant in rank order", () => {
	const md = scoreboardMarkdown([row("small", { boardAreaMm2: 1200 }), row("big", { bomCostUsd: null })])
	const lines = md.split("\n").filter((l) => l.startsWith("| ") && /\| (small|big) \|/.test(l))
	assert.equal(lines.length, 2)
	assert.match(lines[0], /^\| 1 \| small \|/)
	assert.match(md, /—/, "a missing cost shows as a dash")
})
