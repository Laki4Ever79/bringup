import { test } from "node:test"
import assert from "node:assert/strict"
import { ModelContext, ModelMessageItem, type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent } from "@mozaik-ai/core"
import { SafeRunner } from "../src/inference/safe-runner.ts"

const input = { model: "gpt-5.4-mini", context: ModelContext.create(), tools: [] } as InferenceInput

function inner(run: () => Promise<InferenceOutput>): InferenceRunner {
	return { run, async *stream(): AsyncGenerator<SemanticEvent> {} }
}

test("a provider error becomes an assistant message so the loop ends", async () => {
	const failures: string[] = []
	const r = new SafeRunner(inner(async () => { throw new Error("429 rate limited") }), (model, error) => failures.push(`${model}: ${error}`))
	const out = await r.run(input)
	assert.equal(out.items.length, 1)
	assert.ok(out.items[0] instanceof ModelMessageItem)
	assert.match((out.items[0] as ModelMessageItem).content.text, /inference failed: .*429/)
	assert.deepEqual(failures, ["gpt-5.4-mini: Error: 429 rate limited"])
})

test("an empty model response becomes an assistant message", async () => {
	const r = new SafeRunner(inner(async () => ({ items: [], tokenUsage: undefined, rowResponse: {} })), () => {})
	const out = await r.run(input)
	assert.match((out.items[0] as ModelMessageItem).content.text, /no answer/)
})

test("a normal response passes through unchanged", async () => {
	const answer = ModelMessageItem.rehydrate({ text: "ok" })
	const r = new SafeRunner(inner(async () => ({ items: [answer], tokenUsage: undefined, rowResponse: {} })), () => {})
	assert.deepEqual((await r.run(input)).items, [answer])
})
