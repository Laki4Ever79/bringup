import { DefaultInferenceRunner, supportedModels, type InferenceRunnerConfig } from "@mozaik-ai/core"
import { SafeRunner } from "./safe-runner.ts"
import type { AgentRole } from "../contract/types.ts"
import { ScriptedRunner, type Script } from "./scripted-runner.ts"

const MODELS = {
	// The event's Claude credit (build.jigjoy.ai/credits) serves Sonnet 4.6 and Haiku 4.5 through
	// a gateway set by ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL.
	anthropic: { strong: "claude-sonnet-4-6", fast: "claude-haiku-4-5" },
	openai: { strong: "gpt-5.4", fast: "gpt-5.4-mini" },
}

// The architect plans the whole design, so it gets the strong model; the other roles use the fast one.
export function modelFor(role: AgentRole, mock: boolean, env: Record<string, string | undefined> = process.env): string {
	if (mock) return `mock-${role}`
	// OpenAI by default; the event credit (Claude Sonnet/Haiku only) is opt-in or the fallback when it is the only key.
	const provider = env.BRINGUP_PROVIDER === "openai" || env.BRINGUP_PROVIDER === "anthropic" ? env.BRINGUP_PROVIDER : env.OPENAI_API_KEY ? "openai" : env.ANTHROPIC_API_KEY ? "anthropic" : "openai"
	return role === "architect" ? MODELS[provider].strong : MODELS[provider].fast
}

// Mock runs swap in the scripted runner; real runs use Mozaik's default runner and built-in models.
export function inferenceConfig(
	mock: boolean,
	scripts: Record<string, Script> = {},
	onFailure: (model: string, error: string) => void = (model, error) => console.error(`[bringup] ${model} inference failed: ${error}`),
): InferenceRunnerConfig {
	if (mock) return { runner: new ScriptedRunner(scripts) }
	// Mozaik does not export its input validator; the provider rejects invalid requests anyway,
	// and SafeRunner turns that rejection into a message instead of a dead loop.
	const noValidation = { validate: () => {} } as unknown as ConstructorParameters<typeof DefaultInferenceRunner>[1]
	return { runner: new SafeRunner(new DefaultInferenceRunner(supportedModels, noValidation), onFailure) }
}
