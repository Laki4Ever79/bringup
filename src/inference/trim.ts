import { FunctionCallOutputItem, ModelContext, SemanticEvent, type ContextItem, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"

// Tools whose latest result makes every earlier one of the same call stale: the contract read (it changes under the
// agent, and only the current state counts) and catalog lookups repeated with the same arguments.
const LATEST_WINS = new Set(["read_contract", "search_parts", "compare_mcus"])

// A turn's context with stale tool results replaced by a one-line note. Each model call resends the whole turn, so a
// result kept after a newer one of the same call costs its tokens again on every later call (real run cc-eurobot-20b,
// 17 Nov 2026: the parts agent read the contract 70 times and searched the catalog 68 times in 29 turns, and its
// calls averaged ~90K input tokens). The calls themselves stay, so the agent still sees what it did.
//
// With prompt caching (anthropic-cache.ts) a trim has a price: it changes the transcript from the trimmed result on,
// so the cache misses from there and that whole suffix is written again (1.25x input) instead of read (0.1x). The
// options make it cache-aware: `keep` are results trimmed on an earlier call (they stay trimmed, so the prefix the
// cache holds never changes back), and `allow` decides whether results that went stale since may be trimmed now.
export interface TrimOptions {
	keep?: ReadonlySet<string>
	allow?: (candidates: { callId: string; index: number; tokens: number }[], items: ContextItem[]) => boolean
}

export function trimStale(items: ContextItem[], opts: TrimOptions = {}): { items: ContextItem[]; dropped: number; trimmed: string[] } {
	const callOf = new Map<string, string>()
	for (const it of items) {
		const raw = it as unknown as { type: string; callId?: string; name?: string; args?: string }
		if (raw.type === "function_call" && raw.callId && raw.name && LATEST_WINS.has(raw.name)) callOf.set(raw.callId, raw.name === "read_contract" ? raw.name : `${raw.name} ${raw.args ?? ""}`)
	}
	const last = new Map<string, number>()
	items.forEach((it, i) => {
		const raw = it as unknown as { type: string; callId?: string }
		const key = raw.type === "function_call_output" && raw.callId ? callOf.get(raw.callId) : undefined
		if (key) last.set(key, i)
	})
	const stale: { callId: string; index: number; tokens: number; key: string }[] = []
	items.forEach((it, i) => {
		const raw = it as unknown as { type: string; callId?: string; output?: { text?: string } }
		const key = raw.type === "function_call_output" && raw.callId ? callOf.get(raw.callId) : undefined
		if (key && last.get(key) !== i) stale.push({ callId: raw.callId!, index: i, tokens: tokensOf(it), key })
	})
	const fresh = stale.filter((c) => !opts.keep?.has(c.callId))
	const take = new Set([...stale.filter((c) => opts.keep?.has(c.callId)), ...(fresh.length && (!opts.allow || opts.allow(fresh, items)) ? fresh : [])].map((c) => c.callId))
	const keyOf = new Map(stale.map((c) => [c.callId, c.key]))
	const out = items.map((it) => {
		const raw = it as unknown as { type: string; callId?: string }
		if (raw.type !== "function_call_output" || !raw.callId || !take.has(raw.callId)) return it
		return FunctionCallOutputItem.create(raw.callId, `(stale: ${keyOf.get(raw.callId)!.split(" ")[0]} was called again later in this turn; that newer result counts)`)
	})
	return { items: out, dropped: take.size, trimmed: [...take] }
}

// A context item's size in tokens, estimated at 4 characters a token (an ESTIMATE: enough to weigh a trim, not to bill).
export function tokensOf(it: ContextItem): number {
	const raw = it as unknown as { content?: { text?: string } | string; output?: { text?: string } | string; args?: string; name?: string }
	const text = (v: { text?: string } | string | undefined) => (typeof v === "string" ? v : (v?.text ?? ""))
	return Math.ceil((text(raw.content).length + text(raw.output).length + (raw.args ?? "").length + (raw.name ?? "").length) / 4)
}

// The prices a cached call pays per input token, relative to the plain price (Anthropic: write 1.25x, read 0.1x).
export const CACHE_WRITE = 1.25
export const CACHE_READ = 0.1

// Trim now only if it pays for itself. Keeping the stale results costs their tokens at the read price on every later
// call of the turn; trimming costs one rewrite of everything from the first of them on (write price instead of read).
// The calls still to come are unknown: estimated as the calls the turn has made so far (at least one), an ESTIMATE.
export function trimPays(candidates: { index: number; tokens: number }[], items: ContextItem[], callsSoFar: number): boolean {
	if (!candidates.length) return false
	const from = Math.min(...candidates.map((c) => c.index))
	const suffix = items.slice(from).reduce((t, it) => t + tokensOf(it), 0)
	const staleTokens = candidates.reduce((t, c) => t + c.tokens, 0)
	const remaining = Math.max(1, callsSoFar)
	return staleTokens * CACHE_READ * remaining > suffix * (CACHE_WRITE - CACHE_READ)
}

// What the trim did to each turn so far (its context id): the results it trimmed and the calls it made. Kept for the
// most recent turns only; a turn that falls off just starts counting again (an older turn is over).
const MAX_TURNS = 500

export class TrimRunner implements InferenceRunner {
	private readonly turns = new Map<string, { trimmed: Set<string>; calls: number }>()

	// `caches`: whether a model's calls are cached (AnthropicCacheRunner.caches). Without it every stale result is
	// trimmed at once, as before: nothing is cached, so nothing is rewritten.
	constructor(
		private readonly inner: InferenceRunner,
		private readonly caches: (model: string) => boolean = () => false,
	) {}

	run(input: InferenceInput): Promise<InferenceOutput> {
		const id = input.context.id
		const cached = this.caches(input.model)
		const turn = this.turns.get(id) ?? { trimmed: new Set<string>(), calls: 0 }
		this.turns.delete(id)
		this.turns.set(id, turn)
		if (this.turns.size > MAX_TURNS) this.turns.delete(this.turns.keys().next().value!)
		const { items, dropped, trimmed } = trimStale(input.context.getItems(), cached ? { keep: turn.trimmed, allow: (c, all) => trimPays(c, all, turn.calls) } : {})
		turn.calls++
		for (const t of trimmed) turn.trimmed.add(t)
		// A copy with the same id (it names the agent for usage.jsonl); Mozaik's own context keeps every result.
		return this.inner.run(dropped ? { ...input, context: ModelContext.rehydrate({ id: input.context.id, items }) } : input)
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}
}
