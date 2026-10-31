import { test } from "node:test"
import assert from "node:assert/strict"
import { CONTRACT_SHAPES } from "../src/agents/roles.ts"

// Real beacon runs: "U2 = sensor" read as a mandated part, so the parts agent kept adding a sensor the brief ruled out.
test("the reference designators don't mandate a sensor", () => {
	assert.match(CONTRACT_SHAPES, /U2 = sensor \(only when the requirements call for one\)/)
})
