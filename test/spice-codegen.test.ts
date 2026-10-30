import { test } from "node:test"
import assert from "node:assert/strict"
import { powerDeck } from "../src/codegen/spice.ts"
import { fixtureContract } from "./fixture.ts"

test("power deck carries the input voltage and the fixture rail's load current", () => {
	const deck = powerDeck(fixtureContract(), { name: "vbus", vinV: 5 })
	assert.match(deck, /^\.param vin=5$/m)
	assert.match(deck, /^\.param iload_3v3=0\.12$/m)
	assert.match(deck, /^\.param vset_3v3=3\.3$/m)
	assert.match(deck, /^\.meas dc vout_3v3 /m)
	assert.match(deck, /^\.end$/m)
})

test("power deck has one regulator per rail", () => {
	const c = fixtureContract()
	c.values.rails!.push({ name: "1V8", voltageV: 1.8, regulatorMaxMa: 300, loadMa: 40 })
	const deck = powerDeck(c, { name: "vbus", vinV: 5 })
	assert.match(deck, /^\.param iload_1v8=0\.04$/m)
	assert.match(deck, /^\.meas dc iout_1v8 /m)
})

test("power deck refuses a contract without rails", () => {
	const c = fixtureContract()
	delete c.values.rails
	assert.throws(() => powerDeck(c, { name: "vbus", vinV: 5 }), /rails/)
})

// Real run 9's rails: an input rail with no load, the battery rail, and the regulated 3.3 V rail.
const RUN9_RAILS = [
	{ name: "VBUS", voltageV: 5, regulatorMaxMa: 500, loadMa: 0 },
	{ name: "VBAT", voltageV: 3.7, regulatorMaxMa: 1000, loadMa: 500, averageMa: 0 },
	{ name: "VDD_3V3", voltageV: 3.3, regulatorMaxMa: 300, loadMa: 180, averageMa: 0.097 },
]

test("input and battery rails are not modelled as regulators fed from the cell", () => {
	const c = fixtureContract()
	c.values.rails = structuredClone(RUN9_RAILS)
	const deck = powerDeck(c, { name: "liion-3v5", vinV: 3.5 })
	assert.match(deck, /^Bpass_vdd_3v3 /m)
	assert.doesNotMatch(deck, /_vbus|_vbat/, "VBUS is the input and VBAT is the cell, not LDO outputs")
})

test("a regulated rail with no load gets an open load, not a division by zero (real run 9)", () => {
	const c = fixtureContract()
	c.values.rails = [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 0 }]
	const deck = powerDeck(c, { name: "liion-3v7", vinV: 3.7 })
	assert.match(deck, /^Rload_3v3 load_3v3 0 1e9$/m)
	assert.doesNotMatch(deck, /iload_3v3=0\n[\s\S]*\{vset_3v3\/iload_3v3\}/)
})

test("power deck refuses a contract with no regulated rail", () => {
	const c = fixtureContract()
	c.values.rails = [RUN9_RAILS[0], RUN9_RAILS[1]]
	assert.throws(() => powerDeck(c, { name: "vbus", vinV: 5 }), /no regulated rail/)
})
