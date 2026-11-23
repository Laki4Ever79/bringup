import { DefaultInferenceRunner, supportedModels, type InferenceRunnerConfig } from "@mozaik-ai/core"
import { SafeRunner } from "./safe-runner.ts"
import type { AgentRole } from "../contract/types.ts"
import { ScriptedRunner, type Script } from "./scripted-runner.ts"
import { UsageRunner, type UsageRecord } from "./usage.ts"
import { CC_MODELS, ClaudeCodeRunner } from "./claude-code-runner.ts"
import { EstimateRunner } from "./estimate.ts"
import { TrimRunner } from "./trim.ts"

const MODELS = {
	// The event's Claude credit (build.jigjoy.ai/credits) serves Sonnet 4.6 and Haiku 4.5 through
	// a gateway set by ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL.
	anthropic: { strong: "claude-sonnet-4-6", fast: "claude-haiku-4-5" },
	openai: { strong: "gpt-5.4", fast: "gpt-5.4-mini" },
}

// The architect plans the whole design and the reviewer judges it against the brief, so both get the
// strong model; the other roles use the fast one.
export function modelFor(role: AgentRole, mock: boolean, env: Record<string, string | undefined> = process.env): string {
	if (mock) return `mock-${role}`
	// The Claude subscription this machine's Claude Code uses (claude-code-runner.ts): development runs at no API cost.
	if (env.BRINGUP_PROVIDER === "claude-code") return env.BRINGUP_MODELS === "fast" || !(role === "architect" || role === "reviewer") ? CC_MODELS.fast : CC_MODELS.strong
	// OpenAI by default; the event credit (Claude Sonnet/Haiku only) is opt-in or the fallback when it is the only key.
	const provider = env.BRINGUP_PROVIDER === "openai" || env.BRINGUP_PROVIDER === "anthropic" ? env.BRINGUP_PROVIDER : env.OPENAI_API_KEY ? "openai" : env.ANTHROPIC_API_KEY ? "anthropic" : "openai"
	// BRINGUP_MODELS=fast: every role on the fast model (about a third of a run's cost; for development runs under a
	// spend cap, 15 Nov 2026). The default keeps the strong model for the architect and the reviewer.
	if (env.BRINGUP_MODELS === "fast") return MODELS[provider].fast
	return role === "architect" || role === "reviewer" ? MODELS[provider].strong : MODELS[provider].fast
}

// Mock runs swap in the scripted runner; real runs use Mozaik's default runner and built-in models.
export function inferenceConfig(
	mock: boolean,
	scripts: Record<string, Script> = {},
	onFailure: (model: string, error: string) => void = (model, error) => console.error(`[bringup] ${model} inference failed: ${error}`),
	onUsage?: (r: UsageRecord) => void,
): InferenceRunnerConfig {
	// Stale tool results are trimmed before every call (trim.ts), in mock runs too so they see what a real call sends.
	if (mock) {
		const est = process.env.BRINGUP_ESTIMATE_TOKENS
		return { runner: new TrimRunner(est ? new EstimateRunner(new ScriptedRunner(scripts), est) : new ScriptedRunner(scripts)) }
	}
	// Mozaik does not export its input validator; the provider rejects invalid requests anyway,
	// and SafeRunner turns that rejection into a message instead of a dead loop.
	const noValidation = { validate: () => {} } as unknown as ConstructorParameters<typeof DefaultInferenceRunner>[1]
	const provider = process.env.BRINGUP_PROVIDER === "claude-code" ? new ClaudeCodeRunner() : new DefaultInferenceRunner(supportedModels, noValidation)
	// Every call's tokens and price go to onUsage (usage.jsonl); inside SafeRunner, so a failed call records nothing.
	return { runner: new SafeRunner(new TrimRunner(onUsage ? new UsageRunner(provider, onUsage, "agents") : provider), onFailure) }
}
