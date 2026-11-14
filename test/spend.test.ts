import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { checkSpend, recordSpend, SpendCapReached, spendCap, spentUsd } from "../src/inference/spend.ts"
import { UsageRunner, usageRecord } from "../src/inference/usage.ts"
import { tempDir } from "./helpers.ts"

const envAt = (cap?: string) => ({ BRINGUP_SPEND_LEDGER: join(tempDir(), "spend.jsonl"), ...(cap !== undefined ? { BRINGUP_SPEND_CAP_USD: cap } : {}) })

test("the ledger sums every recorded call; an unknown price counts as the dearest call", () => {
	const env = envAt("30")
	recordSpend(usageRecord("gpt-5.4", "architect", 1_000_000, 0, 0), "/r1", env)
	recordSpend(usageRecord("gpt-5.4-mini", "parts", 1_000_000, 0, 0), "/r2", env)
	recordSpend(usageRecord("gpt-5.4", "architect", null, null, null), "/r2", env)
	assert.deepEqual(spentUsd(env), { usd: 2.5 + 0.75 + 2.5, calls: 3 })
})

test("no cap: never refused; at the cap: refused", () => {
	const env = envAt()
	recordSpend(usageRecord("gpt-5.4", "a", 20_000_000, 0, 0), "/r", env)
	assert.equal(spendCap(env), null)
	assert.doesNotThrow(() => checkSpend(env))
	assert.throws(() => checkSpend({ ...env, BRINGUP_SPEND_CAP_USD: "30" }), SpendCapReached)
	assert.doesNotThrow(() => checkSpend({ ...env, BRINGUP_SPEND_CAP_USD: "60" }))
})

test("the cap can live in cap.json beside the ledger; the environment overrides it", async () => {
	const env = envAt()
	const { writeFileSync } = await import("node:fs")
	const { dirname } = await import("node:path")
	writeFileSync(join(dirname(env.BRINGUP_SPEND_LEDGER), "cap.json"), JSON.stringify({ capUsd: 30 }))
	assert.equal(spendCap(env), 30)
	assert.equal(spendCap({ ...env, BRINGUP_SPEND_CAP_USD: "5" }), 5)
})

test("an agent's model call past the cap doesn't reach the provider", async () => {
	const env = envAt("1")
	recordSpend(usageRecord("gpt-5.4", "a", 1_000_000, 0, 0), "/r", env)
	const saved = { ...process.env }
	Object.assign(process.env, env)
	let called = 0
	const inner = { run: async () => { called++; return {} }, stream: async function* () {} } as never
	try {
		await assert.rejects(new UsageRunner(inner, () => {}, "agents").run({ model: "gpt-5.4" } as never), SpendCapReached)
		assert.equal(called, 0)
	} finally {
		process.env = saved
	}
})
