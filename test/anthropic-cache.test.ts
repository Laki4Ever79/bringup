import { test } from "node:test"
import assert from "node:assert/strict"
import type Anthropic from "@anthropic-ai/sdk"
import { DeveloperMessageItem, FunctionCallItem, type ContextItem, FunctionCallOutputItem, ModelContext, UserMessageItem, Tool, type InferenceInput, type InferenceRunner } from "@mozaik-ai/core"
import { AnthropicCacheRunner, MAX_OUTPUT_TOKENS, withCacheBreakpoints } from "../src/inference/anthropic-cache.ts"
import { UsageRunner, type UsageRecord } from "../src/inference/usage.ts"

// Prompt caching on the API path (lead-2's cost work, 23 Nov 2026): Mozaik 4.1.0 sent no cache_control, so every call
// of an agent's turn paid full price for the whole transcript again. Proven here on a stubbed HTTP client: no call leaves.

const DEV = "You are the parts agent. ".repeat(50)
const tool = { type: "function", name: "read_contract", description: "Read the contract.", parameters: { type: "object", properties: {} } } as unknown as Tool

function turn(extra: number): InferenceInput {
	const items: ContextItem[] = [DeveloperMessageItem.create(DEV), UserMessageItem.create("Choose the parts.")]
	for (let i = 0; i < extra; i++) items.push(FunctionCallItem.rehydrate({ callId: `c${i}`, name: "read_contract", args: "{}" }), FunctionCallOutputItem.create(`c${i}`, `CONTRACT v${i}`))
	return { model: "claude-haiku-4-5", context: ModelContext.rehydrate({ id: "parts-turn-1", items }), tools: [tool] } as InferenceInput
}

const markers = (body: unknown) => (JSON.stringify(body).match(/"cache_control"/g) ?? []).length
const reply = (usage: Partial<Anthropic.Usage>): Anthropic.Message => ({ id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "ok", citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } as Anthropic.Usage }) as Anthropic.Message

test("each call carries two breakpoints: the system prompt (tools and developer prompt) and the turn's last block", async () => {
	const bodies: Anthropic.MessageCreateParamsNonStreaming[] = []
	const runner = new AnthropicCacheRunner({} as InferenceRunner, async (b) => (bodies.push(b), reply({})))
	await runner.run(turn(0))
	await runner.run(turn(1))
	await runner.run(turn(2))
	for (const b of bodies) {
		assert.equal(markers(b), 2, "two of the API's four breakpoints")
		assert.deepEqual(b.system, [{ type: "text", text: DEV, cache_control: { type: "ephemeral" } }])
		const last = b.messages[b.messages.length - 1].content as { cache_control?: unknown }[]
		assert.deepEqual(last[last.length - 1].cache_control, { type: "ephemeral" })
		assert.equal(b.max_tokens, MAX_OUTPUT_TOKENS, "Mozaik leaves max_tokens undefined; the runner sets it")
		assert.equal(b.tools?.length, 1)
	}
	// Append-only: each request's messages, markers aside, start with the whole of the one before.
	const plain = (b: Anthropic.MessageCreateParamsNonStreaming) => JSON.parse(JSON.stringify(b.messages).replace(/,"cache_control":\{"type":"ephemeral"\}/g, ""))
	for (let i = 1; i < bodies.length; i++) {
		const prev = plain(bodies[i - 1]), cur = plain(bodies[i])
		assert.deepEqual(cur.slice(0, prev.length - 1), prev.slice(0, prev.length - 1))
	}
	// The request body, for the record: what a cached call sends.
	assert.match(JSON.stringify(bodies[2]), /"system":\[\{"type":"text","text":"You are the parts agent\. [^"]*","cache_control":\{"type":"ephemeral"\}\}\]/)
	assert.match(JSON.stringify(bodies[2]), /"tool_result","tool_use_id":"c1","content":"CONTRACT v1","cache_control":\{"type":"ephemeral"\}\}\]\}\]/)
})

test("cache reads and writes reach usage.jsonl apart from plain input, priced as such", async () => {
	const rows: UsageRecord[] = []
	const runner = new UsageRunner(new AnthropicCacheRunner({} as InferenceRunner, async () => reply({ input_tokens: 300, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 2_000, output_tokens: 400 })), (r) => rows.push(r), "agents")
	await runner.run(turn(3))
	assert.equal(rows.length, 1)
	assert.equal(rows[0].inputTokens, 92_300)
	assert.equal(rows[0].cachedTokens, 90_000)
	assert.equal(rows[0].cacheWriteTokens, 2_000)
	assert.ok(rows[0].usd !== null && rows[0].usd < 0.03, `a 92K-token call mostly read from the cache costs cents, not ${rows[0].usd}`)
})

test("other models go through Mozaik's own runner untouched", async () => {
	let sent = 0, fell = 0
	const fallback = { run: async () => (fell++, { items: [], tokenUsage: undefined, rowResponse: {} }), stream: async function* () {} } as unknown as InferenceRunner
	const runner = new AnthropicCacheRunner(fallback, async () => (sent++, reply({})))
	await runner.run({ ...turn(0), model: "gpt-5.4-mini" })
	assert.deepEqual([sent, fell], [0, 1])
	assert.equal(runner.caches("gpt-5.4-mini"), false)
	assert.equal(runner.caches("claude-sonnet-4-6"), true)
})

test("without a system prompt the stable breakpoint goes on the last tool", () => {
	const b = withCacheBreakpoints({ model: "claude-haiku-4-5", max_tokens: 100, tools: [{ name: "a", input_schema: { type: "object" } }, { name: "b", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hi" }] })
	assert.deepEqual((b.tools![1] as { cache_control?: unknown }).cache_control, { type: "ephemeral" })
	assert.equal((b.tools![0] as { cache_control?: unknown }).cache_control, undefined)
	assert.deepEqual(b.messages[0].content, [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }])
	assert.equal(b.max_tokens, 100)
})
