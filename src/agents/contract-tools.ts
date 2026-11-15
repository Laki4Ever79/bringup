import type { Tool } from "@mozaik-ai/core"
import { FIELDS, OWNERS, type AgentRole, type ContractValues, type FieldName } from "../contract/types.ts"
import { makeEvent, type Cause } from "../events.ts"
import { causeOf } from "./common.ts"
import { emit, state } from "../runtime.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { laidOut } from "../mechanics/solve.ts"
import { connectorsOntoEdges } from "../contract/consistency.ts"

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
				const approvedBy = args.approvalId ? s.approvals.approverOf(args.approvalId, args.field, role, JSON.stringify(args.value)) : undefined
				const before = s.contract.get(args.field) ?? null
				// A robot's mechanics: the parts are the engineer's, the layout the chassis solver's when the proposed one fails.
				let laidOutNote: string | null = null
				if (args.field === "mechanics") {
					const cat = defaultCheckCatalog()
					if (cat) {
						const l = laidOut(s.contract.snapshot(), args.value as ContractValues["mechanics"], cat)
						args = { ...args, value: l.mechanics as ContractValues[FieldName] }
						laidOutNote = l.note
					}
				}
				const result = s.contract.propose({ field: args.field, value: args.value, by: role, baseVersion: args.baseVersion, approvedBy })
				if (result.status === "applied") {
					// Why: the writer's own reason, the field before and after, and what woke it (or the approval it wrote under).
					const decision = args.approvalId && approvedBy ? s.approvals.decisionOf(args.approvalId) : undefined
					const cause: Cause | undefined = decision ? { kind: "approval", proposalId: args.approvalId!, approvedBy: decision.decidedBy ?? [decision.by], reason: decision.reason } : causeOf(self.id)
					emit(makeEvent("contract.changed", self.id, { field: args.field, version: result.version, revision: result.revision, by: role, reason: args.reason, before, after: args.value, ...(cause ? { cause } : {}) }), self.id)
					// A new outline: a connector it leaves past the end of its edge moves inward to fit, as its own change.
					if (args.field === "outline") {
						const fitted = connectorsOntoEdges(s.contract.snapshot())
						if (fitted) {
							const owner = OWNERS.connectors
							const beforeC = s.contract.get("connectors") ?? null
							const moved = fitted.filter((k) => !(beforeC ?? []).some((b) => b.ref === k.ref && b.offsetMm === k.offsetMm)).map((k) => `${k.ref} to ${k.edge}@${k.offsetMm} mm`)
							const r = s.contract.propose({ field: "connectors", value: fitted, by: owner, baseVersion: s.contract.version("connectors"), approvedBy: owner })
							if (r.status === "applied") {
								const reason = `the new ${(args.value as ContractValues["outline"]).widthMm}x${(args.value as ContractValues["outline"]).heightMm} mm outline left them past the end of their edge: moved ${moved.join(", ")}`
								emit(makeEvent("contract.changed", self.id, { field: "connectors", version: r.version, revision: r.revision, by: owner, reason, before: beforeC, after: fitted, cause: { kind: "field-changed", fields: ["outline"] } }), self.id)
								laidOutNote = `connectors follow the outline: moved ${moved.join(", ")} (connectors is now version ${r.version})`
							}
						}
					}
				}
				return laidOutNote && result.status === "applied" ? { ...result, note: laidOutNote } : result
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
				const field = state().approvals.fieldOf(args.proposalId)
				if (!field) return `unknown proposalId "${args.proposalId}"`
				if (OWNERS[field] !== role) return `not the owner of "${field}" (${OWNERS[field]} decides)`
				if (state().approvals.hasVoted(args.proposalId, role)) return "already voted on this proposal"
				const earlier = state().approvals.decisionOf(args.proposalId)
				if (earlier) return `already decided (${earlier.approved ? "approved" : "rejected"}: ${earlier.reason})`
				emit(makeEvent("change.decided", self.id, { proposalId: args.proposalId, approved: args.approve, by: role, reason: args.reason }), self.id)
				return "recorded"
			},
		},
	]
}
