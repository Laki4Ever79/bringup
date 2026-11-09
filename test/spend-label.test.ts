// The spend line in the board and system page headers (src/dashboard/spend.js).
import { test } from "node:test"
import assert from "node:assert/strict"
import { spendLabel } from "../src/dashboard/spend.js"

test("the spend line says what was spent, counts unknown calls, and never shows unknown as $0", () => {
	assert.equal(spendLabel({ usd: 0.25, calls: 3, unknownCalls: 0 }, false), "Spent $0.25 · 3 calls")
	assert.equal(spendLabel({ usd: 0.004, calls: 1, unknownCalls: 0 }, false), "Spent <$0.01 · 1 call")
	assert.equal(spendLabel({ usd: 1.5, calls: 4, unknownCalls: 1 }, false), "Spent $1.50 · 4 calls, 1 of unknown cost")
	assert.equal(spendLabel({ usd: null, calls: 2, unknownCalls: 2 }, false), "Spent: unknown · 2 calls")
	assert.equal(spendLabel({ usd: null, calls: 0, unknownCalls: 0 }, true), "Scripted: free")
	assert.equal(spendLabel({ usd: null, calls: 0, unknownCalls: 0 }, false), "Spent: not recorded")
})
