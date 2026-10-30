import type { InferenceRunnerConfig } from "@mozaik-ai/core"
import type { AgentRole } from "../contract/types.ts"
import { ScriptedRunner, type Script } from "./scripted-runner.ts"

export function modelFor(role: AgentRole, mock: boolean): string {
	if (mock) return `mock-${role}`
	return role === "architect" ? "gpt-5.4" : "gpt-5.4-mini"
}

// Mock runs swap in the scripted runner; real runs use Mozaik's default runner and built-in models.
export function inferenceConfig(mock: boolean, scripts: Record<string, Script> = {}): InferenceRunnerConfig | undefined {
	return mock ? { runner: new ScriptedRunner(scripts) } : undefined
}
