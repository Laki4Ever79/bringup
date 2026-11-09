import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { InferenceInput, InferenceOutput, InferenceRunner, SemanticEvent } from "@mozaik-ai/core"
import { PRICES } from "./prices.ts"

// One model call's tokens and price, one line each in <run>/usage.jsonl. Unknown token counts stay null (and so does
// the price): a call the provider didn't report is "unknown", never counted as free.
export interface UsageRecord {
	at: string
	model: string
	source: string
	inputTokens: number | null
	cachedTokens: number | null
	outputTokens: number | null
	usd: number | null
}

// `input` includes the cached tokens, as both providers' usage reports do.
export function costUsd(model: string, input: number, cached: number, output: number): number | null {
	const p = PRICES[model]
	if (!p) return null
	return ((input - cached) * p.inputPerM + cached * p.cachedInputPerM + output * p.outputPerM) / 1_000_000
}

export function usageRecord(model: string, source: string, input: number | null | undefined, cached: number | null | undefined, output: number | null | undefined): UsageRecord {
	const known = typeof input === "number" && typeof output === "number"
	const c = known ? (cached ?? 0) : null
	return {
		at: new Date().toISOString(),
		model,
		source,
		inputTokens: known ? input : null,
		cachedTokens: c,
		outputTokens: known ? output : null,
		usd: known ? costUsd(model, input, c ?? 0, output) : null,
	}
}

export class UsageRunner implements InferenceRunner {
	constructor(
		private readonly inner: InferenceRunner,
		private readonly record: (r: UsageRecord) => void,
		private readonly source: string,
	) {}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const output = await this.inner.run(input)
		const u = output.tokenUsage
		this.record(usageRecord(input.model, this.source, u?.inputTokens, u?.inputTokenDetails?.cached_tokens, u?.outputTokens))
		return output
	}

	stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		return this.inner.stream(input)
	}
}

export const usageFile = (dir: string) => join(dir, "usage.jsonl")

export function appendUsage(dir: string, r: UsageRecord): void {
	appendFileSync(usageFile(dir), JSON.stringify(r) + "\n")
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
