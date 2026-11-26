// What every model call costs: usage.jsonl per run, priced from src/inference/prices.ts; a call without token counts is
// "unknown", never $0.
import { test } from "node:test"
import assert from "node:assert/strict"
import { InputTokenDetails, ModelMessageItem, OutputTokenDetails, TokenUsage, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"
import { PRICES } from "../src/inference/prices.ts"
import { appendUsage, costUsd, readSpend, UsageRunner, type UsageRecord } from "../src/inference/usage.ts"
import { callModel } from "../src/runner/ask.ts"
import { tempDir } from "./helpers.ts"

const MODEL = "gpt-5.4-mini"

function fakeRunner(tokenUsage: TokenUsage | undefined): InferenceRunner {
	return {
		async run(): Promise<InferenceOutput> {
			return { items: [ModelMessageItem.rehydrate({ text: "ok" })], tokenUsage, rowResponse: {} }
		},
		// eslint-disable-next-line require-yield
		async *stream() {
			throw new Error("not used")
		},
	} as unknown as InferenceRunner
}

const input = { model: MODEL } as unknown as InferenceInput

test("a million input tokens cost the model's input price; an unknown model has no price", () => {
	assert.equal(costUsd(MODEL, 1_000_000, 0, 0), PRICES[MODEL].inputPerM)
	assert.equal(costUsd("nope", 1, 0, 0), null)
})

test("the usage runner records each call's tokens, cached input at the cached price", async () => {
	const seen: UsageRecord[] = []
	const usage = new TokenUsage(1000, 300, 1300, new InputTokenDetails(200), new OutputTokenDetails(0))
	await new UsageRunner(fakeRunner(usage), (r) => seen.push(r), "agents").run(input)
	assert.equal(seen.length, 1)
	const r = seen[0]
	assert.deepEqual([r.model, r.source, r.inputTokens, r.cachedTokens, r.outputTokens], [MODEL, "agents", 1000, 200, 300])
	const p = PRICES[MODEL]
	const expected = (800 * p.inputPerM + 200 * p.cachedInputPerM + 300 * p.outputPerM) / 1_000_000
	assert.ok(Math.abs((r.usd ?? -1) - expected) < 1e-12)
})

test("a call the provider reports without token counts is recorded as unknown, not free", async () => {
	const seen: UsageRecord[] = []
	await new UsageRunner(fakeRunner(undefined), (r) => seen.push(r), "agents").run(input)
	assert.deepEqual([seen[0].inputTokens, seen[0].cachedTokens, seen[0].outputTokens, seen[0].usd], [null, null, null, null])
})

test("a run's spend sums the priced calls and counts the unknown ones", () => {
	const dir = tempDir()
	const base = { at: "2026-11-09T10:00:00Z", model: MODEL, source: "agents", inputTokens: 1, cachedTokens: 0, outputTokens: 1 }
	appendUsage(dir, { ...base, usd: 0.5 })
	appendUsage(dir, { ...base, inputTokens: null, cachedTokens: null, outputTokens: null, usd: null })
	assert.deepEqual(readSpend(dir), { usd: 0.5, calls: 2, unknownCalls: 1 })
	assert.deepEqual(readSpend(tempDir()), { usd: null, calls: 0, unknownCalls: 0 })
})

test("the Ask box's direct call reports the provider's token usage", async () => {
	const seen: UsageRecord[] = []
	const fakeFetch = (async () =>
		new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })) as unknown as typeof fetch
	const answer = await callModel({ system: "s", user: "u" }, { OPENAI_API_KEY: "k" }, fakeFetch, (r) => seen.push(r))
	assert.equal(answer, "answer")
	assert.deepEqual([seen[0].inputTokens, seen[0].outputTokens, seen[0].source], [10, 5, "ask"])
})

test("a Claude call is priced from Anthropic's own usage: uncached input, cache writes and cache reads apart", async () => {
	const seen: UsageRecord[] = []
	const inner = {
		async run(): Promise<InferenceOutput> {
			return { items: [ModelMessageItem.rehydrate({ text: "ok" })], tokenUsage: new TokenUsage(100, 50, 150, new InputTokenDetails(1200), new OutputTokenDetails(0)), rowResponse: { usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 50 } } }
		},
	} as unknown as InferenceRunner
	await new UsageRunner(inner, (r) => seen.push(r), "agents").run({ model: "claude-haiku-4-5" } as unknown as InferenceInput)
	const p = PRICES["claude-haiku-4-5"]
	const expected = (100 * p.inputPerM + 200 * (p.cacheWritePerM ?? p.inputPerM) + 1000 * p.cachedInputPerM + 50 * p.outputPerM) / 1_000_000
	assert.ok(Math.abs((seen[0].usd ?? -1) - expected) < 1e-12, `${seen[0].usd} vs ${expected}`)
	assert.deepEqual([seen[0].inputTokens, seen[0].cachedTokens, seen[0].cacheWriteTokens], [1300, 1000, 200])
})

test("an OpenAI response's own usage block keeps Mozaik's cached count (it is not Anthropic's)", async () => {
	// The shape gpt-5.4-mini returned in the 25 Nov 2026 probe: the second identical call read 1664 of 1796 from the cache.
	const usage = new TokenUsage(1796, 5, 1801, new InputTokenDetails(1664), new OutputTokenDetails(0))
	const raw = { usage: { input_tokens: 1796, input_tokens_details: { cached_tokens: 1664, cache_write_tokens: 0 }, output_tokens: 5, total_tokens: 1801 } }
	const inner = { ...fakeRunner(usage), async run(): Promise<InferenceOutput> { return { items: [ModelMessageItem.rehydrate({ text: "ok" })], tokenUsage: usage, rowResponse: raw } } } as InferenceRunner
	const seen: UsageRecord[] = []
	await new UsageRunner(inner, (r) => seen.push(r), "agents").run(input)
	assert.deepEqual([seen[0].inputTokens, seen[0].cachedTokens, seen[0].cacheWriteTokens], [1796, 1664, 0])
})

test("costUsd prices the 5.5 models the subscription serves, Haiku 5.5 by its long-prompt tier", async () => {
	const { costUsd } = await import("../src/inference/usage.ts")
	// Sonnet 5.5: 1M uncached in at $2 + 1M out at $10
	assert.equal(costUsd("claude-sonnet-5-5", 1_000_000, 0, 1_000_000), 12)
	// Haiku 5.5 under 100K: 50K in at $0.10, 10K cached at $0.01, 1K out at $0.50
	assert.ok(Math.abs(costUsd("claude-haiku-5-5", 60_000, 10_000, 1_000)! - (50_000 * 0.1 + 10_000 * 0.01 + 1_000 * 0.5) / 1e6) < 1e-12)
	// over 100K: the whole request at $0.50 in / $2.50 out
	assert.ok(Math.abs(costUsd("claude-haiku-5-5", 200_000, 0, 1_000)! - (200_000 * 0.5 + 1_000 * 2.5) / 1e6) < 1e-12)
	// a dated id takes its family's price
	assert.equal(costUsd("claude-haiku-4-5-20251001", 1_000_000, 0, 0), 1)
})
