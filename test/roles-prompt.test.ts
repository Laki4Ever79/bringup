import { test } from "node:test"
import assert from "node:assert/strict"
import { CONTRACT_SHAPES } from "../src/agents/roles.ts"
import { PART_ROLES } from "../src/contract/types.ts"

test("the agents are told to pick a low-Iq regulator for battery targets", () => {
	assert.match(CONTRACT_SHAPES, /low-Iq|quiescent/i)
	assert.match(CONTRACT_SHAPES, /iqUa/)
})

test("the prompt lists every part role the contract accepts", () => {
	for (const role of PART_ROLES) assert.match(CONTRACT_SHAPES, new RegExp(`\\b${role}\\b`), role)
})

test("the agents are told what sleepUa covers and that it can't go below the MCU's floor", () => {
	assert.match(CONTRACT_SHAPES, /sleepUa[^.]*excluding the regulator's quiescent current/)
	assert.match(CONTRACT_SHAPES, /deep-sleep floor/)
})
