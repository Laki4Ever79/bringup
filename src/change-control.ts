import { isDeepStrictEqual } from "node:util"
import {
	createHuman,
	FunctionCallItem,
	FunctionCallOutputItem,
	SituationSpecification,
	type ExecutableTransition,
	type InferenceInput,
	type InterceptionHandler,
	type SituationContext,
	type SituationHandler,
} from "@mozaik-ai/core"
import { OWNERS, type AgentRole, type ContractValues, type FieldName, type ProposalResult } from "./contract/types.ts"
import { isEvent, makeEvent } from "./events.ts"
import { emit, roleOf, state } from "./runtime.ts"
import { startTurn } from "./agents/common.ts"
import type { Agent } from "@mozaik-ai/core"

function readArgs(call: FunctionCallItem): { field?: FieldName; value?: unknown; baseVersion?: number; reason?: string; approvalId?: string } {
	try {
		return JSON.parse(call.args)
	} catch {
		return {}
	}
}

// Engineering change control on top of Mozaik interception: a contract change to a field the
// calling agent does not own is held mid-loop until the field's owner decides. Approved calls
// continue with an approval id; rejected ones go back to the model as the tool's output.
export class ChangeControl implements InterceptionHandler {
	constructor(private readonly agentId: string) {}

	isSatisfiedBy(transition: ExecutableTransition): boolean {
		if (transition.nextStateId !== "function_call") return false
		const { call } = transition.input as { call: FunctionCallItem }
		if (call.name !== "propose_contract_change") return false
		const { field, value, approvalId } = readArgs(call)
		const role = roleOf(this.agentId)
		if (field === undefined || role === undefined || OWNERS[field] === role) return false
		// Nothing to review when the value equals the current one; the tool reports "unchanged".
		if (isDeepStrictEqual(state().contract.get(field), value)) return false
		// A call resumed after approval (or retried with the approval after a stale base) goes through,
		// but only with the value that was approved.
		return !(approvalId && state().approvals.approverOf(approvalId, field, role, JSON.stringify(value)) === OWNERS[field])
	}

	async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
		const { call, inferenceInput } = transition.input as { call: FunctionCallItem; inferenceInput: InferenceInput }
		const args = readArgs(call)
		const requester = roleOf(this.agentId)!
		const s = state()
		// A value the contract would refuse goes straight back with the reason; the owner is never asked about it.
		const invalid = s.contract.validate({ field: args.field!, value: args.value as never, by: requester })
		if (invalid) {
			inferenceInput.context.addContextItems([call, FunctionCallOutputItem.create(call.callId, JSON.stringify({ status: "invalid", reason: invalid }))])
			return { nextStateId: "inference", input: inferenceInput }
		}
		const needsEngineer = s.engineerApproval
		const proposalId = s.approvals.open(args.field!, requester, JSON.stringify(args.value), needsEngineer)
		emit(makeEvent("change.proposed", this.agentId, { proposalId, field: args.field!, by: requester, reason: args.reason ?? "", needsEngineer }), this.agentId)

		const decision = await s.approvals.wait(proposalId, needsEngineer ? s.engineerTimeoutMs : s.approvalTimeoutMs)
		emit(makeEvent("change.resolved", this.agentId, { proposalId, approved: decision.approved, reason: decision.reason, decidedBy: decision.decidedBy ?? [decision.by] }), this.agentId)
		if (decision.approved) {
			// The owner decided against the contract as it is now, so the change applies on top of the
			// current version rather than failing as stale because the field moved while it was held.
			const baseVersion = s.contract.version(args.field!)
			const approved = FunctionCallItem.rehydrate({ callId: call.callId, name: call.name, args: JSON.stringify({ ...args, baseVersion, approvalId: proposalId }) })
			return { nextStateId: "function_call", input: { call: approved, inferenceInput } }
		}
		inferenceInput.context.addContextItems([call, FunctionCallOutputItem.create(call.callId, `rejected: ${decision.reason}`)])
		// Never return "idle" from an interception (Mozaik issue #113).
		return { nextStateId: "inference", input: inferenceInput }
	}
}

class EventIs extends SituationSpecification {
	constructor(private readonly test: (ctx: SituationContext) => boolean) {
		super()
	}
	isSatisfiedBy(ctx: SituationContext): boolean {
		return this.test(ctx)
	}
}

export function when(test: (ctx: SituationContext) => boolean): SituationSpecification {
	return new EventIs(test)
}

// Plain-code participant that routes owners' decisions to the held loops.
export function createChangeDesk() {
	return createHuman({
		name: "change-desk",
		capabilities: [],
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "change.decided")),
				processor: {
					apply: ({ event }) => {
						if (!isEvent(event, "change.decided")) return
						const { proposalId, approved, by, reason } = event.payload
						state().approvals.resolve(proposalId, { approved, by, reason })
					},
				},
			},
		],
	})
}

// Situation for an owning agent: a change to one of its fields was proposed, so take a turn to decide.
export function ownerReviewsChanges(role: AgentRole): SituationHandler {
	return {
		specification: when(({ event }) => isEvent(event, "change.proposed") && OWNERS[event.payload.field] === role),
		processor: {
			apply: ({ event, participant }) => {
				if (!isEvent(event, "change.proposed")) return
				const { proposalId, field, by, reason } = event.payload
				startTurn(
					participant as Agent,
					`Change request proposalId=${proposalId} from ${by}: change "${field}" because: ${reason}. ` +
						`Read the contract, then call decide_change with this proposalId.`,
				)
			},
		},
	}
}

export type HeldResult = ProposalResult | { status: "rejected"; reason: string }

// Change control for plain-code participants (the bench), which have no model loop to intercept: the same
// change.proposed → owner's decide_change → change.resolved path, then the write with the owner's approval.
// Plain code checks the value first, so the owner is never asked about a change the contract would refuse.
export async function proposeHeld<F extends FieldName>(p: { selfId: string; role: AgentRole; field: F; value: ContractValues[F]; reason: string }): Promise<HeldResult> {
	const s = state()
	const invalid = s.contract.validate({ field: p.field, value: p.value, by: p.role })
	if (invalid) return { status: "invalid", reason: invalid }
	if (isDeepStrictEqual(s.contract.get(p.field), p.value)) return { status: "unchanged", version: s.contract.version(p.field) }
	const valueKey = JSON.stringify(p.value)
	const needsEngineer = s.engineerApproval
	const proposalId = s.approvals.open(p.field, p.role, valueKey, needsEngineer)
	emit(makeEvent("change.proposed", p.selfId, { proposalId, field: p.field, by: p.role, reason: p.reason, needsEngineer }), p.selfId)
	const decision = await s.approvals.wait(proposalId, needsEngineer ? s.engineerTimeoutMs : s.approvalTimeoutMs)
	emit(makeEvent("change.resolved", p.selfId, { proposalId, approved: decision.approved, reason: decision.reason, decidedBy: decision.decidedBy ?? [decision.by] }), p.selfId)
	if (!decision.approved) return { status: "rejected", reason: decision.reason }
	// As for agents: the owner decided against the field as it is now, so apply on top of its current version.
	const approvedBy = s.approvals.approverOf(proposalId, p.field, p.role, valueKey)
	const result = s.contract.propose({ field: p.field, value: p.value, by: p.role, baseVersion: s.contract.version(p.field), approvedBy })
	if (result.status === "applied") emit(makeEvent("contract.changed", p.selfId, { field: p.field, version: result.version, revision: result.revision, by: p.role }), p.selfId)
	return result
}
