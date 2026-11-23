import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FunctionCallItem, FunctionCallOutputItem, ModelContext, SystemMessageItem, UserMessageItem } from "@mozaik-ai/core"
import { ClaudeCodeRunner, transcriptOf } from "../src/inference/claude-code-runner.ts"
import { modelFor } from "../src/inference/models.ts"
import { tempDir } from "./helpers.ts"

const TOOL = { type: "function", name: "propose_contract_change", description: "Write a field.", parameters: { type: "object", properties: { field: { type: "string" } } }, strict: false }

test("the agent's context becomes a system prompt (with its tools) and a transcript of its turns", () => {
	const items = [SystemMessageItem.create("You are the architect."), UserMessageItem.create("Brief: a rover."), FunctionCallItem.rehydrate({ callId: "c1", name: "read_contract", args: "{}" }), FunctionCallOutputItem.create("c1", '{"revision":3}')]
	const t = transcriptOf(items, [TOOL as never])
	assert.match(t.system, /You are the architect\./)
	assert.match(t.system, /- propose_contract_change: Write a field\./)
	assert.match(t.system, /never as native tool calls/)
	assert.match(t.prompt, /\[user\]\nBrief: a rover\.[\s\S]*\[you called read_contract\] \{\}[\s\S]*\[result of your call\]\n\{"revision":3\}[\s\S]*\[your turn\]$/)
})

test("claude -p's structured answer becomes Mozaik's message and function-call items; an unknown tool becomes words", async () => {
	// A stand-in for the claude CLI (no subscription used): it prints what claude -p --output-format json prints.
	const dir = tempDir()
	const bin = join(dir, "claude")
	const answer = { is_error: false, structured_output: { message: "writing motion", calls: [{ name: "propose_contract_change", arguments: { field: "motion" } }, { name: "rm_rf", arguments: {} }] }, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } }
	writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho '${JSON.stringify(answer)}'\n`)
	chmodSync(bin, 0o755)
	process.env.BRINGUP_CLAUDE_BIN = bin
	try {
		const ctx = ModelContext.create().addContextItem(UserMessageItem.create("go"))
		const out = await new ClaudeCodeRunner().run({ model: "cc-haiku", context: ctx, tools: [TOOL] } as never)
		const types = out.items.map((i) => (i as { type: string }).type)
		assert.deepEqual(types, ["message", "function_call", "message"])
		assert.equal((out.items[1] as FunctionCallItem).name, "propose_contract_change")
		assert.deepEqual(JSON.parse((out.items[1] as FunctionCallItem).args), { field: "motion" })
		assert.equal(out.tokenUsage?.totalTokens, 105)
	} finally {
		delete process.env.BRINGUP_CLAUDE_BIN
	}
})

test("BRINGUP_PROVIDER=claude-code: the architect and reviewer on Sonnet, the rest on Haiku; fast puts all on Haiku", () => {
	const env = { BRINGUP_PROVIDER: "claude-code" }
	assert.equal(modelFor("architect", false, env), "cc-sonnet")
	assert.equal(modelFor("parts", false, env), "cc-haiku")
	assert.equal(modelFor("architect", false, { ...env, BRINGUP_MODELS: "fast" }), "cc-haiku")
	assert.equal(modelFor("architect", true, env), "mock-architect")
})

// Rover run cc-eurobot-14 (16 Nov 2026): the reviewer's answer failed the CLI's schema six times and the review was lost;
// the runner asks once more for plain-text JSON and reads it from the reply.
test("an answer's JSON is read from a plain-text reply, fenced or not, with nested arguments", async () => {
	const { answerFromText } = await import("../src/inference/claude-code-runner.ts")
	const call = { name: "submit_review", arguments: { verdict: "pass", findings: [{ severity: "minor", fields: ["rails"], issue: "a {brace} in text" }] } }
	assert.deepEqual(answerFromText(`Here it is:\n\`\`\`json\n${JSON.stringify({ message: null, calls: [call] })}\n\`\`\`\nDone.`)?.calls, [call])
	assert.deepEqual(answerFromText(`Review follows. ${JSON.stringify({ message: "ok", calls: [call] })}`)?.calls, [call])
	assert.equal(answerFromText("no json here {not: valid}"), null)
})

// The cost report of 23 Nov 2026 could not split cache reads from plain input, name the agent behind a call, or say
// which model answered: usage.jsonl now records all three for subscription calls.
test("a subscription call is logged with cache reads apart, the agent that made it and the model that answered", async () => {
	const { UsageRunner, roleContextId } = await import("../src/inference/usage.ts")
	const dir = tempDir()
	const bin = join(dir, "claude")
	const answer = { is_error: false, structured_output: { message: null, calls: [] }, usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500, output_tokens: 200 }, modelUsage: { "claude-haiku-4-5": { outputTokens: 200 }, "claude-sonnet-4-6": { outputTokens: 3 } } }
	writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho '${JSON.stringify(answer)}'\n`)
	chmodSync(bin, 0o755)
	process.env.BRINGUP_CLAUDE_BIN = bin
	try {
		const rows: Record<string, unknown>[] = []
		const ctx = ModelContext.rehydrate({ id: roleContextId("parts", "x1"), items: [] }).addContextItem(UserMessageItem.create("go"))
		await new UsageRunner(new ClaudeCodeRunner(), (r) => rows.push(r as never), "agents").run({ model: "cc-haiku", context: ctx, tools: [TOOL] } as never)
		const r = rows[0]
		assert.equal(r.participant, "parts")
		assert.equal(r.servedBy, "claude-haiku-4-5")
		assert.equal(r.inputTokens, 10_500)
		assert.equal(r.cachedTokens, 9000)
		assert.equal(r.cacheWriteTokens, 500)
		assert.equal(r.usd, 0)
		// Haiku 4.5: 1000 uncached at $1, 9000 read at $0.10, 500 written at $1.25, 200 out at $5 (per million).
		assert.ok(Math.abs((r.apiUsd as number) - (1000 * 1 + 9000 * 0.1 + 500 * 1.25 + 200 * 5) / 1e6) < 1e-12)
	} finally {
		delete process.env.BRINGUP_CLAUDE_BIN
	}
})
