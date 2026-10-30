import { test } from "node:test"
import assert from "node:assert/strict"
import { enclosureSpec } from "../src/tools/enclosure.ts"
import { fixtureContract } from "./fixture.ts"

test("enclosure spec carries the outline, J1 and the shell defaults", () => {
	const spec = enclosureSpec(fixtureContract()) as Record<string, any>
	assert.equal(spec.wallMm, 2)
	assert.equal(spec.clearanceMm, 2)
	assert.equal(spec.heightMm, 12)
	assert.deepEqual(spec.outline, { widthMm: 50, heightMm: 30, thicknessMm: 1.6 })
	assert.deepEqual(spec.connectors.map((c: { ref: string }) => c.ref), ["J1"])
})

test("enclosure spec refuses a contract without an outline", () => {
	const c = fixtureContract()
	delete c.values.outline
	assert.throws(() => enclosureSpec(c), /outline/)
})
