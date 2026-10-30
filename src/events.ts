import { SemanticEvent } from "@mozaik-ai/core"
import type { Violation } from "./contract/consistency.ts"
import type { GroundingFinding } from "./contract/grounding.ts"
import type { DrcSummary } from "./tools/drc.ts"
import type { AgentRole, FieldName } from "./contract/types.ts"

export type ArtifactKind = "board" | "enclosure" | "firmware"

export interface ReviewFinding {
	severity: "blocker" | "major" | "minor"
	fields: FieldName[]
	issue: string
	suggestion: string
}

export type ReviewVerdict = "pass" | "fail"

// "fake" and "replay" are badged on the dashboard and never propose to the contract.
export type BenchSourceName = "real" | "fake" | "replay"

// One point of the bench's live stream: a meter sample (mA) or a DUT telemetry line (IMU, tilt, LED).
export interface BenchSample {
	at: number
	mA?: number
	ax?: number
	ay?: number
	az?: number
	tilt?: number
	tC?: number
	led?: number
}

export interface BenchCheck {
	name: "boot" | "imu" | "led" | "battery"
	pass: boolean
	detail: string
}

export interface Payloads {
	// The run's options, first thing, so a dashboard can show what is switched off.
	"run.started": { review: boolean; engineerApproval: boolean; noHardware: boolean; bench: boolean }
	"contract.changed": { field: FieldName; version: number; revision: number; by: AgentRole }
	"change.proposed": { proposalId: string; field: FieldName; by: AgentRole; reason: string; needsEngineer: boolean }
	// The final outcome of a held change (votes are change.decided), timeouts included.
	"change.resolved": { proposalId: string; approved: boolean; reason: string; decidedBy: string[] }
	"change.decided": { proposalId: string; approved: boolean; by: AgentRole; reason: string }
	// drc: the board build's KiCad DRC against the fab's rules, when it ran.
	"artifact.ready": { kind: ArtifactKind; revision: number; drc?: DrcSummary }
	"artifact.failed": { kind: ArtifactKind; revision: number; error: string }
	// The newest compiled firmware booted in Espressif's QEMU (agents/emulator.ts). bootRevision is the contract
	// revision the firmware printed on serial, null if it never got that far. Not an artifact: it never blocks settling.
	"firmware.booted": { revision: number; booted: boolean; bootRevision: number | null; serialTail: string }
	"consistency.checked": { revision: number; violations: Violation[] }
	"grounding.checked": { revision: number; findings: GroundingFinding[] }
	// The design is consistent and quiet; the brief reviewer judges it before it settles.
	"design.ready": { revision: number; round: number }
	"review.completed": { revision: number; verdict: ReviewVerdict; findings: ReviewFinding[] }
	"design.settled": { revision: number; settled: boolean }
	"agent.halted": { agentId: string; error: string }
	// The live hardware bench (agents/bench.ts, docs/design/bench.md). Post-settle: none of these hold up settling.
	"bench.connected": { source: BenchSourceName; ports: { dut: string | null; fixture: string | null; telemetry: string | null }; meter: boolean }
	"bench.flashing": { revision: number; stage: "build" | "connect" | "write" | "boot"; pct: number }
	"bench.flashed": { revision: number; ok: boolean; stage?: string; ms: number; error?: string; simulated?: boolean }
	// Batched every 250 ms; revision is the firmware revision the board last booted (null before a boot).
	"bench.telemetry": { revision: number | null; source: BenchSourceName; samples: BenchSample[] }
	// rail is null when no single rail can be the one that feeds the MCU; the bench then proposes nothing.
	"bench.measured": {
		revision: number
		rail: string | null
		cycles: number
		awakeMs: number
		chargeUc: number
		floorMa: number
		averageMa: number
		estimateMa: number | null
		sleepUa: number
		source: BenchSourceName
		// Battery life with the measured average in place of the rail's, and what it is computed from.
		days: number | null
		targetDays: number | null
		capacityMah: number | null
		regulatorIqUa: number
	}
	"bench.verdict": { revision: number; pass: boolean; source: BenchSourceName; checks: BenchCheck[] }
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
