import { SemanticEvent } from "@mozaik-ai/core"
import type { Violation } from "./contract/consistency.ts"
import type { GroundingFinding } from "./contract/grounding.ts"
import type { AgentRole, FieldName } from "./contract/types.ts"

export type ArtifactKind = "board" | "enclosure" | "firmware"

export interface ReviewFinding {
	severity: "blocker" | "major" | "minor"
	fields: FieldName[]
	issue: string
	suggestion: string
}

export type ReviewVerdict = "pass" | "fail"

export interface Payloads {
	"contract.changed": { field: FieldName; version: number; revision: number; by: AgentRole }
	"change.proposed": { proposalId: string; field: FieldName; by: AgentRole; reason: string }
	"change.decided": { proposalId: string; approved: boolean; by: AgentRole; reason: string }
	"artifact.ready": { kind: ArtifactKind; revision: number }
	"artifact.failed": { kind: ArtifactKind; revision: number; error: string }
	"consistency.checked": { revision: number; violations: Violation[] }
	"grounding.checked": { revision: number; findings: GroundingFinding[] }
	// The design is consistent and quiet; the brief reviewer judges it before it settles.
	"design.ready": { revision: number; round: number }
	"review.completed": { revision: number; verdict: ReviewVerdict; findings: ReviewFinding[] }
	"design.settled": { revision: number; settled: boolean }
	"agent.halted": { agentId: string; error: string }
	// What an agent is doing right now, from Mozaik's loop events (agents/activity.ts). For the dashboard lanes.
	"agent.activity": {
		agentId: string
		role: AgentRole
		name: string
		phase: "turn" | "thinking" | "tool" | "tool-result" | "answer" | "held" | "released"
		text: string
		at: string
	}
}

export type EventType = keyof Payloads

export function makeEvent<T extends EventType>(type: T, producerId: string, payload: Payloads[T]): SemanticEvent<T, Payloads[T]> {
	return SemanticEvent.create(type, producerId, payload)
}

// Narrowing helper for situation specifications.
export function isEvent<T extends EventType>(event: SemanticEvent, type: T): event is SemanticEvent<T, Payloads[T]> {
	return event.type === type
}
