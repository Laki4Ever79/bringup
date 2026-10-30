import type { Tool } from "@mozaik-ai/core"
import { FIELDS, type AgentRole, type ContractValues, type FieldName } from "../contract/types.ts"
import { makeEvent } from "../events.ts"
import { emit, state } from "../runtime.ts"

// Tools every agent gets for reading and changing the shared design contract.
// `self.id` is filled in once the agent exists, so events carry the agent as producer.
export function contractTools(role: AgentRole, self: { id: string }): Tool[] {
	return [
		{
			type: "function",
			name: "read_contract",
			description: "Read the current design contract: every field with its value and version.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			strict: false,
			invoke: async () => state().contract.snapshot(),
		},
		{
			type: "function",
			name: "propose_contract_change",
			description:
				"Replace one contract field. baseVersion must be the field's current version. Changes to fields you do not own are held until their owner approves.",
			parameters: {
				type: "object",
				properties: {
					field: { type: "string", enum: [...FIELDS] },
					value: { description: "The complete new value for the field." },
					baseVersion: { type: "integer" },
					reason: { type: "string" },
					approvalId: { type: "string" },
				},
				required: ["field", "value", "baseVersion", "reason"],
			},
			strict: false,
			invoke: async (args: { field: FieldName; value: ContractValues[FieldName]; baseVersion: number; reason: string; approvalId?: string }) => {
				const s = state()
				const approvedBy = args.approvalId ? s.approvals.approverOf(args.approvalId, args.field, role) : undefined
				const result = s.contract.propose({ field: args.field, value: args.value, by: role, baseVersion: args.baseVersion, approvedBy })
				if (result.status === "applied") {
					emit(makeEvent("contract.changed", self.id, { field: args.field, version: result.version, revision: result.revision, by: role }), self.id)
				}
				return result
			},
		},
		{
			type: "function",
			name: "decide_change",
			description: "Approve or reject a held change request to a field you own.",
			parameters: {
				type: "object",
				properties: { proposalId: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } },
				required: ["proposalId", "approve", "reason"],
			},
			strict: false,
			invoke: async (args: { proposalId: string; approve: boolean; reason: string }) => {
				if (!state().approvals.fieldOf(args.proposalId)) return `unknown proposalId "${args.proposalId}"`
				emit(makeEvent("change.decided", self.id, { proposalId: args.proposalId, approved: args.approve, by: role, reason: args.reason }), self.id)
				return "recorded"
			},
		},
	]
}
