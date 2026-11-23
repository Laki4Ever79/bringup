import { test } from "node:test"
import assert from "node:assert/strict"
import { FunctionCallOutputItem, ModelMessageItem, UserMessageItem, type ContextItem, type Tool } from "@mozaik-ai/core"
import { BringupState, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { createRoleAgent, requestTurn, startTurn } from "../src/agents/common.ts"
import { tempDir, waitFor } from "./helpers.ts"

// One live turn per agent (lead-2's 20b analysis, 23 Nov 2026: the parts agent ran 29 overlapping turns in one Eurobot
// run). Each turn calls `hold`, which waits until the test releases it, so the test decides when a turn ends.

function setup() {
	const started: string[] = []
	const holds: (() => void)[] = []
	const hold: Tool = {
		type: "function",
		name: "hold",
		description: "wait",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		strict: false,
		invoke: () => new Promise<string>((r) => holds.push(() => r("released"))),
	} as Tool
	// The turn's first call records its message and holds; once the hold returns, it answers and the turn ends.
	const script: Script = (items: ContextItem[]) => {
		if (items.at(-1) instanceof FunctionCallOutputItem) return [ModelMessageItem.rehydrate({ text: "done" })]
		const first = items.find((i) => i instanceof UserMessageItem) as UserMessageItem
		started.push(first.content.text.split("\n\n# Design facts")[0])
		return [toolCall("hold", {})]
	}
	const state = new BringupState(tempDir(), 2000)
	startRuntime(state, inferenceConfig(true, { "mock-parts": script }), null)
	const parts = createRoleAgent({ role: "parts", instruction: "parts", handlers: [], tools: [hold], mock: true })
	// Ends the oldest live turn (its hold returns).
	return { parts, started, release: () => holds.shift()?.() }
}

test("wakes during a turn wait as one follow-up per kind, the latest kept; it runs when the turn ends", async () => {
	const t = setup()
	requestTurn(t.parts, "v@1", "violations at revision 1", { kind: "violation", revision: 1, items: [] })
	await waitFor(() => t.started.length === 1)
	requestTurn(t.parts, "v@2", "violations at revision 2", { kind: "violation", revision: 2, items: [] })
	requestTurn(t.parts, "v@3", "violations at revision 3", { kind: "violation", revision: 3, items: [] })
	requestTurn(t.parts, "r@3", "review findings at revision 3", { kind: "review", revision: 3, items: [] })
	await new Promise((r) => setTimeout(r, 50))
	assert.deepEqual(t.started, ["violations at revision 1"], "no second turn while the first is live")
	t.release()
	await waitFor(() => t.started.length === 2)
	assert.equal(t.started[1], "violations at revision 3\n\nreview findings at revision 3", "one follow-up: the latest of each kind")
	t.release()
	await new Promise((r) => setTimeout(r, 50))
	assert.equal(t.started.length, 2, "nothing else was waiting")
})

test("a follow-up whose situation no longer holds is dropped", async () => {
	const t = setup()
	requestTurn(t.parts, "v@1", "violations at revision 1", { kind: "violation", revision: 1, items: [] })
	await waitFor(() => t.started.length === 1)
	let open = true
	requestTurn(t.parts, "v@2", "violations at revision 2", { kind: "violation", revision: 2, items: [] }, () => open)
	open = false
	t.release()
	await new Promise((r) => setTimeout(r, 100))
	assert.deepEqual(t.started, ["violations at revision 1"])
})

test("requests that must run are queued in order, never coalesced; decide prompts start at once", async () => {
	const t = setup()
	startTurn(t.parts, "engineer request A")
	await waitFor(() => t.started.length === 1)
	startTurn(t.parts, "engineer request B")
	startTurn(t.parts, "engineer request C")
	requestTurn(t.parts, "v@5", "violations at revision 5", { kind: "violation", revision: 5, items: [] })
	startTurn(t.parts, "Change request proposalId=x", undefined, { now: true })
	await waitFor(() => t.started.length === 2)
	assert.equal(t.started[1], "Change request proposalId=x", "a decide prompt doesn't wait (the proposer's turn is held on it)")
	t.release() // ends one of the two live turns: the agent is still busy
	await new Promise((r) => setTimeout(r, 50))
	assert.equal(t.started.length, 2)
	t.release()
	await waitFor(() => t.started.length === 3)
	assert.equal(t.started[2], "engineer request B")
	t.release()
	await waitFor(() => t.started.length === 4)
	assert.equal(t.started[3], "engineer request C")
	t.release()
	await waitFor(() => t.started.length === 5)
	assert.equal(t.started[4], "violations at revision 5", "the pending wake after the queue")
	t.release()
})
