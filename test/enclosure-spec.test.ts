import { test } from "node:test"
import assert from "node:assert/strict"
import { enclosureSpec } from "../src/tools/enclosure.ts"
import { fixtureContract } from "./fixture.ts"

test("enclosure spec carries the outline, J1 and the shell defaults", () => {
	const spec = enclosureSpec(fixtureContract()) as Record<string, any>
	assert.equal(spec.wallMm, 2)
	assert.equal(spec.clearanceMm, 2)
	assert.equal(spec.heightMm, 14, "board on 3 mm standoffs, room for the tallest part under the lid")
	assert.deepEqual(spec.outline, { widthMm: 50, heightMm: 30, thicknessMm: 1.6 })
	assert.deepEqual(spec.connectors.map((c: { ref: string }) => c.ref), ["J1"])
})

test("enclosure spec refuses a contract without an outline", () => {
	const c = fixtureContract()
	delete c.values.outline
	assert.throws(() => enclosureSpec(c), /outline/)
})

test("enclosure spec puts an M2 standoff under each board hole, in the contract frame", () => {
	const spec = enclosureSpec(fixtureContract()) as Record<string, any>
	assert.deepEqual(spec.holes, [{ ref: "H1", xMm: 3, yMm: 3 }, { ref: "H2", xMm: 47, yMm: 3 }, { ref: "H3", xMm: 3, yMm: 27 }, { ref: "H4", xMm: 47, yMm: 27 }])
	assert.deepEqual(spec.standoff, { heightMm: 3, outerMm: 5, pilotMm: 1.6 })
	assert.deepEqual(spec.lid, { plateMm: 2, lipMm: 3, lipWallMm: 1.6, clearanceMm: 0.2 })
})
