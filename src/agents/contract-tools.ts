import type { Tool } from "@mozaik-ai/core"
import { FIELDS, OWNERS, type AgentRole, type ContractValues, type FieldName } from "../contract/types.ts"
import { makeEvent, type Cause } from "../events.ts"
import { causeOf } from "./common.ts"
import { emit, state } from "../runtime.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { laidOut } from "../mechanics/solve.ts"
import { connectorsOntoEdges } from "../contract/consistency.ts"
import { connectorsForParts, ESTOP_PLUG_REF, robotRefs, SENSOR_PLUG_REF, START_PLUG_REF } from "../mechanics/refs.ts"

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
					// The sensor's plug has a fixed name (src/mechanics/refs.ts).
					const m = args.value as ContractValues["mechanics"]
					if (m?.sensor && m.sensor.connector !== SENSOR_PLUG_REF) {
						args = { ...args, value: { ...m, sensor: { ...m.sensor, connector: SENSOR_PLUG_REF } } as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, `the sensor's plug is always ${SENSOR_PLUG_REF} (fixed name), not ${m.sensor.connector}`].filter(Boolean).join("; ")
					}
					// The emergency stop's and the start cord's plugs too.
					const v = args.value as ContractValues["mechanics"]
					const safety = v?.safety
					if (safety && ((safety.estop && safety.estop.connector !== ESTOP_PLUG_REF) || (safety.start && safety.start.connector !== START_PLUG_REF))) {
						const was = [safety.estop && safety.estop.connector !== ESTOP_PLUG_REF ? `${safety.estop.connector} → ${ESTOP_PLUG_REF}` : null, safety.start && safety.start.connector !== START_PLUG_REF ? `${safety.start.connector} → ${START_PLUG_REF}` : null].filter(Boolean)
						args = { ...args, value: { ...v, safety: { ...safety, ...(safety.estop ? { estop: { ...safety.estop, connector: ESTOP_PLUG_REF } } : {}), ...(safety.start ? { start: { ...safety.start, connector: START_PLUG_REF } } : {}) } } as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, `the e-stop's plug is always ${ESTOP_PLUG_REF} and the start cord's ${START_PLUG_REF} (fixed names): ${was.join(", ")}`].filter(Boolean).join("; ")
					}
				}
				// A robot's plugs have fixed names: the parts list is renamed to them, and the connectors and pins follow below.
				let renames: Record<string, string> = {}
				if (args.field === "parts" && Array.isArray(args.value) && s.contract.get("motion")) {
					const r = robotRefs(args.value as ContractValues["parts"])
					if (Object.keys(r.renames).length) {
						renames = r.renames
						args = { ...args, value: r.parts as ContractValues[FieldName] }
						laidOutNote = `a robot's plugs have fixed names (sensor ${SENSOR_PLUG_REF}, motors JM1 and JM2): renamed ${Object.entries(renames).map(([a, b]) => `${a} to ${b}`).join(", ")}; the connectors and pins follow`
					}
				}
				// Connectors: one that runs past the end of its edge or overlaps another moves along its edge to fit (rover run
				// cc-rover-4 proposed J1 and JM2 overlapping across a corner, and left them so for revisions).
				// A robot's pin on a plug that has its fixed name: the START signal goes to the start cord's plug whatever ref the
				// proposal names (run cc-eurobot-10: START → J4.START while the plug was JS1).
				if (args.field === "pins" && Array.isArray(args.value) && s.contract.get("motion")) {
					const refs = new Set((s.contract.get("parts") ?? []).map((p) => p.ref))
					const pins = args.value as ContractValues["pins"]
					if (refs.has(START_PLUG_REF) && pins.some((p) => p.signal === "START" && p.partRef !== START_PLUG_REF && !refs.has(p.partRef))) {
						args = { ...args, value: pins.map((p) => (p.signal === "START" && !refs.has(p.partRef) ? { ...p, partRef: START_PLUG_REF } : p)) as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, `START goes to the start cord's plug ${START_PLUG_REF} (fixed name)`].filter(Boolean).join("; ")
					}
				}
				if (args.field === "connectors" && Array.isArray(args.value)) {
					const snap = s.contract.snapshot()
					// A robot's connector naming no part goes to the plug part that has no connector yet.
					if (snap.values.motion && snap.values.parts) {
						const named = connectorsForParts(args.value as ContractValues["connectors"], snap.values.parts)
						if (named) {
							const was = (args.value as ContractValues["connectors"]).map((k) => k.ref)
							laidOutNote = `connectors that named no part took the plug parts' names: ${named.map((k, i) => (k.ref !== was[i] ? `${was[i]} to ${k.ref}` : null)).filter(Boolean).join(", ")}`
							args = { ...args, value: named as ContractValues[FieldName] }
						}
					}
					const fitted = connectorsOntoEdges({ ...snap, values: { ...snap.values, connectors: args.value as ContractValues["connectors"] } })
					if (fitted) {
						const moved = fitted.filter((k) => !(args.value as ContractValues["connectors"]).some((b) => b.ref === k.ref && b.offsetMm === k.offsetMm)).map((k) => `${k.ref} to ${k.edge}@${k.offsetMm} mm`)
						args = { ...args, value: fitted as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, `moved along their edges to fit the board and clear each other: ${moved.join(", ")}`].filter(Boolean).join("; ")
					}
				}
				const result = s.contract.propose({ field: args.field, value: args.value, by: role, baseVersion: args.baseVersion, approvedBy })
				if (result.status === "applied") {
					// Why: the writer's own reason, the field before and after, and what woke it (or the approval it wrote under).
					const decision = args.approvalId && approvedBy ? s.approvals.decisionOf(args.approvalId) : undefined
					const cause: Cause | undefined = decision ? { kind: "approval", proposalId: args.approvalId!, approvedBy: decision.decidedBy ?? [decision.by], reason: decision.reason } : causeOf(self.id)
					emit(makeEvent("contract.changed", self.id, { field: args.field, version: result.version, revision: result.revision, by: role, reason: args.reason, before, after: args.value, ...(cause ? { cause } : {}) }), self.id)
					// A change another field must follow, written as its own change by that field's owner, with its reason.
					const follow = <G extends FieldName>(field: G, value: ContractValues[G], why: string): boolean => {
						const owner = OWNERS[field]
						const beforeF = s.contract.get(field) ?? null
						const r = s.contract.propose({ field, value, by: owner, baseVersion: s.contract.version(field), approvedBy: owner })
						if (r.status !== "applied") return false
						emit(makeEvent("contract.changed", self.id, { field, version: r.version, revision: r.revision, by: owner, reason: why, before: beforeF, after: value, cause: { kind: "field-changed", fields: [args.field] } }), self.id)
						return true
					}
					// A new outline: a connector it leaves past the end of its edge (or on another) moves along its edge to fit.
					if (args.field === "outline") {
						const beforeC = s.contract.get("connectors") ?? []
						const fitted = connectorsOntoEdges(s.contract.snapshot())
						if (fitted) {
							const moved = fitted.filter((k) => !beforeC.some((b) => b.ref === k.ref && b.offsetMm === k.offsetMm)).map((k) => `${k.ref} to ${k.edge}@${k.offsetMm} mm`)
							const o = args.value as ContractValues["outline"]
							if (follow("connectors", fitted, `the new ${o.widthMm}x${o.heightMm} mm outline left them past the end of their edge: moved ${moved.join(", ")}`))
								laidOutNote = `connectors follow the outline: moved ${moved.join(", ")}`
						}
					}
					// Renamed plugs: the connectors and pins that named the old refs take the new ones.
					if (Object.keys(renames).length) {
						const to = (ref: string) => renames[ref] ?? ref
						const why = `the parts' plugs took their fixed names (${Object.entries(renames).map(([a, b]) => `${a} to ${b}`).join(", ")})`
						const conns = s.contract.get("connectors")
						if (conns?.some((k) => renames[k.ref])) {
							const renamed = conns.map((k) => ({ ...k, ref: to(k.ref) }))
							follow("connectors", connectorsForParts(renamed, args.value as ContractValues["parts"]) ?? renamed, why)
						}
						const pins = s.contract.get("pins")
						if (pins?.some((p) => renames[p.partRef])) follow("pins", pins.map((p) => ({ ...p, partRef: to(p.partRef) })), why)
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
