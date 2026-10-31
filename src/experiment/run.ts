import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { CHANGES } from "./changes.ts"
import { runTrial, WORKERS } from "./harness.ts"
import { renderMarkdown, shippedMismatches, type TrialResult } from "./score.ts"
import { detectEnvironment } from "../tools/env.ts"
import { ROOT } from "../run.ts"

// Every change through arm A (and arm C), arm B scored from arm A's artifacts; writes <outDir>/results.json and the
// markdown table.
export async function runExperiment(opts: { outDir: string; docsPath: string; noHardware?: boolean; only?: string[]; armC?: boolean; log?: (line: string) => void }): Promise<TrialResult[]> {
	const log = opts.log ?? (() => {})
	const env = await detectEnvironment(ROOT)
	const changes = CHANGES.filter((c) => !opts.only || opts.only.includes(c.id))
	const results: TrialResult[] = []
	const runs: Record<string, unknown> = {}
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
		mkdirSync(opts.outDir, { recursive: true })
		writeFileSync(join(opts.outDir, "results.json"), JSON.stringify({ date, tools: opts.noHardware ? "stub" : "real", workers: WORKERS, results, runs }, null, 2))
		mkdirSync(dirname(opts.docsPath), { recursive: true })
		writeFileSync(opts.docsPath, renderMarkdown(results, { tools: opts.noHardware ? "stub" : "real", date, resultsPath: relative(ROOT, join(opts.outDir, "results.json")) }))
	}
	return results
}
