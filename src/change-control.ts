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
import { OWNERS, type AgentRole, type FieldName } from "./contract/types.ts"
import { isEvent, makeEvent } from "./events.ts"
import { emit, roleOf, state } from "./runtime.ts"
import { startTurn } from "./agents/common.ts"
import type { Agent } from "@mozaik-ai/core"

function readArgs(call: FunctionCallItem): { field?: FieldName; reason?: string; approvalId?: string } {
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
		const { field, approvalId } = readArgs(call)
		const role = roleOf(this.agentId)
		if (field === undefined || role === undefined || OWNERS[field] === role) return false
		// A call resumed after approval (or retried with the approval after a stale base) goes through.
		return !(approvalId && state().approvals.approverOf(approvalId, field, role) === OWNERS[field])
	}

	async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
		const { call, inferenceInput } = transition.input as { call: FunctionCallItem; inferenceInput: InferenceInput }
		const args = readArgs(call)
		const requester = roleOf(this.agentId)!
		const s = state()
		const proposalId = s.approvals.open(args.field!, requester)
		emit(makeEvent("change.proposed", this.agentId, { proposalId, field: args.field!, by: requester, reason: args.reason ?? "" }), this.agentId)

		const decision = await s.approvals.wait(proposalId, s.approvalTimeoutMs)
		if (decision.approved) {
			const approved = FunctionCallItem.rehydrate({ callId: call.callId, name: call.name, args: JSON.stringify({ ...args, approvalId: proposalId }) })
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
