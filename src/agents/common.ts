import { createAgent, DeveloperMessageItem, ModelContext, type Agent, type InferenceInput, type SituationHandler, type Tool } from "@mozaik-ai/core"
import type { AgentRole } from "../contract/types.ts"
import type { Cause } from "../events.ts"
import { modelFor } from "../inference/models.ts"
import { join, safeRunLoop, state } from "../runtime.ts"
import { ChangeControl } from "../change-control.ts"
import { contractTools } from "./contract-tools.ts"
import { designFacts } from "./design-facts.ts"
import { existsSync, readFileSync } from "node:fs"
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

// Each turn starts from a fresh context holding the agent's instruction, so concurrent turns
// of one agent never share (and corrupt) a context.
export function inferenceInputFor(agent: Agent): InferenceInput {
	const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))
	return { model: models.get(agent.getId())!, context, tools: agent.getTools() }
}

// The cause of each agent's latest turn: its next contract write cites it. A tool call can't tell which of an
// agent's loops made it, so concurrent turns of one agent share the latest cause (rare: turns are short).
const causes = new Map<string, Cause>()
export const causeOf = (agentId: string): Cause | undefined => causes.get(agentId)

// The designers whose turns carry the design facts, so they see what the reviewer will judge them on.
export const FACT_ROLES: ReadonlySet<AgentRole> = new Set(["architect", "parts", "firmware"])

// The facts the reviewer judges on, recomputed from the contract as it is when the turn starts.
export function withDesignFacts(role: AgentRole | undefined, message: string): string {
	if (!role || !FACT_ROLES.has(role)) return message
	const s = state()
	const briefPath = joinPath(s.outDir, "brief.md")
	const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8") : ""
	const facts = designFacts(s.contract.snapshot(), brief)
	return `${message}\n\n# Design facts (computed from the current contract; the final brief review judges with the same facts)\n${facts.join("\n")}`
}

export function startTurn(agent: Agent, message: string, cause?: Cause): void {
	if (cause) causes.set(agent.getId(), cause)
	safeRunLoop(agent.getId(), withDesignFacts(state().roles.get(agent.getId()), message), inferenceInputFor(agent), new ChangeControl(agent.getId()))
}

const handled = new WeakMap<Agent, Set<string>>()

// Starts a turn unless this agent already handled the same situation (key), so repeated
// events about one contract version wake an agent once.
export function requestTurn(agent: Agent, key: string, message: string, cause?: Cause): void {
	const seen = handled.get(agent) ?? new Set<string>()
	handled.set(agent, seen)
	if (seen.has(key)) return
	seen.add(key)
	startTurn(agent, message, cause)
}
