// The gap between parts as a build option (PlacementOptions.gapMm, 17 Nov 2026), for the tight-first experiment
// (backlog "Tighter part spacing, proven by the router"): the default 1.5 mm leaves every fixture's layout as it was;
// 1.0 mm places the logger on a smaller board. Whether those boards route is for the routed proof.
import { test } from "node:test"
import assert from "node:assert/strict"
import { boardParts, layoutBoard } from "../src/codegen/circuit.ts"
import { connectorsAt } from "../src/contract/space.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}
const placesAt = (w: number, h: number, gapMm?: number) => {
	const s = logger()
	const t = { ...s, values: { ...s.values, outline: { ...s.values.outline!, widthMm: w, heightMm: h }, connectors: connectorsAt(s, w, h) } }
	return layoutBoard(t, gapMm === undefined ? {} : { gapMm }).parts.length >= boardParts(s).length
}

test("a 1.0 mm gap places the logger on 30×25 mm, where the default 1.5 mm doesn't", () => {
	assert.equal(placesAt(30, 25, 1.0), true)
	assert.equal(placesAt(30, 25), false)
	assert.equal(placesAt(30, 25, 1.5), false)
	assert.equal(placesAt(29, 25, 1.0), false)
})

test("the default gap is the one every layout had: no option, 1.5 mm and none give the same placement", () => {
	const s = logger()
	assert.deepEqual(layoutBoard(s, { gapMm: 1.5 }).parts, layoutBoard(s).parts)
})
