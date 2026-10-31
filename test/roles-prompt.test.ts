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

test("the agents are told how to show charging state in hardware", () => {
	assert.match(CONTRACT_SHAPES, /charge-led/)
	assert.match(CONTRACT_SHAPES, /CHRG/)
})

// Real run 14: the architect gave the USB-C connector heightMm 7.5, its cutout ran into the lid, and the case failed.
test("the agents are told connector width and height are the opening a part needs, with the USB-C size", () => {
	assert.match(CONTRACT_SHAPES, /USB-C .*9 × 3\.2 mm/)
})

test("the agents are told behavior is exactly three numbers and what it cannot express", () => {
	assert.match(CONTRACT_SHAPES, /behavior .*exactly these three numbers/)
	assert.match(CONTRACT_SHAPES, /charging state/)
})

test("the agents are told unknown stock is not out of stock, and the architect leaves parts-only requests to the parts agent", async () => {
	assert.match(CONTRACT_SHAPES, /stock null means unknown, not out of stock/)
})
