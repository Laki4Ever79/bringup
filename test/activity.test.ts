import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import { createActivityParticipant, describeLoopEvent, summarizeArgs, summarizeResult } from "../src/agents/activity.ts"
import { BringupState, emit, join, startRuntime, state } from "../src/runtime.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 50)))

const call = (name: string, args: object) => ({ call: { type: "function_call", callId: "c1", name, args: JSON.stringify(args) }, loopId: "l1" })

test("each Mozaik loop event maps to a phase and a short text", () => {
	assert.deepEqual(describeLoopEvent("message_received.started", { content: "Brief from the engineer:\nBLE logger", loopId: "l" }), { phase: "turn", text: "Brief from the engineer: BLE logger" })
	assert.deepEqual(describeLoopEvent("inference.started", { model: "gpt", loopId: "l" }), { phase: "thinking", text: "thinking…" })
	assert.deepEqual(describeLoopEvent("function_call.started", call("decide_change", { proposalId: "p-1", approve: true, reason: "ok" })), { phase: "tool", text: "decide_change: approve p-1" })
	assert.deepEqual(describeLoopEvent("function_call.completed", { type: "function_call_output", callId: "c1", output: { text: '{"status":"applied","version":2,"revision":9}' } }), { phase: "tool-result", text: "applied (v2, rev 9)" })
	assert.deepEqual(describeLoopEvent("model.answer", { answer: { type: "message", role: "assistant", content: { text: "Contract drafted." } } }), { phase: "answer", text: "Contract drafted." })
	assert.deepEqual(describeLoopEvent("interception.started", { nextStateId: "function_call", input: call("propose_contract_change", { field: "pins", value: [], baseVersion: 1, reason: "" }) }), { phase: "held", text: "held for approval: propose_contract_change pins" })
	assert.deepEqual(describeLoopEvent("interception.finished", { nextStateId: "function_call", input: call("propose_contract_change", { field: "pins" }) }), { phase: "released", text: "released: propose_contract_change" })
	assert.equal(describeLoopEvent("inference.stream", {}), null)
	assert.equal(describeLoopEvent("contract.changed", {}), null)
})

test("texts are capped: turn 200, tool 160, answer 300 characters", () => {
	const long = "x".repeat(1000)
	assert.ok(describeLoopEvent("message_received.started", { content: long })!.text.length <= 200)
	assert.ok(describeLoopEvent("model.answer", { answer: { content: { text: long } } })!.text.length <= 300)
	assert.ok(describeLoopEvent("function_call.started", call("search_parts", { role: long }))!.text.length <= 160)
})

test("tool arguments are summarised, never dumped", () => {
	const parts = Array.from({ length: 20 }, (_, i) => ({ ref: `U${i}`, mpn: "ESP32-C3-MINI-1", pins: ["GPIO0", "GPIO1"] }))
	const s = summarizeArgs("propose_contract_change", JSON.stringify({ field: "parts", value: parts, baseVersion: 1, reason: "parts from the catalog" }))
	assert.equal(s, "parts ← 20 items (base v1): parts from the catalog")
	assert.equal(summarizeArgs("propose_contract_change", JSON.stringify({ field: "outline", value: { widthMm: 60, heightMm: 30, thicknessMm: 1.6 }, baseVersion: 1, reason: "wider" })), 'outline ← {"widthMm":60,"heightMm":30,"thicknessMm":1.6} (base v1): wider')
	assert.equal(summarizeArgs("search_parts", JSON.stringify({ role: "ldo" })), "role=ldo")
	assert.equal(summarizeArgs("read_contract", "{}"), "")
	assert.equal(summarizeArgs("submit_review", JSON.stringify({ verdict: "pass", findings: [{}, {}] })), "pass, 2 findings")
	assert.equal(summarizeArgs("weird", "not json"), "not json")
})

test("tool results are summarised", () => {
	assert.equal(summarizeResult('{"status":"stale","current":3}'), "stale (current v3)")
	assert.equal(summarizeResult('{"status":"not-owner","owner":"architect"}'), "not-owner (architect decides)")
	assert.equal(summarizeResult('{"revision":7,"values":{},"versions":{}}'), "contract at rev 7")
	assert.equal(summarizeResult('[{"mpn":"a"},{"mpn":"b"}]'), "2 results")
	assert.equal(summarizeResult("recorded"), "recorded")
})

test("the participant emits agent.activity for agents only and collapses repeated thinking", async () => {
	const s = new BringupState(tempDir())
	startRuntime(s, undefined, null)
	const events = recorder()
	join(createActivityParticipant())
	const agent = createHuman({ name: "architect", capabilities: [], handlers: [] })
	join(agent)
	state().roles.set(agent.getId(), "architect")
	const builder = createHuman({ name: "board-builder", capabilities: [], handlers: [] })
	join(builder)
	const loop = (type: string, payload: object, from = agent.getId()) => emit(SemanticEvent.create(type, from, { ...payload, loopId: "l1" }), from)

	loop("message_received.started", { content: "Brief from the engineer: logger" })
	loop("inference.started", {})
	loop("inference.started", {})
	loop("inference.started", {})
	loop("function_call.started", call("read_contract", {}))
	loop("function_call.completed", { output: { text: '{"revision":1,"values":{},"versions":{}}' } })
	loop("inference.started", {})
	loop("model.answer", { answer: { content: { text: "done" } } })
	loop("inference.started", {}, builder.getId())

	await waitFor(() => events.filter((e) => e.type === "agent.activity").length >= 6)
	await new Promise((r) => setTimeout(r, 50))
	const activity = events.filter((e) => e.type === "agent.activity").map((e) => e.payload as any)
	assert.deepEqual(activity.map((a) => a.phase), ["turn", "thinking", "tool", "tool-result", "thinking", "answer"])
	assert.ok(activity.every((a) => a.agentId === agent.getId() && a.role === "architect" && a.name === "architect"))
	assert.ok(activity.every((a) => !Number.isNaN(Date.parse(a.at))))
	assert.equal(activity[2].text, "read_contract")
})
