import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { watchJsonl } from "./requests.ts"

export const DECISIONS_FILE = "decisions.jsonl"

export interface EngineerDecision {
	at: string
	proposalId: string
	approve: boolean
	reason: string
}

// Appends the human engineer's vote on a held change (dashboard Approve/Reject, or by hand).
export function appendDecision(outDir: string, d: { proposalId: string; approve: boolean; reason: string }): EngineerDecision {
	const decision = { at: new Date().toISOString(), ...d }
	appendFileSync(join(outDir, DECISIONS_FILE), JSON.stringify(decision) + "\n")
	return decision
}

export function watchDecisions(outDir: string, onDecision: (d: EngineerDecision) => void): { close(): void } {
	return watchJsonl(
		outDir,
		DECISIONS_FILE,
		(raw) => {
			const d = raw as Partial<EngineerDecision>
			if (typeof d.proposalId !== "string" || typeof d.approve !== "boolean") return null
			return { at: typeof d.at === "string" ? d.at : new Date().toISOString(), proposalId: d.proposalId, approve: d.approve, reason: typeof d.reason === "string" ? d.reason : "" }
		},
		onDecision,
	)
}
