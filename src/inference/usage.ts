import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { InferenceInput, InferenceOutput, InferenceRunner, SemanticEvent } from "@mozaik-ai/core"
import { PRICES } from "./prices.ts"
import { checkSpend, recordSpend } from "./spend.ts"

// One model call's tokens and price, one line each in <run>/usage.jsonl. Unknown token counts stay null (and so does
// the price): a call the provider didn't report is "unknown", never counted as free.
export interface UsageRecord {
	at: string
	model: string
	source: string
	inputTokens: number | null
	// Of inputTokens: read from the cache, and (Claude) written to it.
	cachedTokens: number | null
	cacheWriteTokens?: number | null
	outputTokens: number | null
	usd: number | null
	// Which agent made the call (the role its context is tagged with: participantOf) and, when the provider says, the
	// model id that answered. apiUsd: the call at that model's API list price, for subscription calls (usd 0).
	participant?: string
	servedBy?: string
	apiUsd?: number | null
}

// A turn's context, tagged with the agent's role so the usage record can say who made each call (real runs up to 20b
// could only be split per agent by matching timestamps against the trace).
export const roleContextId = (role: string, id: string) => `${role}:${id}`
export function participantOf(contextId: string | undefined): string | undefined {
	const i = contextId?.indexOf(":") ?? -1
	return i > 0 ? contextId!.slice(0, i) : undefined
}

// `input` is all input tokens: uncached, plus `cached` read from the cache, plus `cacheWrite` written to it.
export function costUsd(model: string, input: number, cached: number, output: number, cacheWrite = 0): number | null {
	const p = PRICES[model]
	if (!p) return null
	return (Math.max(0, input - cached - cacheWrite) * p.inputPerM + cached * p.cachedInputPerM + cacheWrite * (p.cacheWritePerM ?? p.inputPerM) + output * p.outputPerM) / 1_000_000
}

export function usageRecord(model: string, source: string, input: number | null | undefined, cached: number | null | undefined, output: number | null | undefined, cacheWrite?: number | null): UsageRecord {
	const known = typeof input === "number" && typeof output === "number"
	const c = known ? (cached ?? 0) : null
	const w = known ? (cacheWrite ?? 0) : null
	return {
		at: new Date().toISOString(),
		model,
		source,
		inputTokens: known ? input : null,
		cachedTokens: c,
		cacheWriteTokens: w,
		outputTokens: known ? output : null,
		usd: known ? costUsd(model, input, c ?? 0, output, w ?? 0) : null,
	}
}

// Anthropic's usage block (input_tokens excludes both cache counts) as total input, cache reads and cache writes.
export function anthropicUsage(u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined) {
	if (typeof u?.input_tokens !== "number") return null
	const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0
	return { input: u.input_tokens + read + write, cached: read, cacheWrite: write, output: u.output_tokens }
}

export class UsageRunner implements InferenceRunner {
	constructor(
		private readonly inner: InferenceRunner,
		private readonly record: (r: UsageRecord) => void,
		private readonly source: string,
	) {}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		// The machine-wide cap (spend.ts): past it the call is refused, as a failed call (SafeRunner reports it).
		checkSpend()
		const output = await this.inner.run(input)
		// Claude: Mozaik's TokenUsage merges cache writes and reads, so price from the provider's own usage block.
		const a = anthropicUsage((output.rowResponse as { usage?: Parameters<typeof anthropicUsage>[0] } | undefined)?.usage)
		const u = output.tokenUsage
		const r = a ? usageRecord(input.model, this.source, a.input, a.cached, a.output, a.cacheWrite) : usageRecord(input.model, this.source, u?.inputTokens, u?.inputTokenDetails?.cached_tokens, u?.outputTokens)
		const participant = participantOf(input.context?.id)
		if (participant) r.participant = participant
		const servedBy = (output.rowResponse as { servedBy?: unknown } | undefined)?.servedBy
		if (typeof servedBy === "string") {
			r.servedBy = servedBy
			const known = r.inputTokens !== null && r.outputTokens !== null
			r.apiUsd = known ? costUsd(servedBy, r.inputTokens!, r.cachedTokens ?? 0, r.outputTokens!, r.cacheWriteTokens ?? 0) : null
		}
		this.record(r)
		return output
	}

	stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		return this.inner.stream(input)
	}
}

export const usageFile = (dir: string) => join(dir, "usage.jsonl")

export function appendUsage(dir: string, r: UsageRecord): void {
	appendFileSync(usageFile(dir), JSON.stringify(r) + "\n")
	recordSpend(r, dir)
}

export function readSpend(dir: string): { usd: number | null; calls: number; unknownCalls: number } {
	const file = usageFile(dir)
	if (!existsSync(file)) return { usd: null, calls: 0, unknownCalls: 0 }
	let usd: number | null = null
	let calls = 0
	let unknownCalls = 0
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue
		let r: Partial<UsageRecord>
		try {
			r = JSON.parse(line)
		} catch {
			continue
		}
		calls++
		if (typeof r.usd === "number") usd = (usd ?? 0) + r.usd
		else unknownCalls++
	}
	return { usd, calls, unknownCalls }
}

export type Spend = ReturnType<typeof readSpend>

// A system's spend: its boards' plus its own (the architect's plan call).
export function addSpend(...all: Spend[]): Spend {
	const priced = all.filter((s) => s.usd !== null)
	return {
		usd: priced.length ? priced.reduce((t, s) => t + (s.usd ?? 0), 0) : null,
		calls: all.reduce((t, s) => t + s.calls, 0),
		unknownCalls: all.reduce((t, s) => t + s.unknownCalls, 0),
	}
}
