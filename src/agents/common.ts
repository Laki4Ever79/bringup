import { createAgent, DeveloperMessageItem, ModelContext, type Agent, type InferenceInput, type SituationHandler, type Tool } from "@mozaik-ai/core"
import type { AgentRole } from "../contract/types.ts"
import { modelFor } from "../inference/models.ts"
import { join, safeRunLoop, state } from "../runtime.ts"
import { ChangeControl } from "../change-control.ts"
import { contractTools } from "./contract-tools.ts"

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

export function startTurn(agent: Agent, message: string): void {
	safeRunLoop(agent.getId(), message, inferenceInputFor(agent), new ChangeControl(agent.getId()))
}

const handled = new WeakMap<Agent, Set<string>>()

// Starts a turn unless this agent already handled the same situation (key), so repeated
// events about one contract version wake an agent once.
export function requestTurn(agent: Agent, key: string, message: string): void {
	const seen = handled.get(agent) ?? new Set<string>()
	handled.set(agent, seen)
	if (seen.has(key)) return
	seen.add(key)
	startTurn(agent, message)
}
