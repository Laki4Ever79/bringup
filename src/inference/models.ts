import { DefaultInferenceRunner, type InferenceRunnerConfig } from "@mozaik-ai/core"
import { modelsFor, providerModel, resolveProvider } from "./providers.ts"
import { SafeRunner } from "./safe-runner.ts"
import type { AgentRole } from "../contract/types.ts"
import { ScriptedRunner, type Script } from "./scripted-runner.ts"
import { UsageRunner, type UsageRecord } from "./usage.ts"
import { CC_MODELS, ClaudeCodeRunner } from "./claude-code-runner.ts"
import { EstimateRunner } from "./estimate.ts"
import { TrimRunner } from "./trim.ts"
import { AnthropicCacheRunner } from "./anthropic-cache.ts"

// The architect plans the whole design and the reviewer judges it against the brief, so both get the strong model; the
// other roles use the fast one. Which provider and models: providers.ts (BRINGUP_AI, any provider).
export function modelFor(role: AgentRole, mock: boolean, env: Record<string, string | undefined> = process.env): string {
	if (mock) return `mock-${role}`
	if (resolveProvider(env)?.protocol === "claude-code") return env.BRINGUP_MODELS === "fast" || !(role === "architect" || role === "reviewer") ? CC_MODELS.fast : CC_MODELS.strong
	return providerModel(role === "architect" || role === "reviewer", env)
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
	// The API path: Claude models through AnthropicCacheRunner (prompt caching, which Mozaik 4.1.0 doesn't send), the rest
	// through Mozaik's own runner. TrimRunner asks it which models cache, so a trim never costs more than it saves.
	const cache = resolveProvider()?.protocol === "claude-code" ? null : new AnthropicCacheRunner(new DefaultInferenceRunner(modelsFor(), noValidation))
	const provider = cache ?? new ClaudeCodeRunner()
	// Every call's tokens and price go to onUsage (usage.jsonl); inside SafeRunner, so a failed call records nothing.
	return { runner: new SafeRunner(new TrimRunner(onUsage ? new UsageRunner(provider, onUsage, "agents") : provider, (m) => cache?.caches(m) ?? false), onFailure) }
}
