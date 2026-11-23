import Anthropic from "@anthropic-ai/sdk"
import { AnthropicMessages, SemanticEvent, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"

// Prompt caching on the Anthropic API path. Mozaik 4.1.0 sends no cache_control, so every call of a turn paid full
// price for the whole transcript again (real Eurobot runs: the parts agent's calls averaged ~90K input tokens). This
// runner builds the request with Mozaik's own mapper (the same bytes Mozaik would send) and adds two breakpoints:
//   1. the last system block: the tools (rendered before system) and the developer prompt, stable for every turn of
//      an agent, so each turn's first call reads them;
//   2. the last block of the last message: the turn's transcript so far, so the next call of the same turn reads it
//      and pays full price only for what was appended since.
// Two of the API's four breakpoints. A turn appends one assistant message (its tool_use blocks are one position) and one
// user message (its tool_result blocks are one position) per call, well inside the API's 20-position lookback.
// Mozaik itself stays at 4.1.0; other models go through Mozaik's own runner unchanged.

export type MessagesCreate = (body: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>

// Agents never set maxOutputTokens, and Mozaik's mapper copies it straight into max_tokens (undefined: a 400). 16K
// keeps a non-streaming request well inside the SDK's timeout; an agent's turn writes a few thousand at most.
export const MAX_OUTPUT_TOKENS = 16_000

const EPHEMERAL = { type: "ephemeral" } as const

// The request with its cache breakpoints. Pure, so tests can check the exact body.
export function withCacheBreakpoints(req: Anthropic.MessageCreateParamsNonStreaming): Anthropic.MessageCreateParamsNonStreaming {
	const out: Anthropic.MessageCreateParamsNonStreaming = { ...req, max_tokens: req.max_tokens ?? MAX_OUTPUT_TOKENS }
	// 1. The stable prefix: on the system prompt (it renders after the tools, so it covers both), else on the last tool.
	if (typeof req.system === "string" && req.system) out.system = [{ type: "text", text: req.system, cache_control: EPHEMERAL }]
	else if (Array.isArray(req.system) && req.system.length) out.system = req.system.map((b, i, all) => (i === all.length - 1 ? { ...b, cache_control: EPHEMERAL } : b))
	else if (req.tools?.length) out.tools = req.tools.map((t, i, all) => (i === all.length - 1 ? { ...t, cache_control: EPHEMERAL } : t))
	// 2. The growing tail: the last block of the last message (a thinking block can't carry one: the nearest before it).
	const messages = req.messages.map((m) => ({ ...m }))
	const last = messages[messages.length - 1]
	if (last) {
		const blocks = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : [...last.content]
		for (let i = blocks.length - 1; i >= 0; i--) {
			const b = blocks[i]
			if (b.type === "thinking" || b.type === "redacted_thinking") continue
			blocks[i] = { ...b, cache_control: EPHEMERAL } as typeof b
			break
		}
		last.content = blocks
	}
	out.messages = messages
	return out
}

export const isClaudeModel = (model: string) => model.startsWith("claude-")

export class AnthropicCacheRunner implements InferenceRunner {
	private readonly mapper = (new AnthropicMessages() as unknown as { endpointMapper: { toRequest(i: InferenceInput): Anthropic.MessageCreateParamsNonStreaming; toResponse(r: Anthropic.Message): InferenceOutput } }).endpointMapper
	private readonly create: MessagesCreate

	// `fallback` serves every model that isn't Claude (OpenAI, Gemini: Mozaik's own runner). `create` defaults to the
	// SDK, reading ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL (the event gateway) as Mozaik's client does.
	constructor(
		private readonly fallback: InferenceRunner,
		create?: MessagesCreate,
	) {
		if (create) this.create = create
		else {
			let client: Anthropic | undefined
			this.create = (body) => (client ??= new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY })).messages.create(body)
		}
	}

	// Whether a model's calls are cached: TrimRunner weighs a trim against the cache rewrite it causes.
	caches(model: string): boolean {
		return isClaudeModel(model)
	}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		if (!isClaudeModel(input.model)) return this.fallback.run(input)
		const response = await this.create(withCacheBreakpoints(this.mapper.toRequest(input)))
		return this.mapper.toResponse(response)
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		if (!isClaudeModel(input.model)) return yield* this.fallback.stream(input)
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}
}
