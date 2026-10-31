import { test } from "node:test"
import assert from "node:assert/strict"
import { CONTRACT_SHAPES } from "../src/agents/roles.ts"

// Real beacon runs: "U2 = sensor" read as a mandated part, so the parts agent kept adding a sensor the brief ruled out.
test("the reference designators don't mandate a sensor", () => {
	assert.match(CONTRACT_SHAPES, /U2 = sensor \(only when the requirements call for one\)/)
	assert.match(CONTRACT_SHAPES, /a naming convention, not a parts list/)
})

// Real beacon runs: 0.6–3 s wakes with stated averages the duty cycle couldn't support; the designers now see the check.
test("the contract shapes tell the designers how the duty-cycle battery check is computed", () => {
	assert.match(CONTRACT_SHAPES, /each wake lasts activeMs \(at least the firmware's 30 ms reading plus 50 ms of BLE advertising/)
})
