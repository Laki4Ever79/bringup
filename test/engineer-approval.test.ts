import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { FunctionCallOutputItem, ModelMessageItem, UserMessageItem, type ContextItem } from "@mozaik-ai/core"
import { BringupState, join, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { createChangeDesk, ownerReviewsChanges } from "../src/change-control.ts"
import { createRoleAgent, startTurn } from "../src/agents/common.ts"
import { appendDecision, watchDecisions } from "../src/runner/decisions.ts"
import { createEngineer } from "../src/agents/engineer.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 200)))

const pins = [{ signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }]
const lastText = (items: ContextItem[]) => {
	const l = items.at(-1)
	return l instanceof UserMessageItem ? l.content.text : l instanceof FunctionCallOutputItem ? l.output.text : ""
}
const proposer: Script = (items) =>
	items.at(-1) instanceof FunctionCallOutputItem
		? [ModelMessageItem.rehydrate({ text: "done" })]
		: [toolCall("propose_contract_change", { field: "pins", value: pins, baseVersion: 0, reason: "status LED" })]
const ownerApproves: Script = (items) => {
	const id = /proposalId=([\w-]+)/.exec(lastText(items))?.[1]
	return id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "GPIO10 is free" })] : [ModelMessageItem.rehydrate({ text: "ok" })]
}

function setup(engineerApproval: boolean, approvalTimeoutMs = 3000) {
	const outDir = tempDir()
	const state = new BringupState(outDir, approvalTimeoutMs)
	state.engineerApproval = engineerApproval
	startRuntime(state, inferenceConfig(true, { "mock-architect": ownerApproves, "mock-firmware": proposer }), null)
	const events = recorder()
	join(createChangeDesk())
	const engineer = createEngineer()
	join(engineer)
	const watcher = watchDecisions(outDir, (d) => engineer.decide(d))
	createRoleAgent({ role: "architect", instruction: "owner", handlers: [ownerReviewsChanges("architect")], mock: true })
	const firmware = createRoleAgent({ role: "firmware", instruction: "requester", handlers: [], mock: true })
	const of = (type: string) => events.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>)
	return { outDir, state, firmware, of, close: () => watcher.close() }
}

test("with engineer approval a change waits for the engineer after the owner approves", async () => {
	const t = setup(true)
	startTurn(t.firmware, "add a status LED")
	await waitFor(() => t.of("change.decided").some((d) => d.by === "architect"))
	assert.equal(t.of("change.proposed")[0].needsEngineer, true)
	await new Promise((r) => setTimeout(r, 200))
	assert.equal(t.state.contract.version("pins"), 0, "applied before the engineer decided")
	appendDecision(t.outDir, { proposalId: t.of("change.proposed")[0].proposalId as string, approve: true, reason: "looks good" })
	await waitFor(() => t.state.contract.version("pins") === 1)
	assert.deepEqual(t.of("change.resolved").map((r) => [r.approved, r.decidedBy]), [[true, ["architect", "engineer"]]])
	t.close()
})

test("the engineer can reject a change the owner approved", async () => {
	const t = setup(true)
	startTurn(t.firmware, "add a status LED")
	await waitFor(() => t.of("change.proposed").length === 1)
	appendDecision(t.outDir, { proposalId: t.of("change.proposed")[0].proposalId as string, approve: false, reason: "keep GPIO10 free" })
	await waitFor(() => t.of("change.resolved").length === 1)
	assert.equal(t.of("change.resolved")[0].approved, false)
	assert.equal(t.of("change.resolved")[0].reason, "keep GPIO10 free")
	assert.equal(t.state.contract.version("pins"), 0)
	t.close()
})

test("without engineer approval the owner's vote resolves the change", async () => {
	const t = setup(false)
	startTurn(t.firmware, "add a status LED")
	await waitFor(() => t.of("change.resolved").length === 1)
	assert.equal(t.of("change.proposed")[0].needsEngineer, false)
	assert.deepEqual(t.of("change.resolved")[0].decidedBy, ["architect"])
	await waitFor(() => t.state.contract.version("pins") === 1)
	t.close()
})

test("an engineer vote on an ungated change is ignored", async () => {
	const { ApprovalRegistry } = await import("../src/approvals.ts")
	const r = new ApprovalRegistry()
	const id = r.open("pins", "firmware", "[]", false)
	assert.equal(r.resolve(id, { approved: true, by: "engineer", reason: "x" }), false)
	assert.equal(r.decisionOf(id), undefined)
})
