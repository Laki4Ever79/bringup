import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { CHANGES } from "./changes.ts"
import { runTrial, WORKERS } from "./harness.ts"
import { renderMarkdown, shippedMismatches, type TrialResult } from "./score.ts"
import { detectEnvironment } from "../tools/env.ts"
import { ROOT } from "../run.ts"

// Every change through arm A (and arm C), arm B scored from arm A's artifacts; writes the results (default
// <outDir>/results.json) and the markdown table. With `only`, the rerun trials replace theirs in the saved results and
// the others are kept, in the order of CHANGES.
export async function runExperiment(opts: { outDir: string; docsPath: string; resultsPath?: string; noHardware?: boolean; only?: string[]; armC?: boolean; log?: (line: string) => void }): Promise<TrialResult[]> {
	const log = opts.log ?? (() => {})
	const env = await detectEnvironment(ROOT)
	const changes = CHANGES.filter((c) => !opts.only || opts.only.includes(c.id))
	const resultsPath = opts.resultsPath ?? join(opts.outDir, "results.json")
	const saved = opts.only && existsSync(resultsPath) ? (JSON.parse(readFileSync(resultsPath, "utf8")) as { results: TrialResult[]; runs: Record<string, unknown> }) : null
	const kept = (saved?.results ?? []).filter((r) => !changes.some((c) => c.id === r.change))
	const results: TrialResult[] = []
	const runs: Record<string, unknown> = Object.fromEntries(Object.entries(saved?.runs ?? {}).filter(([id]) => !changes.some((c) => c.id === id)))
	const order = (id: string) => {
		const i = CHANGES.findIndex((c) => c.id === id)
		return i < 0 ? CHANGES.length : i
	}
	for (const change of changes) {
		log(`${change.id}: arm A`)
		const a = await runTrial({ change, arm: "A", outDir: join(opts.outDir, change.id, "A"), noHardware: opts.noHardware, env })
		const shipped = shippedMismatches(a.truth, a.baseArtifacts, change.receiver, a.finalArtifacts[change.receiver])
		const result: TrialResult = { change: change.id, label: change.label, receiver: change.receiver, armA: { ms: a.ms, woken: a.woken, workers: WORKERS.length, violations: a.violations, settled: a.settled }, armB: { shipped } }
		runs[change.id] = { A: { baseMs: a.baseMs, changeRevisions: a.changeRevisions, laterRevisions: a.laterRevisions } }
		log(`${change.id}: A ${a.settled ? "settled" : "UNSETTLED"} in ${a.ms} ms, woke ${a.woken.join(", ")}; B ships ${shipped.length}`)
		if (opts.armC) {
			log(`${change.id}: arm C`)
			const c = await runTrial({ change, arm: "C", outDir: join(opts.outDir, change.id, "C"), noHardware: opts.noHardware, env })
			result.armC = { ms: c.ms, settled: c.settled }
			;(runs[change.id] as Record<string, unknown>).C = { baseMs: c.baseMs, violations: c.violations.length }
			log(`${change.id}: C ${c.settled ? "settled" : "UNSETTLED"} in ${c.ms} ms`)
		}
		results.push(result)
		// Written after every trial, so a long real-tools run leaves its numbers so far.
		const date = new Date().toISOString().slice(0, 10)
		const all = [...kept, ...results].sort((a, b) => order(a.change) - order(b.change))
		mkdirSync(dirname(resultsPath), { recursive: true })
		writeFileSync(resultsPath, JSON.stringify({ date, tools: opts.noHardware ? "stub" : "real", workers: WORKERS, results: all, runs }, null, 2))
		mkdirSync(dirname(opts.docsPath), { recursive: true })
		writeFileSync(opts.docsPath, renderMarkdown(all, { tools: opts.noHardware ? "stub" : "real", date, resultsPath: relative(ROOT, resultsPath) }))
	}
	return results
}
