import { checkConsistency, type Artifacts, type Violation } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import type { ArtifactKind } from "../events.ts"

export interface TrialResult {
	change: string
	label: string
	receiver: ArtifactKind
	// Contract + situations: from the change to design.settled (including the 1.5 s quiet window), who did work.
	armA: { ms: number; woken: string[]; workers: number; violations: Violation[]; settled: boolean }
	// No shared contract: the same real checkers on what would have shipped.
	armB: { shipped: Violation[] }
	// Arm A with the builds awaited one after another.
	armC?: { ms: number; settled: boolean }
}

// Arm B: only the receiving domain rebuilt from the changed design; every other domain shipped what it had built
// from its own copy of the design before the change. The same checks as arm A, against the changed design.
export function shippedMismatches<K extends ArtifactKind>(truth: ContractSnapshot, base: Artifacts, receiver: K, receiverArtifact: Artifacts[K]): Violation[] {
	return checkConsistency(truth, { ...base, [receiver]: receiverArtifact })
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const cell = (s: string) => s.replace(/\|/g, "\\|")

export function renderMarkdown(results: TrialResult[], meta: { tools: "real" | "stub"; date: string; resultsPath?: string }): string {
	const hasC = results.some((r) => r.armC)
	const head = ["Change", "Arm A: consistent again", "Arm A: woken", "Arm A: violations at end", ...(hasC ? ["Arm C: builds one at a time"] : []), "Arm B: heard by", "Arm B: mismatches shipped"]
	const rows = results.map((r) => [
		r.label,
		r.armA.settled ? secs(r.armA.ms) : `not settled (${secs(r.armA.ms)})`,
		`${r.armA.woken.length} of ${r.armA.workers} (${r.armA.woken.join(", ")})`,
		String(r.armA.violations.length),
		...(hasC ? [r.armC ? (r.armC.settled ? secs(r.armC.ms) : `not settled (${secs(r.armC.ms)})`) : "–"] : []),
		r.receiver,
		r.armB.shipped.length === 0 ? "0" : `${r.armB.shipped.length}: ${r.armB.shipped.map((v) => v.message).join("; ")}`,
	])
	const table = [head, head.map(() => "---"), ...rows].map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n")
	const shipped = results.reduce((n, r) => n + r.armB.shipped.length, 0)
	const left = results.reduce((n, r) => n + r.armA.violations.length, 0)
	return `# Experiment: one change, the whole design follows

Run ${meta.date} with \`npm run experiment\`${meta.tools === "stub" ? " --no-hardware (stub builders)" : " (real builders: tscircuit + KiCad, build123d, PlatformIO)"}. Raw numbers: \`${meta.resultsPath ?? "out/experiment/results.json"}\`.

Across ${results.length} changes: arm A ended with ${left} violation(s); arm B would have shipped ${shipped} cross-domain mismatch(es).

${table}

**Method.** The models are scripted (the keyless mock agents); the tools are real${meta.tools === "stub" ? " in normal runs, but this run used stub builders" : ""}. Each trial starts from a freshly settled
logger design (briefs/logger.md). The change's contract writes are then made by the fields' owners, exactly as the
agents' propose_contract_change tool makes them. **Arm A** is the normal runtime: the shared contract plus Mozaik
situations. Its time runs from the first write until the consistency participant settles, and that includes its 1.5 s
quiet window. "Woken" counts the participants that did work after the change: an agent turn, a build or a grounding
pass. **Arm B** is a simulated "every team works from its own copy" baseline. Only the domain that received the change
rebuilds (its artifact is the one arm A's builder produced from the same contract), and every other domain ships what
it had built before the change. The same plain-code checks as arm A then run against the changed design. A mismatch no
checker looks for counts as 0, not as a pass. The part check (each part's MPN on the board against the parts list) arrived
with the LDO-swap trial; the LDO-swap and button trials were rerun with it. The other four changes don't touch the parts
list, so it couldn't change their arm B. **Arm C** is arm A with the builders made to take turns, for a
parallel-versus-sequential wall-clock on the same change. Each cell is one run on one laptop, and timings vary
from run to run (the tools share the CPU), so read the times as tens of seconds, not exact. Arms B and C are switches for the experiment only; runs never
use them.
`
}
