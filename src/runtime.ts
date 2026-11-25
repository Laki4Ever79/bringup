import type { ArtifactKind } from "./events.ts"
import {
	defineRuntime,
	RuntimeState,
	type InferenceInput,
	type InferenceRunnerConfig,
	type InterceptionHandler,
	type Participant,
	type SemanticEvent,
} from "@mozaik-ai/core"
import { ApprovalRegistry } from "./approvals.ts"
import type { Artifacts } from "./contract/consistency.ts"
import { DesignContract } from "./contract/contract.ts"
import type { GroundingFinding } from "./contract/grounding.ts"
import type { AgentRole, FieldName } from "./contract/types.ts"
import { makeEvent, type ReviewFinding, type ReviewVerdict } from "./events.ts"
import { Outbox } from "./outbox.ts"
import { Steering } from "./runner/steer.ts"
import { SteerGate } from "./runner/steer-gate.ts"

// How long an owner has to decide a held change: 2 min, 5 on the Claude subscription, whose turns take about 20 s each
// (its second rover run, 15 Nov: two proposals timed out undecided and the run ended with their violations open).
export const APPROVAL_TIMEOUT_MS = process.env.BRINGUP_PROVIDER === "claude-code" ? 300_000 : 120_000

export class BringupState extends RuntimeState {
	readonly contract = new DesignContract()
	// Why the run stopped before its design could settle (the model provider's limit), or null.
	stopped: string | null = null
	readonly artifacts: Artifacts = {}
	// Per artifact: the versions of its input fields it was last built from.
	readonly artifactInputs: Partial<Record<ArtifactKind, Partial<Record<FieldName, number>>>> = {}
	readonly roles = new Map<string, AgentRole>()
	readonly approvals = new ApprovalRegistry()
	// The engineer request being forwarded right now (run.ts), so the turn it starts can name it as its cause.
	currentRequest: { id: string; text: string } | null = null
	// When on, every held change also needs the human engineer's approval (dashboard or decisions.jsonl).
	engineerApproval = false
	engineerTimeoutMs = 600_000
	// Set by the grounding check: settling then waits until it has grounded the current parts and pins.
	groundingEnabled = false
	groundedVersions: { parts: number; pins: number } | null = null
	// Per artifact: the error of its last build, if that build failed.
	readonly artifactFailures: Partial<Record<ArtifactKind, string>> = {}
	// The grounding check's latest findings: part pins and pin assignments that no datasheet source backs.
	groundingFindings: GroundingFinding[] = []
	// The brief review gate (set up by runDesign). round counts reviews started; results holds each verdict.
	review: {
		enabled: boolean
		maxRounds: number
		round: number
		results: { revision: number; round: number; verdict: ReviewVerdict; findings: ReviewFinding[] }[]
		missingVerdict: boolean
	} = { enabled: false, maxRounds: 1, round: 0, results: [], missingVerdict: false }

	// Pause, stop and redo, of the run or of one agent (runner/steer.ts).
	readonly steer = new Steering()

	constructor(
		readonly outDir: string,
		readonly approvalTimeoutMs: number = APPROVAL_TIMEOUT_MS,
	) {
		super()
		this.approvals.holdWhile = () => this.steer.anyHeld()
	}
}

type Runtime = ReturnType<typeof defineRuntime<BringupState>>

let current: Runtime | null = null
let outbox: Outbox | null = null

// A fresh Mozaik runtime per run. defineRuntime() allows one initializeRuntime per closure,
// so each run (and each test) gets its own closure.
export function startRuntime(state: BringupState, inferenceRunnerConfig: InferenceRunnerConfig | undefined, tracePath: string | null): Runtime {
	current = defineRuntime<BringupState>()
	current.initializeRuntime({ state, inferenceRunnerConfig })
	outbox = new Outbox((event, senderId) => current!.sendEvent(event, senderId), tracePath)
	return current
}

function rt(): Runtime {
	if (!current) throw new Error("runtime not started; call startRuntime first")
	return current
}

export function state(): BringupState {
	return rt().resolveRuntime().state
}

export function join(participant: Participant): void {
	rt().join(participant)
}

export function sendMessage(message: string, senderId: string): void {
	rt().sendMessage(message, senderId)
}

export function roleOf(participantId: string): AgentRole | undefined {
	return state().roles.get(participantId)
}

export function getOutbox(): Outbox {
	if (!outbox) throw new Error("outbox not initialized; call startRuntime first")
	return outbox
}

export function emit(event: SemanticEvent, senderId: string): void {
	getOutbox().emit(event, senderId)
}

let haltReporterInstalled = false

// Mozaik 4.1's runLoop does not catch loop errors (issue #114), so a crashed agent looks idle.
// Failures surface as unhandled rejections; report them as agent.halted events instead.
export function safeRunLoop(agentId: string, message: string, input: InferenceInput, handler?: InterceptionHandler, step?: { summary: string; redo: () => void }): void {
	if (!haltReporterInstalled) {
		haltReporterInstalled = true
		process.on("unhandledRejection", (reason) => {
			const error = reason instanceof Error ? reason.message : String(reason)
			console.error("[bringup] agent loop failed:", error)
			const reporter = current ? state().getParticipants()[0] : undefined
			if (reporter) emit(makeEvent("agent.halted", reporter.getId(), { agentId: "unknown", error }), reporter.getId())
		})
	}
	try {
		// Every loop goes through the steering gate: a paused or stopped agent waits or ends at its next step.
		const name = state().getParticipant(agentId)?.getManifest().name ?? agentId
		state().steer.register(name, "agent")
		rt().runLoop(agentId, message, input, new SteerGate(state().steer, name, handler, step))
	} catch (error) {
		emit(makeEvent("agent.halted", agentId, { agentId, error: String(error) }), agentId)
	}
}
