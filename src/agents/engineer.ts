import { createHuman, type Human } from "@mozaik-ai/core"
import { makeEvent } from "../events.ts"
import { emit } from "../runtime.ts"
import type { EngineerDecision } from "../runner/decisions.ts"

// The human engineer as a Mozaik participant: sends the brief and change requests, and votes on held
// changes when engineer approval is on. Votes go through the same change.decided event the agents use.
export function createEngineer(): Human & { decide(d: Pick<EngineerDecision, "proposalId" | "approve" | "reason">): void } {
	const engineer = createHuman({ name: "engineer", capabilities: [], handlers: [] })
	return Object.assign(engineer, {
		decide(d: Pick<EngineerDecision, "proposalId" | "approve" | "reason">) {
			emit(makeEvent("change.decided", engineer.getId(), { proposalId: d.proposalId, approved: d.approve, by: "engineer", reason: d.reason }), engineer.getId())
		},
	})
}
