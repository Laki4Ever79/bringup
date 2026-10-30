import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { ContractSnapshot } from "../contract/types.ts"
import { searchParts } from "../tools/parts-search.ts"

export interface ScoreRow {
	variant: string
	settled: boolean
	// null when the run never wrote a report (it crashed or was killed)
	violations: number | null
	// Sum of live unit prices; null when no part could be priced (offline)
	bomCostUsd: number | null
	unpricedParts: number
	boardAreaMm2: number | null
	revisions: number | null
	heldChanges: number
	wallSeconds: number | null
	exitCode: number | null
	startedAt: string | null
	endedAt: string | null
	dir: string
}

// Written by the tournament runner next to each run's own output.
export interface RunRecord {
	startedAt: string
	endedAt: string
	exitCode: number
}

function readJson<T>(path: string): T | null {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null
}

function readTrace(path: string): { at: string; type: string }[] {
	if (!existsSync(path)) return []
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { at: string; type: string })
}

async function bomCost(snapshot: ContractSnapshot | null, fetchImpl?: typeof fetch): Promise<{ bomCostUsd: number | null; unpricedParts: number }> {
	const parts = snapshot?.values.parts ?? []
	let total = 0
	let priced = 0
	for (const part of parts) {
		const live = (await searchParts(part.role, { fetch: fetchImpl })).find((c) => c.lcsc === part.lcsc)
		if (live?.priceUsd != null) {
			total += live.priceUsd
			priced++
		}
	}
	return { bomCostUsd: priced > 0 ? Math.round(total * 1e4) / 1e4 : null, unpricedParts: parts.length - priced }
}

// Scores one finished run from what it left on disk: contract.json, report.md, trace.jsonl, plus the
// tournament's variant.json and run.json. Missing files score as a failed run rather than throwing.
export async function scoreRun(outDir: string, opts: { fetch?: typeof fetch } = {}): Promise<ScoreRow> {
	const variant = readJson<{ name: string }>(join(outDir, "variant.json"))?.name ?? basename(outDir)
	const snapshot = readJson<ContractSnapshot>(join(outDir, "contract.json"))
	const report = existsSync(join(outDir, "report.md")) ? readFileSync(join(outDir, "report.md"), "utf8") : ""
	const trace = readTrace(join(outDir, "trace.jsonl"))
	const run = readJson<RunRecord>(join(outDir, "run.json"))
	const outline = snapshot?.values.outline
	const violations = /^Violations: (\d+)/m.exec(report)?.[1]
	const span = (from: string | undefined, to: string | undefined) => (from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : null)
	return {
		variant,
		settled: /^Status: settled/m.test(report),
		violations: violations === undefined ? null : Number(violations),
		...(await bomCost(snapshot, opts.fetch)),
		boardAreaMm2: outline ? outline.widthMm * outline.heightMm : null,
		revisions: snapshot?.revision ?? null,
		heldChanges: trace.filter((e) => e.type === "change.proposed").length,
		wallSeconds: run ? span(run.startedAt, run.endedAt) : span(trace[0]?.at, trace.at(-1)?.at),
		exitCode: run?.exitCode ?? null,
		startedAt: run?.startedAt ?? null,
		endedAt: run?.endedAt ?? null,
		dir: outDir,
	}
}

// null sorts after any number.
const ascending = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity)

// Settled designs first, then fewest violations, then cheapest BOM, then smallest board.
export function rankRows(rows: ScoreRow[]): ScoreRow[] {
	return [...rows].sort(
		(a, b) =>
			Number(b.settled) - Number(a.settled) ||
			ascending(a.violations, b.violations) ||
			ascending(a.bomCostUsd, b.bomCostUsd) ||
			ascending(a.boardAreaMm2, b.boardAreaMm2),
	)
}

const show = (x: number | null, unit = "") => (x === null ? "—" : `${x}${unit}`)

export function scoreboardMarkdown(rows: ScoreRow[]): string {
	const lines = [
		"# Tournament scoreboard",
		"",
		"Ranked by: settled, then fewest violations, then BOM cost, then board area.",
		"",
		"| # | Variant | Settled | Violations | BOM (USD) | Board (mm²) | Revisions | Held changes | Wall (s) |",
		"|---|---|---|---|---|---|---|---|---|",
		...rankRows(rows).map(
			(r, i) =>
				`| ${i + 1} | ${r.variant} | ${r.settled ? "yes" : "no"} | ${show(r.violations)} | ${show(r.bomCostUsd)}${r.unpricedParts ? ` (${r.unpricedParts} unpriced)` : ""} | ${show(r.boardAreaMm2)} | ${show(r.revisions)} | ${r.heldChanges} | ${show(r.wallSeconds)} |`,
		),
		"",
	]
	return lines.join("\n")
}
