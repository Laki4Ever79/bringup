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
