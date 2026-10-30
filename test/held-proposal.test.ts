import { test } from "node:test"
import assert from "node:assert/strict"
import { createHuman } from "@mozaik-ai/core"
import { BringupState, join, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import type { Script } from "../src/inference/scripted-runner.ts"
import { createChangeDesk, ownerReviewsChanges, proposeHeld } from "../src/change-control.ts"
import { createRoleAgent } from "../src/agents/common.ts"
import { toolCall } from "../src/inference/scripted-runner.ts"
import { ModelMessageItem, UserMessageItem } from "@mozaik-ai/core"
import { recorder, tempDir } from "./helpers.ts"

const rails = [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 120, averageMa: 0.0375 }]
const measured = [{ ...rails[0], averageMa: 0.052, averageSource: "measured" as const, measuredRevision: 9 }]

function decider(approve: boolean): Script {
	return (items) => {
		const last = items.at(-1)
		const id = last instanceof UserMessageItem ? /proposalId=([\w-]+)/.exec(last.content.text)?.[1] : undefined
		return id ? [toolCall("decide_change", { proposalId: id, approve, reason: approve ? "measured beats estimated" : "the bench board is not the design" })] : [ModelMessageItem.rehydrate({ text: "decided" })]
	}
}

function setup(approve: boolean) {
	const state = new BringupState(tempDir(), 2000)
	startRuntime(state, inferenceConfig(true, { "mock-architect": decider(approve) }), null)
	const events = recorder()
	join(createChangeDesk())
	createRoleAgent({ role: "architect", instruction: "owner", handlers: [ownerReviewsChanges("architect")], mock: true })
	const bench = createHuman({ name: "bench", capabilities: [], handlers: [] })
	join(bench)
	state.roles.set(bench.getId(), "bench")
	state.contract.propose({ field: "rails", value: rails, by: "architect", baseVersion: 0 })
	return { state, events, bench }
}

test("a plain-code participant's proposal is held until the owner approves, then applied as contract.changed", async () => {
	const t = setup(true)
	const result = await proposeHeld({ selfId: t.bench.getId(), role: "bench", field: "rails", value: measured, reason: "measured 0.052 mA on the bench" })
	assert.equal(result.status, "applied")
	assert.equal(t.state.contract.get("rails")?.[0].averageSource, "measured")
	const types = t.events.map((e) => e.type)
	assert.ok(types.indexOf("change.proposed") < types.indexOf("change.resolved"))
	assert.ok(types.indexOf("change.resolved") < types.indexOf("contract.changed"))
	const changed = t.events.find((e) => e.type === "contract.changed")!.payload as { field: string; by: string }
	assert.deepEqual([changed.field, changed.by], ["rails", "bench"])
	const proposed = t.events.find((e) => e.type === "change.proposed")!
	assert.equal(proposed.producerId, t.bench.getId())
})

test("a rejected plain-code proposal leaves the contract alone and reports the reason", async () => {
	const t = setup(false)
	const result = await proposeHeld({ selfId: t.bench.getId(), role: "bench", field: "rails", value: measured, reason: "measured" })
	assert.deepEqual(result, { status: "rejected", reason: "the bench board is not the design" })
	assert.equal(t.state.contract.get("rails")?.[0].averageMa, 0.0375)
	assert.ok(!t.events.some((e) => e.type === "contract.changed"))
})

test("a value the owner approved is still checked by plain code when it is applied", async () => {
	const t = setup(true)
	const sneaky = [{ ...measured[0], loadMa: 50 }]
	const result = await proposeHeld({ selfId: t.bench.getId(), role: "bench", field: "rails", value: sneaky, reason: "measured" })
	assert.equal(result.status, "invalid")
	assert.equal(t.state.contract.get("rails")?.[0].loadMa, 120)
})
