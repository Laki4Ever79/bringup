import { FunctionCallOutputItem, ModelContext, SemanticEvent, type ContextItem, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"

// Tools whose latest result makes every earlier one of the same call stale: the contract read (it changes under the
// agent, and only the current state counts) and catalog lookups repeated with the same arguments.
const LATEST_WINS = new Set(["read_contract", "search_parts", "compare_mcus"])

// A turn's context with stale tool results replaced by a one-line note. Each model call resends the whole turn, so a
// result kept after a newer one of the same call costs its tokens again on every later call (real run cc-eurobot-20b,
// 17 Nov 2026: the parts agent read the contract 70 times and searched the catalog 68 times in 29 turns, and its
// calls averaged ~90K input tokens). The calls themselves stay, so the agent still sees what it did.
export function trimStale(items: ContextItem[]): { items: ContextItem[]; dropped: number } {
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
	let dropped = 0
	const out = items.map((it, i) => {
		const raw = it as unknown as { type: string; callId?: string }
		const key = raw.type === "function_call_output" && raw.callId ? callOf.get(raw.callId) : undefined
		if (!key || last.get(key) === i) return it
		dropped++
		return FunctionCallOutputItem.create(raw.callId!, `(stale: ${key.split(" ")[0]} was called again later in this turn; that newer result counts)`)
	})
	return { items: out, dropped }
}

export class TrimRunner implements InferenceRunner {
	constructor(private readonly inner: InferenceRunner) {}

	run(input: InferenceInput): Promise<InferenceOutput> {
		const { items, dropped } = trimStale(input.context.getItems())
		// A copy with the same id (it names the agent for usage.jsonl); Mozaik's own context keeps every result.
		return this.inner.run(dropped ? { ...input, context: ModelContext.rehydrate({ id: input.context.id, items }) } : input)
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}
}
