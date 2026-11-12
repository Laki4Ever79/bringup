// The plan store's part learning (src/dashboard/plans.ts): one budget per plan, a need still learning is never
// started twice, and learning interrupted by a restart doesn't block Build forever.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PlanStore } from "../src/dashboard/plans.ts"
import type { LearnDeps, LearnResult } from "../src/learn/learner.ts"
import type { PartNeed } from "../src/learn/types.ts"
import { learnNeeds } from "../src/learn/runtime.ts"
import { tempDir } from "./helpers.ts"

const SENTENCE = "a talking clock with a speaker"

function gated() {
	let open!: () => void
	const gate = new Promise<void>((r) => (open = r))
	const calls: { need: string; deps: LearnDeps }[] = []
	const learn = async (need: PartNeed, deps: LearnDeps): Promise<LearnResult> => {
		calls.push({ need: need.id, deps })
		await gate
		return { status: "unavailable", reasons: [{ mpn: "", reason: "test" }] }
	}
	return { learn, calls, open }
}

const settled = async (store: PlanStore, id: string) => {
	for (let i = 0; i < 100 && store.learning(id).some((l) => l.status === "learning"); i++) await new Promise((r) => setTimeout(r, 20))
}

test("build is refused while a need is learning, and allowed once it's done", async () => {
	const g = gated()
	const store = new PlanStore(tempDir(), { learn: g.learn })
	const plan = await store.create(SENTENCE, true)
	assert.throws(() => store.buildTarget(plan.id), /still being learned/)
	g.open()
	await settled(store, plan.id)
	assert.equal(store.buildTarget(plan.id).kind, "board")
})

test("a change while learning doesn't start the same need again, and the plan keeps one budget", async () => {
	const g = gated()
	const store = new PlanStore(tempDir(), { learn: g.learn })
	const plan = await store.create(SENTENCE, true)
	await store.change(plan.id, "make it red", true)
	for (let i = 0; i < 100 && g.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
	await new Promise((r) => setTimeout(r, 50))
	assert.deepEqual(g.calls.map((c) => c.need).sort(), ["amplifier", "speaker"])
	assert.equal(g.calls[0].deps.budget, g.calls[1].deps.budget)
	g.open()
	await settled(store, plan.id)
})

test("the plan's budget starts from what its learning already spent", async () => {
	const g = gated()
	const out = tempDir()
	const store = new PlanStore(out, { learn: g.learn, env: { BRINGUP_LEARN_CAP_USD: "2" } })
	const plan = await store.create(SENTENCE, true)
	g.open()
	await settled(store, plan.id)
	appendFileSync(join(out, "plans", plan.id, "usage.jsonl"), JSON.stringify({ at: "x", model: "gpt-5.4-mini", source: "part-learner", inputTokens: 1, cachedTokens: 0, outputTokens: 1, usd: 1.5 }) + "\n")
	writeFileSync(join(out, "plans", plan.id, "learning.json"), "[]")
	const g2 = gated()
	const again = new PlanStore(out, { learn: g2.learn, env: { BRINGUP_LEARN_CAP_USD: "2" } })
	await again.change(plan.id, "make it red", true)
	for (let i = 0; i < 100 && !g2.calls.length; i++) await new Promise((r) => setTimeout(r, 10))
	assert.ok(Math.abs(g2.calls[0].deps.budget.spent - 1.5) < 1e-9)
	g2.open()
	await settled(again, plan.id)
})

test("learning a restart interrupted is shown unavailable and doesn't block Build", async () => {
	const out = tempDir()
	const g = gated()
	const store = new PlanStore(out, { learn: g.learn })
	const plan = await store.create(SENTENCE, true)
	// A new store on the same folder: the dashboard restarted while learning.
	const restarted = new PlanStore(out, { learn: gated().learn })
	const l = restarted.learning(plan.id)
	assert.ok(l.every((x) => x.status === "unavailable" && /interrupted/.test(x.reasons?.[0]?.reason ?? "")), JSON.stringify(l))
	assert.equal(restarted.buildTarget(plan.id).kind, "board")
	g.open()
})

test("an update callback that throws doesn't stop learning from finishing", async () => {
	const out = await learnNeeds([{ id: "a", role: "amplifier", kind: "amplifier", requirements: "x" }], {
		deps: {} as LearnDeps,
		learn: async () => ({ status: "unavailable", reasons: [{ mpn: "", reason: "t" }] }),
		onUpdate: (u) => {
			if (u.result) throw new Error("disk full")
		},
	})
	assert.equal(out.get("a")?.status, "unavailable")
})
