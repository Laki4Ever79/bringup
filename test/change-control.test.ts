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

test("an already-approved call is not intercepted again", async () => {
	const { ChangeControl } = await import("../src/change-control.ts")
	const { FunctionCallItem } = await import("@mozaik-ai/core")
	const t = setup({ "mock-architect": decider(true), "mock-firmware": proposer })
	const id = t.state.approvals.open("pins", "firmware")
	t.state.approvals.resolve(id, { approved: true, by: "architect", reason: "ok" })
	const call = (args: object) => FunctionCallItem.rehydrate({ callId: "c", name: "propose_contract_change", args: JSON.stringify(args) })
	const cc = new ChangeControl(t.firmware.getId())
	const transition = (args: object) => ({ nextStateId: "function_call", input: { call: call(args), inferenceInput: {} } }) as never
	assert.equal(cc.isSatisfiedBy(transition({ field: "pins", value: [], baseVersion: 1, reason: "x", approvalId: id })), false)
	assert.equal(cc.isSatisfiedBy(transition({ field: "pins", value: [], baseVersion: 1, reason: "x" })), true)
	assert.equal(cc.isSatisfiedBy(transition({ field: "outline", value: {}, baseVersion: 1, reason: "x", approvalId: id })), true)
})

test("only the field's owner can decide a change", async () => {
	const t = setup({ "mock-architect": decider(true), "mock-firmware": proposer })
	const id = t.state.approvals.open("pins", "firmware")
	const decide = t.firmware.getTools().find((x) => x.name === "decide_change")!
	assert.match(String(await decide.invoke({ proposalId: id, approve: true, reason: "self-approval" })), /not the owner/)
	assert.ok(!t.types().includes("change.decided"))
})

test("an approved change still applies when the owner edited the field while it was held", async () => {
	// The owner edits pins while the request is held, then approves: the requester's value must land.
	const ownerEdit = [{ signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" }]
	const decideAfterEdit: Script = (items) => {
		const id = /proposalId=([\w-]+)/.exec(lastText(items))?.[1]
		if (!id) return [ModelMessageItem.rehydrate({ text: "decided" })]
		const { state } = t
		state.contract.propose({ field: "pins", value: ownerEdit, by: "architect", baseVersion: state.contract.version("pins") })
		return [toolCall("decide_change", { proposalId: id, approve: true, reason: "ok" })]
	}
	const t = setup({ "mock-architect": decideAfterEdit, "mock-firmware": proposer })
	startTurn(t.firmware, "add a status LED")
	await waitFor(() => t.events.some((e) => e.type === "contract.changed" && (e.payload as { by: string }).by === "firmware"))
	assert.deepEqual(t.state.contract.get("pins"), pins)
})

test("an approval covers only the value that was proposed", async () => {
	const { ChangeControl } = await import("../src/change-control.ts")
	const { FunctionCallItem } = await import("@mozaik-ai/core")
	const t = setup({ "mock-architect": decider(true), "mock-firmware": proposer })
	const id = t.state.approvals.open("pins", "firmware", JSON.stringify(pins))
	t.state.approvals.resolve(id, { approved: true, by: "architect", reason: "ok" })
	const cc = new ChangeControl(t.firmware.getId())
	const transition = (value: unknown) =>
		({ nextStateId: "function_call", input: { call: FunctionCallItem.rehydrate({ callId: "c", name: "propose_contract_change", args: JSON.stringify({ field: "pins", value, baseVersion: 0, reason: "x", approvalId: id }) }), inferenceInput: {} } }) as never
	assert.equal(cc.isSatisfiedBy(transition(pins)), false)
	assert.equal(cc.isSatisfiedBy(transition([])), true)
})

test("a change identical to the current value is not held and applies nothing", async () => {
	const t = setup({ "mock-architect": decider(true), "mock-firmware": proposer })
	t.state.contract.propose({ field: "pins", value: pins, by: "architect", baseVersion: 0 })
	const before = t.state.contract.revision
	startTurn(t.firmware, "add a status LED")
	await new Promise((r) => setTimeout(r, 300))
	assert.ok(!t.types().includes("change.proposed"))
	assert.equal(t.state.contract.revision, before)
})

test("a timed-out request is recorded as a rejected decision", async () => {
	const silent: Script = () => [ModelMessageItem.rehydrate({ text: "not now" })]
	const t = setup({ "mock-architect": silent, "mock-firmware": proposer }, 200)
	startTurn(t.firmware, "add a status LED")
	await waitFor(() => t.types().includes("change.decided"))
	const d = t.events.find((e) => e.type === "change.decided")!.payload as { approved: boolean; reason: string; by: string }
	assert.deepEqual({ approved: d.approved, reason: d.reason, by: d.by }, { approved: false, reason: "timeout", by: "architect" })
	const id = (t.events.find((e) => e.type === "change.proposed")!.payload as { proposalId: string }).proposalId
	const decide = t.architect.getTools().find((x) => x.name === "decide_change")!
	assert.match(String(await decide.invoke({ proposalId: id, approve: true, reason: "late" })), /already decided/)
})
