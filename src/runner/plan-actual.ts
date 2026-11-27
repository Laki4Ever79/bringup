// The plan a paid run was approved on, kept with the run (run-plan.json), and what the run then took: its minutes (the
// trace's first event to its last) and its model spend (usage.jsonl). The report, the page's History and the MCP read
// planVsActual to say "planned 20–40 min, $0.50–$1.20; took 33 min, $0.84", so estimates can be checked against runs.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { readSpend } from "../inference/usage.ts"
import { readRunPlan, type RunPlan } from "../system/plan-gate.ts"

export const RUN_PLAN_FILE = "run-plan.json"

// Keeps the approved plan with the run (a copy: the plan store may be cleaned). No-op for an unknown id.
export function recordRunPlan(outDir: string, planId: string): boolean {
	const p = readRunPlan(planId)
	if (!p) return false
	mkdirSync(outDir, { recursive: true })
	writeFileSync(join(outDir, RUN_PLAN_FILE), JSON.stringify(p, null, "\t"))
	return true
}

export interface PlanVsActual {
	planId: string
	planned: { minutes: [number, number] | null; usd: [number, number] | null; runTime: string | null }
	actual: { minutes: number | null; usd: number | null; calls: number }
	// "within", "over" or "under" the planned range, per figure; null when either side is unknown.
	minutes: "within" | "over" | "under" | null
	usd: "within" | "over" | "under" | null
}

// The run's minutes: from its trace's first event to its last (a run staying up for changes: so far).
export function runMinutes(dir: string): number | null {
	const f = join(dir, "trace.jsonl")
	if (!existsSync(f)) return null
	const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim())
	const at = (l: string | undefined) => { try { return Date.parse(JSON.parse(l ?? "").at) } catch { return NaN } }
	const a = at(lines[0]), b = at(lines.at(-1))
	return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round(((b - a) / 60_000) * 10) / 10 : null
}

const against = (v: number | null, r: [number, number] | null) => (v === null || !r ? null : v > r[1] ? "over" : v < r[0] ? "under" : "within")

export function planVsActual(dir: string): PlanVsActual | null {
	const f = join(dir, RUN_PLAN_FILE)
	if (!existsSync(f)) return null
	let p: RunPlan
	try { p = JSON.parse(readFileSync(f, "utf8")) as RunPlan } catch { return null }
	const spend = readSpend(dir)
	const usd = spend.usd === null ? null : Math.round(spend.usd * 10000) / 10000
	const minutes = runMinutes(dir)
	const planned = { minutes: p.estimate?.minutes ?? null, usd: p.estimate?.usd ?? null, runTime: p.runTime ?? null }
	return { planId: p.id, planned, actual: { minutes, usd, calls: spend.calls }, minutes: against(minutes, planned.minutes), usd: against(usd, planned.usd) }
}

const money = (n: number) => `$${n.toFixed(2)}`
const range = (r: [number, number] | null, f: (n: number) => string) => (!r ? "no estimate" : r[0] === r[1] ? f(r[0]) : `${f(r[0])}–${f(r[1])}`)

// One line for people: "Planned 20–40 min, $0.50–$1.20; took 33 min, $0.84 (time within the plan; cost within the plan)."
export function planVsActualText(v: PlanVsActual): string {
	const took = [v.actual.minutes === null ? "time unknown" : `${Math.round(v.actual.minutes)} min`, v.actual.usd === null ? (v.actual.calls ? "cost unknown" : "$0.00") : money(v.actual.usd)].join(", ")
	const verdicts = [v.minutes && `time ${v.minutes === "within" ? "within the plan" : `${v.minutes} the plan`}`, v.usd && `cost ${v.usd === "within" ? "within the plan" : `${v.usd} the plan`}`].filter(Boolean)
	return `Planned ${range(v.planned.minutes, (n) => `${Math.round(n)}`)}${v.planned.minutes ? " min" : ""}, ${range(v.planned.usd, money)}; took ${took}${verdicts.length ? ` (${verdicts.join("; ")})` : ""}.`
}
