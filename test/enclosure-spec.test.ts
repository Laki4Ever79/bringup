import { test } from "node:test"
import assert from "node:assert/strict"
import { enclosureSpec } from "../src/tools/enclosure.ts"
import { MIC_PORT, placeParts } from "../src/codegen/circuit.ts"
import { MIC_PART } from "../src/inference/scripts.ts"
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

test("enclosure spec carries each sensor's position from the board generator's placement, for the vent", () => {
	const c = fixtureContract()
	const u2 = placeParts(c).find((p) => p.ref === "U2")!
	const spec = enclosureSpec(c) as Record<string, any>
	assert.deepEqual(spec.sensors, [{ ref: "U2", xMm: u2.x + 25, yMm: u2.y + 15 }])
	c.values.parts = c.values.parts!.filter((p) => p.role !== "sensor")
	assert.deepEqual((enclosureSpec(c) as Record<string, any>).sensors, [])
})

test("enclosure spec carries each microphone's sound hole (the part's placement plus MIC_PORT), for the floor opening", () => {
	const c = fixtureContract()
	assert.deepEqual((enclosureSpec(c) as Record<string, any>).ports, [], "no microphone, no opening")
	c.values.parts = [...c.values.parts!, MIC_PART]
	const u5 = placeParts(c).find((p) => p.ref === "U5")!
	assert.equal(u5.rotation, 0)
	const spec = enclosureSpec(c) as Record<string, any>
	assert.deepEqual(spec.ports, [{ ref: "U5", xMm: +(u5.x + MIC_PORT.x + 25).toFixed(3), yMm: +(u5.y + MIC_PORT.y + 15).toFixed(3) }])
})
