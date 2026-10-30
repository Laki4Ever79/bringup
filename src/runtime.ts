import { defineRuntime, RuntimeState, type InferenceInput, type InterceptionHandler } from "@mozaik-ai/core"
import type { Artifacts } from "./contract/consistency.ts"
import { DesignContract } from "./contract/contract.ts"
import type { AgentRole } from "./contract/types.ts"
import { makeEvent } from "./events.ts"
import { Outbox } from "./outbox.ts"

export class BringupState extends RuntimeState {
	readonly contract = new DesignContract()
	readonly artifacts: Artifacts = {}
	readonly roles = new Map<string, AgentRole>()

	constructor(readonly outDir: string) {
		super()
	}
}

export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendMessage, sendEvent, runLoop } =
	defineRuntime<BringupState>()

export function roleOf(participantId: string): AgentRole | undefined {
	return resolveRuntime().state.roles.get(participantId)
}

let outbox: Outbox | null = null

export function initOutbox(tracePath: string | null): Outbox {
	outbox = new Outbox((event, senderId) => sendEvent(event, senderId), tracePath)
	return outbox
}

export function getOutbox(): Outbox {
	if (!outbox) {
		throw new Error("outbox not initialized; call initOutbox first")
	}
	return outbox
}

let haltReporterInstalled = false

// Mozaik 4.1's runLoop does not catch loop errors (issue #114), so a crashed agent looks idle.
// Failures surface as unhandled rejections; report them as agent.halted events instead.
export function safeRunLoop(agentId: string, message: string, input: InferenceInput, handler?: InterceptionHandler): void {
	if (!haltReporterInstalled) {
		haltReporterInstalled = true
		process.on("unhandledRejection", (reason) => {
			const error = reason instanceof Error ? reason.message : String(reason)
			const reporter = [...resolveRuntime().state.getParticipants()][0]
			if (reporter) {
				getOutbox().emit(makeEvent("agent.halted", reporter.getId(), { agentId: "unknown", error }), reporter.getId())
			}
			console.error("[bringup] agent loop failed:", error)
		})
	}
	try {
		runLoop(agentId, message, input, handler)
	} catch (error) {
		getOutbox().emit(makeEvent("agent.halted", agentId, { agentId, error: String(error) }), agentId)
	}
}
