// A pin assignment joins an MCU pin to the part pin it drives. The real architect of rover run 1 (15 Nov 2026) put
// DIST_TRIG, DIST_ECHO and the motor PWM signals on the MCU's own pins (partRef U1): each net had one end, tscircuit
// failed every board build on it ("Port [U1.GPIO2] is not connected to net [DIST_TRIG]"), and the architect, told to
// give the board room, widened it. Caught on the contract now, in milliseconds, to the pins' owner.
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkConsistency } from "../src/contract/consistency.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

test("a pin on the MCU's own pin goes nowhere: a violation for the architect, naming the signal", () => {
	assert.deepEqual(checkConsistency(logger(), {}).filter((v) => v.kind === "pin-unwired"), [])
	const s = logger()
	s.values.pins = [...s.values.pins!, { signal: "DIST_TRIG", gpio: 2, partRef: "U1", partPin: "GPIO2" }]
	const v = checkConsistency(s, {}).filter((x) => x.kind === "pin-unwired")
	assert.equal(v.length, 1, JSON.stringify(checkConsistency(s, {}).map((x) => x.kind)))
	assert.match(v[0].message, /DIST_TRIG/)
	assert.match(v[0].message, /U1\.GPIO2/)
	assert.deepEqual(v[0].fields, ["pins"])
	assert.deepEqual(v[0].affects, ["architect"])
})
