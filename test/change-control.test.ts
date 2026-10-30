import { test } from "node:test"
import assert from "node:assert/strict"
import { FunctionCallOutputItem, ModelMessageItem, UserMessageItem, type ContextItem } from "@mozaik-ai/core"
import { BringupState, join, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { createChangeDesk, ownerReviewsChanges } from "../src/change-control.ts"
import { createRoleAgent, startTurn } from "../src/agents/common.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

const pins = [{ signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }]

function lastText(items: ContextItem[]): string {
	const last = items.at(-1)
	if (last instanceof UserMessageItem) return last.content.text
	if (last instanceof FunctionCallOutputItem) return last.output.text
	return ""
}

// Proposes `pins` once, then answers with a message once the tool output is back.
const proposer: Script = (items) =>
	items.at(-1) instanceof FunctionCallOutputItem
		? [ModelMessageItem.rehydrate({ text: "done" })]
		: [toolCall("propose_contract_change", { field: "pins", value: pins, baseVersion: 0, reason: "need a status LED" })]

function decider(approve: boolean): Script {
	return (items) => {
		const id = /proposalId=([\w-]+)/.exec(lastText(items))?.[1]
		return id ? [toolCall("decide_change", { proposalId: id, approve, reason: approve ? "ok" : "pin reserved" })] : [ModelMessageItem.rehydrate({ text: "decided" })]
	}
}

function setup(scripts: Record<string, Script>, approvalTimeoutMs = 2000) {
	const state = new BringupState(tempDir(), approvalTimeoutMs)
	startRuntime(state, inferenceConfig(true, scripts), null)
	const events = recorder()
	join(createChangeDesk())
	const architect = createRoleAgent({ role: "architect", instruction: "owner", handlers: [ownerReviewsChanges("architect")], mock: true })
	const firmware = createRoleAgent({ role: "firmware", instruction: "requester", handlers: [], mock: true })
	return { state, events, architect, firmware, types: () => events.map((e) => e.type) }
}

test("owner change applies without interception", async () => {
	const t = setup({ "mock-architect": proposer, "mock-firmware": proposer })
	startTurn(t.architect, "set pins")
	await waitFor(() => t.types().includes("contract.changed"))
	assert.equal(t.state.contract.version("pins"), 1)
	assert.ok(!t.types().includes("change.proposed"))
})

test("non-owner change is held then applied on approval", async () => {
	const t = setup({ "mock-architect": decider(true), "mock-firmware": proposer })
	startTurn(t.firmware, "add a status LED")
	await waitFor(() => t.types().includes("contract.changed"))
	const order = t.types().filter((x) => ["change.proposed", "change.decided", "contract.changed"].includes(x))
	assert.deepEqual(order, ["change.proposed", "change.decided", "contract.changed"])
	const changed = t.events.find((e) => e.type === "contract.changed")!
	assert.equal((changed.payload as { by: string }).by, "firmware")
	assert.deepEqual(t.state.contract.get("pins"), pins)
})

test("rejected change returns output to the model", async () => {
	const seen: string[] = []
	const firmware: Script = (items) => {
		seen.push(lastText(items))
		return proposer(items)
	}
	const t = setup({ "mock-architect": decider(false), "mock-firmware": firmware })
	startTurn(t.firmware, "add a status LED")
	await waitFor(() => seen.some((s) => s.startsWith("rejected:")))
	assert.equal(t.state.contract.version("pins"), 0)
})

test("timeout rejects", async () => {
	const seen: string[] = []
	const firmware: Script = (items) => {
		seen.push(lastText(items))
		return proposer(items)
	}
	const silent: Script = () => [ModelMessageItem.rehydrate({ text: "not now" })]
	const t = setup({ "mock-architect": silent, "mock-firmware": firmware }, 200)
	const start = Date.now()
	startTurn(t.firmware, "add a status LED")
	await waitFor(() => seen.some((s) => s === "rejected: timeout"))
	assert.ok(Date.now() - start < 2000)
	assert.equal(t.state.contract.version("pins"), 0)
})

test("deciding an unknown proposal is reported to the model", async () => {
	const t = setup({ "mock-architect": decider(true), "mock-firmware": proposer })
	const decide = t.architect.getTools().find((x) => x.name === "decide_change")!
	assert.equal(await decide.invoke({ proposalId: "nope:", approve: true, reason: "x" }), 'unknown proposalId "nope:"')
	assert.ok(!t.types().includes("change.decided"))
})
