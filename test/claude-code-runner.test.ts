import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FunctionCallItem, FunctionCallOutputItem, ModelContext, SystemMessageItem, UserMessageItem } from "@mozaik-ai/core"
import { ClaudeCodeRunner, transcriptOf } from "../src/inference/claude-code-runner.ts"
import { modelFor } from "../src/inference/models.ts"

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
	const dir = mkdtempSync(join(tmpdir(), "bringup-cc-"))
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
