import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readSpend } from "../inference/usage.ts"
import type { Plan } from "./plan.ts"

// The plan screen's estimates, from real (non-scripted) board runs recorded under outRoot: a single run's folder, or a
// system's boards/<name>. Time: boards build in parallel, so a plan takes as long as one board (the range seen so far);
// the QEMU link test after is not counted. Cost: per board, times the plan's boards, once MIN_COST_RUNS real runs have
// usage.jsonl (cost tracking started 9 Nov 2026; older runs have none). Runs that never settled give no time; the basis
// line counts them so the range doesn't read better than it is.
export const MIN_COST_RUNS = 3

interface BoardRun {
	minutes: number | null
	usd: number | null
}

function boardRun(dir: string): BoardRun | null {
	let text: string
	try {
		text = readFileSync(join(dir, "trace.jsonl"), "utf8")
	} catch {
		return null
	}
	let start: number | null = null
	let settledAt: number | null = null
	for (const line of text.split("\n")) {
		if (!line.trim()) continue
		let e: { at?: string; type?: string; payload?: { mock?: boolean; settled?: boolean } }
		try {
			e = JSON.parse(line)
		} catch {
			continue
		}
		if (e.type === "run.started") {
			if (e.payload?.mock === true) return null
			start = Date.parse(e.at ?? "")
		}
		if (e.type === "design.settled" && e.payload?.settled === true && settledAt === null) settledAt = Date.parse(e.at ?? "")
	}
	if (start === null || Number.isNaN(start)) return null
	const minutes = settledAt !== null && !Number.isNaN(settledAt) ? Math.round((settledAt - start) / 60_000) : null
	const spend = readSpend(dir)
	return { minutes, usd: spend.calls > 0 && spend.unknownCalls === 0 ? spend.usd : null }
}

function recordedBoardRuns(outRoot: string): BoardRun[] {
	const out: BoardRun[] = []
	const entries = existsSync(outRoot) ? readdirSync(outRoot, { withFileTypes: true }) : []
	for (const e of entries) {
		if (!e.isDirectory() || e.name === "plans") continue
		const dir = join(outRoot, e.name)
		if (existsSync(join(dir, "system.json")) || existsSync(join(dir, "boards"))) {
			const boards = join(dir, "boards")
			for (const b of existsSync(boards) ? readdirSync(boards, { withFileTypes: true }) : []) if (b.isDirectory()) out.push(...[boardRun(join(boards, b.name))].filter((r): r is BoardRun => r !== null))
		} else {
			const r = boardRun(dir)
			if (r) out.push(r)
		}
	}
	return out
}

export function estimate(plan: Plan, outRoot: string): { minutes: [number, number] | null; usd: [number, number] | null; basis: string } {
	const runs = recordedBoardRuns(outRoot)
	const times = runs.map((r) => r.minutes).filter((m): m is number => m !== null)
	const costs = runs.map((r) => r.usd).filter((u): u is number => u !== null)
	const unsettled = runs.length - times.length
	const n = Math.max(1, plan.spec.boards.length)
	const minutes: [number, number] | null = times.length ? [Math.min(...times), Math.max(...times)] : null
	const usd: [number, number] | null = costs.length >= MIN_COST_RUNS ? [Math.min(...costs) * n, Math.max(...costs) * n] : null
	const basis = !times.length
		? "No real runs recorded yet, so no estimate."
		: `From ${times.length} recorded runs that settled${unsettled ? ` (${unsettled} more never settled)` : ""}; boards build in parallel. ${usd ? `Cost from ${costs.length} runs with cost data, per board × ${n}.` : `Cost: not enough runs with cost data yet (${costs.length} of ${MIN_COST_RUNS}).`}`
	return { minutes, usd, basis }
}
