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
import { makeEvent } from "./events.ts"
import { Outbox } from "./outbox.ts"

export const APPROVAL_TIMEOUT_MS = 120_000

export class BringupState extends RuntimeState {
	readonly contract = new DesignContract()
	readonly artifacts: Artifacts = {}
	// Per artifact: the versions of its input fields it was last built from.
	readonly artifactInputs: Partial<Record<"board" | "enclosure" | "firmware", Partial<Record<FieldName, number>>>> = {}
	readonly roles = new Map<string, AgentRole>()
	readonly approvals = new ApprovalRegistry()
	// Set by the grounding check: settling then waits until it has grounded the current parts and pins.
	groundingEnabled = false
	groundedVersions: { parts: number; pins: number } | null = null
	// Per artifact: the error of its last build, if that build failed.
	readonly artifactFailures: Partial<Record<"board" | "enclosure" | "firmware", string>> = {}
	// The grounding check's latest findings: part pins and pin assignments that no datasheet source backs.
	groundingFindings: GroundingFinding[] = []

	constructor(
		readonly outDir: string,
		readonly approvalTimeoutMs: number = APPROVAL_TIMEOUT_MS,
	) {
		super()
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
export function safeRunLoop(agentId: string, message: string, input: InferenceInput, handler?: InterceptionHandler): void {
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
		rt().runLoop(agentId, message, input, handler)
	} catch (error) {
		emit(makeEvent("agent.halted", agentId, { agentId, error: String(error) }), agentId)
	}
}
