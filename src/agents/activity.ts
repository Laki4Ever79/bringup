import { createHuman, type Human } from "@mozaik-ai/core"
import { makeEvent, type Payloads } from "../events.ts"
import { emit, roleOf, state } from "../runtime.ts"

export type ActivityPhase = Payloads["agent.activity"]["phase"]

const TURN_CHARS = 200
const TOOL_CHARS = 160
const ANSWER_CHARS = 300
const VALUE_CHARS = 60

// One line, at most n characters.
function clip(text: string, n: number): string {
	const flat = text.replace(/\s+/g, " ").trim()
	return flat.length > n ? flat.slice(0, n - 1) + "…" : flat
}

function parse(json: string): unknown {
	try {
		return JSON.parse(json)
	} catch {
		return undefined
	}
}

function short(value: unknown): string {
	if (Array.isArray(value)) return `${value.length} items`
	const json = JSON.stringify(value) ?? String(value)
	return json.length > VALUE_CHARS ? `{${Object.keys(value as object).length} keys}` : json
}

// A tool call's arguments in a few words: the field and version for contract changes, never the whole value.
export function summarizeArgs(name: string, argsJson: string): string {
	const a = parse(argsJson) as Record<string, any> | undefined
	if (!a || typeof a !== "object") return clip(argsJson, TOOL_CHARS)
	switch (name) {
		case "propose_contract_change":
			return `${a.field} ← ${short(a.value)} (base v${a.baseVersion})${a.reason ? `: ${a.reason}` : ""}`
		case "decide_change":
			return `${a.approve ? "approve" : "reject"} ${a.proposalId}`
		case "submit_review":
			return `${a.verdict}, ${(a.findings ?? []).length} finding${(a.findings ?? []).length === 1 ? "" : "s"}`
		default:
			return Object.entries(a)
				.map(([k, v]) => `${k}=${typeof v === "string" ? v : short(v)}`)
				.join(", ")
	}
}

// A tool's result in a few words: the ProposalResult status, the contract revision, or a count.
export function summarizeResult(text: string): string {
	const r = parse(text) as any
	if (Array.isArray(r)) return `${r.length} result${r.length === 1 ? "" : "s"}`
	if (r && typeof r === "object") {
		if (r.status === "applied") return `applied (v${r.version}, rev ${r.revision})`
		if (r.status === "stale") return `stale (current v${r.current})`
		if (r.status === "not-owner") return `not-owner (${r.owner} decides)`
		if (r.status === "invalid" && typeof r.reason === "string") return clip(`invalid: ${r.reason}`, ANSWER_CHARS)
		if (typeof r.status === "string") return r.status
		if (r.recorded === true) return `recorded${typeof r.revision === "number" ? ` (rev ${r.revision})` : ""}`
		if (typeof r.revision === "number" && r.values) return `contract at rev ${r.revision}`
		return clip(text, TOOL_CHARS)
	}
	return clip(text, TOOL_CHARS)
}

// Pure: one Mozaik loop event to a lane update, or null for events the lanes don't show.
export function describeLoopEvent(type: string, p: any): { phase: ActivityPhase; text: string } | null {
	switch (type) {
		case "message_received.started":
			return { phase: "turn", text: clip(String(p?.content ?? ""), TURN_CHARS) }
		case "inference.started":
			return { phase: "thinking", text: "thinking…" }
		case "function_call.started": {
			const name = String(p?.call?.name ?? "tool")
			const args = summarizeArgs(name, String(p?.call?.args ?? "{}"))
			return { phase: "tool", text: clip(args ? `${name}: ${args}` : name, TOOL_CHARS) }
		}
		case "function_call.completed":
			return { phase: "tool-result", text: summarizeResult(String(p?.output?.text ?? "")) }
		case "model.answer":
			return { phase: "answer", text: clip(String(p?.answer?.content?.text ?? ""), ANSWER_CHARS) }
		case "interception.started": {
			const c = p?.input?.call
			return { phase: "held", text: clip(`held for approval: ${c?.name ?? p?.nextStateId}${c ? ` ${(parse(c.args) as any)?.field ?? ""}` : ""}`, TOOL_CHARS) }
		}
		case "interception.finished": {
			// Turned back to the model (the owner rejected it, or the contract would refuse it): the tool output it got.
			const items = p?.nextStateId === "inference" ? p?.input?.context?.getItems?.() : undefined
			const told = Array.isArray(items) ? items.at(-1)?.output?.text : undefined
			if (typeof told === "string") return { phase: "released", text: clip(`returned: ${summarizeResult(told)}`, ANSWER_CHARS) }
			return { phase: "released", text: `released: ${p?.input?.call?.name ?? p?.nextStateId}` }
		}
		default:
			return null
	}
}

// Plain-code participant that turns Mozaik's own loop events (which never reach trace.jsonl) into compact
// agent.activity events, so the dashboard can show what each agent is doing right now. Only agents with a
// role are tracked; consecutive "thinking" updates for one agent collapse into one.
export function createActivityParticipant(): Human {
	const self = { id: "" }
	const last = new Map<string, ActivityPhase>()
	const participant = createHuman({
		name: "activity",
		capabilities: [],
		handlers: [
			{
				specification: { isSatisfiedBy: () => true } as never,
				processor: {
					apply: ({ event }) => {
						const role = roleOf(event.producerId)
						if (!role) return
						const d = describeLoopEvent(event.type as string, event.payload)
						if (!d) return
						if (d.phase === "thinking" && last.get(event.producerId) === "thinking") return
						last.set(event.producerId, d.phase)
						const name = state().getParticipant(event.producerId)?.getManifest().name ?? role
						const at = event.occurredAt instanceof Date ? event.occurredAt.toISOString() : new Date().toISOString()
						emit(makeEvent("agent.activity", self.id, { agentId: event.producerId, role, name, phase: d.phase, text: d.text, at }), self.id)
					},
				},
			},
		],
	})
	self.id = participant.getId()
	return participant
}
