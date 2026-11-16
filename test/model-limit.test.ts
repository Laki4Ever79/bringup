// Run cc-eurobot-10 (16 Nov 2026): from 03:47 every model call failed with the subscription's 5-hour limit; the agents
// went quiet and the run reported 11 open problems as if the design had ended there. A limit stops the run, named.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { modelLimitOf } from "../src/inference/limit.ts"

test("the subscription's 5-hour limit is recognised from the real failure line", () => {
	const line = readFileSync(new URL("./fixtures/cc-limit-error.txt", import.meta.url), "utf8")
	assert.match(modelLimitOf(line) ?? "", /hit your 5-hour limit/)
})

test("an API's 429 quota is a limit; an ordinary failed call is not", () => {
	assert.ok(modelLimitOf('Error: 429 You exceeded your current quota (insufficient_quota)'))
	assert.equal(modelLimitOf("Error: claude -p gave no structured answer: "), null)
	assert.equal(modelLimitOf("Error: timeout after 240000 ms"), null)
})
