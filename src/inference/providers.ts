// Which AI a run uses: any provider the user has a key (or a local server) for (the user, 25 Nov 2026: "we do not want to
// reveal what we use on our side, we should keep that a mystery but support all"). One setting picks it:
//
//   BRINGUP_AI=<provider>            openai, anthropic, gemini, claude-code, openrouter, mistral, ollama, lmstudio,
//                                    compatible (any OpenAI-compatible server), bringup (Bringup AI, the paid hosted one)
//   BRINGUP_AI_MODEL=<model>         the model for the architect and the reviewer (the roles that plan and judge)
//   BRINGUP_AI_FAST_MODEL=<model>    the model for every other agent (default: BRINGUP_AI_MODEL)
//   BRINGUP_AI_URL / BRINGUP_AI_KEY  the server and key for `compatible` and `bringup`
//
// BRINGUP_PROVIDER, the older name, still works. Without either, the first provider whose key is set is used.
// Providers with a default model use a generic pair of that provider's own models; the others ask for BRINGUP_AI_MODEL.
import { PRODUCT } from "../brand/names.js"
import { AnthropicMessages, GeminiGenerateContent, OpenAIChatCompletions, supportedModels } from "@mozaik-ai/core"

export type Protocol = "openai-responses" | "openai-chat" | "anthropic" | "gemini" | "claude-code"
export interface Provider {
	id: string
	label: string
	protocol: Protocol
	// The environment variable holding the key (none for a local server or the Claude Code login).
	keyVar?: string
	// The server, for protocols that can point anywhere; baseVar overrides it.
	baseURL?: string
	baseVar?: string
	models?: { strong: string; fast: string }
	local?: boolean
	signup?: string
}

export const PROVIDERS: Record<string, Provider> = {
	openai: { id: "openai", label: "OpenAI", protocol: "openai-responses", keyVar: "OPENAI_API_KEY", models: { strong: "gpt-5.4", fast: "gpt-5.4-mini" }, signup: "https://platform.openai.com/api-keys" },
	anthropic: { id: "anthropic", label: "Anthropic", protocol: "anthropic", keyVar: "ANTHROPIC_API_KEY", baseVar: "ANTHROPIC_BASE_URL", baseURL: "https://api.anthropic.com", models: { strong: "claude-sonnet-4-6", fast: "claude-haiku-4-5" }, signup: "https://console.anthropic.com/settings/keys" },
	gemini: { id: "gemini", label: "Google Gemini", protocol: "gemini", keyVar: "GEMINI_API_KEY", models: { strong: "gemini-3.1-pro-preview", fast: "gemini-3.5-flash" }, signup: "https://aistudio.google.com/apikey" },
	"claude-code": { id: "claude-code", label: "Claude subscription (this machine's Claude Code login)", protocol: "claude-code", models: { strong: "cc-sonnet", fast: "cc-haiku" } },
	openrouter: { id: "openrouter", label: "OpenRouter (one key, many models)", protocol: "openai-chat", keyVar: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1", signup: "https://openrouter.ai/keys" },
	mistral: { id: "mistral", label: "Mistral", protocol: "openai-chat", keyVar: "MISTRAL_API_KEY", baseURL: "https://api.mistral.ai/v1", signup: "https://console.mistral.ai/api-keys" },
	ollama: { id: "ollama", label: "Ollama (local models)", protocol: "openai-chat", baseURL: "http://localhost:11434/v1", baseVar: "OLLAMA_URL", local: true },
	lmstudio: { id: "lmstudio", label: "LM Studio (local models)", protocol: "openai-chat", baseURL: "http://localhost:1234/v1", baseVar: "LMSTUDIO_URL", local: true },
	compatible: { id: "compatible", label: "Any OpenAI-compatible server", protocol: "openai-chat", keyVar: "BRINGUP_AI_KEY", baseVar: "BRINGUP_AI_URL" },
	bringup: { id: "bringup", label: `${PRODUCT} AI (included with a paid plan)`, protocol: "openai-chat", keyVar: "BRINGUP_AI_KEY", baseVar: "BRINGUP_AI_URL", models: { strong: "bringup-strong", fast: "bringup-fast" } },
}

type Env = Record<string, string | undefined>
const set = (v: string | undefined) => Boolean(v?.trim())

// The provider this environment picks, or null when nothing is configured.
export function resolveProvider(env: Env = process.env): Provider | null {
	const named = (env.BRINGUP_AI ?? env.BRINGUP_PROVIDER)?.trim()
	if (named) return PROVIDERS[named] ?? null
	for (const id of ["openai", "anthropic", "gemini", "openrouter", "mistral"]) if (set(env[PROVIDERS[id].keyVar!])) return PROVIDERS[id]
	return null
}

// What is missing for the chosen provider, in words a user can act on; null when it can run.
export function providerProblem(env: Env = process.env): string | null {
	const named = (env.BRINGUP_AI ?? env.BRINGUP_PROVIDER)?.trim()
	if (named && !PROVIDERS[named]) return `BRINGUP_AI=${named} is not a provider ${PRODUCT} knows: use one of ${Object.keys(PROVIDERS).join(", ")}`
	const p = resolveProvider(env)
	if (!p) return `no AI is configured: set BRINGUP_AI to one of ${Object.keys(PROVIDERS).join(", ")} and that provider's key (for example OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY), or run a local model with BRINGUP_AI=ollama`
	if (p.keyVar && !p.local && !set(env[p.keyVar])) return `${p.label} needs ${p.keyVar}${p.signup ? ` (get one at ${p.signup})` : ""}`
	if (p.baseVar && !p.baseURL && !set(env[p.baseVar])) return `${p.label} needs ${p.baseVar}, the server's address (e.g. https://host/v1)`
	if (!p.models && !set(env.BRINGUP_AI_MODEL)) return `${p.label} needs BRINGUP_AI_MODEL, the model to use (and optionally BRINGUP_AI_FAST_MODEL for the smaller agents)`
	return null
}

// The model a role uses: strong for the architect and the reviewer (they plan and judge), fast for the rest, or every
// role on the fast one with BRINGUP_MODELS=fast.
export function providerModel(strong: boolean, env: Env = process.env): string {
	// Only what picks the model: a missing key is the run's problem (providerProblem), not the model's name.
	const p = resolveProvider(env)
	if (!p) throw new Error(providerProblem(env) ?? "no AI is configured")
	if (!p.models && !env.BRINGUP_AI_MODEL?.trim()) throw new Error(`${p.label} needs BRINGUP_AI_MODEL, the model to use`)
	const s = env.BRINGUP_AI_MODEL?.trim() || p.models!.strong
	const f = env.BRINGUP_AI_FAST_MODEL?.trim() || (env.BRINGUP_AI_MODEL?.trim() ? s : p.models!.fast)
	return env.BRINGUP_MODELS === "fast" || !strong ? f : s
}

export function baseURL(p: Provider, env: Env = process.env): string | undefined {
	return (p.baseVar && env[p.baseVar]?.trim()) || p.baseURL
}

const CHAT_SPEC = {
	supportsReasoningEffort: false,
	supportedReasoningEfforts: [] as string[],
	supportedContextItemTypes: ["user_message", "system_message", "developer_message", "function_call", "function_call_output", "model_message"],
	supportsStreaming: true,
	contextWindowSize: 128_000,
	maxOutputTokens: 16_000,
	supportsFunctionCalling: true,
	supportsStructuredOutput: false,
}

type Model = (typeof supportedModels)[number]

// Mozaik's models plus the chosen provider's: a model Mozaik doesn't list (any OpenRouter, Mistral or local model, a
// Gemini or Claude name it lacks) gets an entry on that provider's endpoint. Listed first, so the provider's own
// endpoint (its server and key) wins over a same-named built-in.
export function modelsFor(env: Env = process.env): Model[] {
	const p = resolveProvider(env)
	if (!p || p.protocol === "claude-code" || providerProblem(env)) return [...supportedModels]
	const names = [...new Set([providerModel(true, env), providerModel(false, env)])]
	const known = new Set(supportedModels.map((m) => m.specification.name))
	const key = p.keyVar ? env[p.keyVar]?.trim() : p.local ? "local" : undefined
	const url = baseURL(p, env)
	const own: Model[] = []
	for (const name of names) {
		// A model Mozaik lists on the provider's own API: its built-in endpoint reads the same key (and ANTHROPIC_BASE_URL).
		if (known.has(name) && (p.protocol === "openai-responses" || p.protocol === "anthropic" || p.protocol === "gemini")) continue
		const endpoint =
			p.protocol === "anthropic" ? new AnthropicMessages(undefined, { baseURL: url, apiKey: key })
			: p.protocol === "gemini" ? new GeminiGenerateContent(undefined, { apiKey: key, ...(url ? { baseURL: url } : {}) })
			: new OpenAIChatCompletions(undefined, { baseURL: p.protocol === "openai-responses" ? "https://api.openai.com/v1" : url, apiKey: key })
		const builtIn = supportedModels.find((m) => m.specification.name === name)?.specification
		own.push({ endpoint, specification: { ...(builtIn ?? CHAT_SPEC), name, provider: p.id } } as unknown as Model)
	}
	return [...own, ...supportedModels]
}
