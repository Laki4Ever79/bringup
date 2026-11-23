import { test } from "node:test"
import assert from "node:assert/strict"
import { FunctionCallItem, FunctionCallOutputItem, UserMessageItem } from "@mozaik-ai/core"
import { trimStale } from "../src/inference/trim.ts"

const call = (id: string, name: string, args: object) => FunctionCallItem.rehydrate({ callId: id, name, args: JSON.stringify(args) })
const out = (id: string, text: string) => FunctionCallOutputItem.create(id, text)
const outputs = (items: unknown[]) => items.filter((i) => (i as { type: string }).type === "function_call_output").map((i) => { const o = (i as { output: unknown }).output; return typeof o === "string" ? o : String((o as { text?: string }).text ?? JSON.stringify(o)) })

// Real run cc-eurobot-20b (17 Nov 2026): one parts turn read the contract twice and searched the batteries twice; every
// later call resent all four results.
test("a stale contract read and a repeated identical search are cut to a note; the latest of each and other results stay", () => {
	const items = [
		UserMessageItem.create("Choose the parts."),
		call("a", "read_contract", {}), out("a", "CONTRACT v1 ".repeat(100)),
		call("b", "search_parts", { role: "battery" }), out("b", "BATTERIES ".repeat(100)),
		call("c", "search_parts", { role: "ldo" }), out("c", "LDOS"),
		call("d", "propose_contract_change", { field: "parts" }), out("d", "accepted"),
		call("e", "read_contract", {}), out("e", "CONTRACT v2"),
		call("f", "search_parts", { role: "battery" }), out("f", "BATTERIES again"),
	]
	const { items: trimmed, dropped } = trimStale(items)
	assert.equal(dropped, 2)
	assert.equal(trimmed.length, items.length)
	const o = outputs(trimmed)
	assert.match(o[0], /^\(stale: read_contract/)
	assert.match(o[1], /^\(stale: search_parts/)
	assert.deepEqual(o.slice(2), ["LDOS", "accepted", "CONTRACT v2", "BATTERIES again"])
})

test("a turn with nothing repeated goes through untouched", () => {
	const items = [UserMessageItem.create("go"), call("a", "read_contract", {}), out("a", "C"), call("b", "search_parts", { role: "mcu" }), out("b", "M")]
	const r = trimStale(items)
	assert.equal(r.dropped, 0)
	assert.deepEqual(r.items, items)
})

// With prompt caching a trim rewrites the cache from the trimmed result on (1.25x instead of 0.1x for that whole
// suffix): it happens only when the stale text costs more than that over the calls to come, and stays once made.
import { TrimRunner, trimPays } from "../src/inference/trim.ts"
import { ModelContext, type InferenceInput, type InferenceRunner } from "@mozaik-ai/core"

test("on a cached model a trim waits until it pays for its cache rewrite; on an uncached one it trims at once", async () => {
	const big = "CONTRACT ".repeat(2000)  // ~4.5K tokens
	const items = [UserMessageItem.create("go"), call("a", "read_contract", {}), out("a", big), call("b", "search_parts", { role: "x" }), out("b", "PARTS ".repeat(4000)), call("e", "read_contract", {}), out("e", "CONTRACT v2")]
	// The stale read (~4.5K tokens) heads a ~10.5K suffix: keeping it costs 4.5K x 0.1 a call, trimming 10.5K x 1.15
	// once, so it pays only past ~27 calls to come. A cache read makes stale text cheap; most trims won't pay.
	const stale = [{ index: 2, tokens: Math.ceil(big.length / 4) }]
	assert.equal(trimPays(stale, items, 10), false)
	assert.equal(trimPays(stale, items, 30), true)

	const seen: string[][] = []
	const inner = { run: async (i: InferenceInput) => (seen.push(outputs(i.context.getItems())), { items: [], tokenUsage: undefined, rowResponse: {} }), stream: async function* () {} } as unknown as InferenceRunner
	const input = (id: string, model: string) => ({ model, context: ModelContext.rehydrate({ id, items }), tools: [] }) as unknown as InferenceInput
	const cachedRunner = new TrimRunner(inner, (m) => m.startsWith("claude-"))
	await cachedRunner.run(input("t1", "claude-haiku-4-5"))
	assert.ok(!seen[0][0].startsWith("(stale"), "first call: the trim doesn't pay yet, the cached prefix stays")
	for (let k = 0; k < 30; k++) await cachedRunner.run(input("t1", "claude-haiku-4-5"))
	assert.match(seen[seen.length - 1][0], /^\(stale: read_contract/, "once the calls so far say it pays, it is trimmed")
	const firstTrim = seen.findIndex((o) => o[0].startsWith("(stale"))
	assert.ok(seen.slice(firstTrim).every((o) => o[0].startsWith("(stale")), "and stays trimmed: the prefix never changes back")

	await new TrimRunner(inner, (m) => m.startsWith("claude-")).run(input("t2", "gpt-5.4-mini"))
	assert.match(seen[seen.length - 1][0], /^\(stale: read_contract/, "uncached: trimmed at once, as before")
})
