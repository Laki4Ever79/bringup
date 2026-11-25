import { createAgent, createHuman, DeveloperMessageItem, ModelContext, type Agent, type InferenceInput, type SituationHandler, type Tool } from "@mozaik-ai/core"
import { OWNERS, type AgentRole } from "../contract/types.ts"
import type { Cause } from "../events.ts"
import { modelFor } from "../inference/models.ts"
import { join, safeRunLoop, state } from "../runtime.ts"
import { ChangeControl, when } from "../change-control.ts"
import { isEvent } from "../events.ts"
import { contractTools } from "./contract-tools.ts"
import { designFacts } from "./design-facts.ts"
import { existsSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { roleContextId } from "../inference/usage.ts"
import { join as joinPath } from "node:path"

const models = new Map<string, string>()

// Creates and joins an agent for a role, with the contract tools plus any extra tools.
export function createRoleAgent(opts: { role: AgentRole; instruction: string; handlers: SituationHandler[]; tools?: Tool[]; mock: boolean; name?: string }): Agent {
	const self = { id: "" }
	const agent = createAgent({
		name: opts.name ?? opts.role,
		capabilities: [],
		instruction: opts.instruction,
		tools: [...contractTools(opts.role, self), ...(opts.tools ?? [])],
		handlers: opts.handlers,
	})
	self.id = agent.getId()
	state().roles.set(agent.getId(), opts.role)
	models.set(agent.getId(), modelFor(opts.role, opts.mock))
	join(agent)
	return agent
}

// A fresh context whose id carries the role, so usage.jsonl names the agent behind each call.
export const roleContext = (role: string) => ModelContext.rehydrate({ id: roleContextId(role, randomUUID()), items: [] })

// Each turn starts from a fresh context holding the agent's instruction, so concurrent turns
// of one agent never share (and corrupt) a context.
export function inferenceInputFor(agent: Agent): InferenceInput {
	const context = roleContext(state().roles.get(agent.getId()) ?? "agent").addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))
	return { model: models.get(agent.getId())!, context, tools: agent.getTools() }
}

// The cause of each agent's latest turn: its next contract write cites it. A tool call can't tell which of an
// agent's loops made it, so concurrent turns of one agent share the latest cause (rare: turns are short).
const causes = new Map<string, Cause>()
export const causeOf = (agentId: string): Cause | undefined => causes.get(agentId)

// The designers whose turns carry the design facts, so they see what the reviewer will judge them on: every role that
// owns a field. Derived, so a new designer gets them too (the ml and test agents were told "the design facts give the
// numbers" but were left off a hand-kept list).
export const FACT_ROLES: ReadonlySet<AgentRole> = new Set(Object.values(OWNERS))

// The facts the reviewer judges on, recomputed from the contract as it is when the turn starts.
export function withDesignFacts(role: AgentRole | undefined, message: string): string {
	if (!role || !FACT_ROLES.has(role)) return message
	const s = state()
	const briefPath = joinPath(s.outDir, "brief.md")
	const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8") : ""
	const facts = designFacts(s.contract.snapshot(), brief)
	return `${message}\n\n# Design facts (computed from the current contract; the final brief review judges with the same facts)\n${facts.join("\n")}`
}

// One live turn per agent (lead-2's 20b analysis, 23 Nov 2026: the parts agent ran 29 turns in one Eurobot run, mostly
// "Consistency violations at revision N", each woken while its earlier turns still ran, all resending the same
// transcript). A turn ends with its model.answer (or agent.halted); what arrives meanwhile waits:
//   - a request that must not be lost (the brief, an engineer's change request) is queued and runs in order;
//   - a wake about the design's state (violations, review findings, grounding, a field changed) waits as one pending
//     follow-up per kind, the latest replacing the earlier, and runs only if it still holds when the turn ends;
//   - a decide_change prompt starts at once: the proposer's turn is held until the owner decides, so queueing it behind
//     a turn that is itself held on a proposal would deadlock.
// A turn older than TURN_STALE_MS no longer blocks: a loop that died without an event (Mozaik #114) can't hold an
// agent forever.
export const TURN_STALE_MS = 10 * 60_000

interface Pending { message: string; cause?: Cause; stillHolds?: () => boolean }
interface Turns { live: number[]; queue: Pending[]; pending: Map<string, Pending> }
const turnsOf = new Map<string, Turns>()
const tracked = new WeakSet<object>()
type Check = { revision: number; violations: { kind: string; affects: AgentRole[] }[] }
const lastCheck = new WeakMap<object, Check>()

// This runtime's latest consistency check (not a draining one): what a pending violations follow-up checks before it
// runs. Per runtime: a tournament runs several designs in one process.
export const latestCheck = (): Check | undefined => lastCheck.get(state() as object)

const turns = (id: string): Turns => {
	let t = turnsOf.get(id)
	if (!t) turnsOf.set(id, (t = { live: [], queue: [], pending: new Map() }))
	return t
}
const busy = (t: Turns) => {
	const now = Date.now()
	t.live = t.live.filter((at) => now - at < TURN_STALE_MS)
	return t.live.length > 0
}

// One listener per runtime: a turn's end releases what waited for it.
function track(): void {
	const s = state() as object
	if (tracked.has(s)) return
	tracked.add(s)
	join(
		createHuman({
			name: "turns",
			capabilities: [],
			handlers: [
				{
					specification: when(({ event }) => event.type === "model.answer" || isEvent(event, "agent.halted") || (isEvent(event, "consistency.checked") && !event.payload.draining)),
					processor: {
						apply: ({ event }) => {
							if (isEvent(event, "consistency.checked")) {
								lastCheck.set(state() as object, { revision: event.payload.revision, violations: event.payload.violations })
								return
							}
							const id = isEvent(event, "agent.halted") ? event.payload.agentId : event.producerId
							const t = turnsOf.get(id)
							if (!t || !t.live.length) return
							t.live.shift()
							if (busy(t)) return
							const agent = state().getParticipant(id) as Agent | undefined
							if (agent) next(agent, t)
						},
					},
				},
			],
		}),
	)
}

// What runs when an agent's turn ends: the oldest queued request, else every pending follow-up that still holds, as one turn.
function next(agent: Agent, t: Turns): void {
	const queued = t.queue.shift()
	if (queued) return launch(agent, queued.message, queued.cause)
	const ready = [...t.pending.values()].filter((p) => p.stillHolds?.() ?? true)
	t.pending.clear()
	if (ready.length) launch(agent, ready.map((p) => p.message).join("\n\n"), ready[0].cause)
}

function launch(agent: Agent, message: string, cause?: Cause): void {
	track()
	if (cause) causes.set(agent.getId(), cause)
	turns(agent.getId()).live.push(Date.now())
	// Redo (runner/steer.ts) reruns this step as a fresh turn: its own context, the design facts as they are then.
	const step = { summary: message.split("\n")[0], redo: () => startTurn(agent, message, cause, { now: true }) }
	safeRunLoop(agent.getId(), withDesignFacts(state().roles.get(agent.getId()), message), inferenceInputFor(agent), new ChangeControl(agent.getId()), step)
}

// A turn that must run: now if the agent is free, else queued behind its live turn. `now` starts it regardless (a
// decide_change prompt: see above).
export function startTurn(agent: Agent, message: string, cause?: Cause, opts: { now?: boolean } = {}): void {
	const t = turns(agent.getId())
	if (!opts.now && busy(t)) {
		t.queue.push({ message, cause })
		return
	}
	launch(agent, message, cause)
}

const handled = new WeakMap<Agent, Set<string>>()

// Starts a turn unless this agent already handled the same situation (key), so repeated events about one contract
// version wake an agent once. While the agent is in a turn, the wake waits as the pending follow-up of its kind (the
// cause's kind), replacing an earlier one; `stillHolds` is asked when the turn ends (violations: still open?).
export function requestTurn(agent: Agent, key: string, message: string, cause?: Cause, stillHolds?: () => boolean): void {
	const seen = handled.get(agent) ?? new Set<string>()
	handled.set(agent, seen)
	if (seen.has(key)) return
	seen.add(key)
	const t = turns(agent.getId())
	if (busy(t)) {
		t.pending.set(cause?.kind ?? "wake", { message, cause, stillHolds })
		return
	}
	launch(agent, message, cause)
}
