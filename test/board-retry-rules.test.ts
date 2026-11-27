// The free tier's board time (lead-2, 27 Nov 2026): a mock rover without Freerouting spent 380 of its 437 s board time
// on two sizes that couldn't route, 85 s of each on a 4-layer retry that could not help and ~12 s per build on a
// "Freerouting layout" with no Freerouting. And the widening it led to said "tscircuit left pins without a trace".
import { test } from "node:test"
import assert from "node:assert/strict"
import { retryOnFour, sizeFailure } from "../src/tools/board.ts"
import { freeroutingAvailable, FREEROUTING_MISSING } from "../src/tools/freerouting.ts"
import { routingFailureReason } from "../src/contract/space.ts"

// The free-tier rover's rev 11 (scratchpad rover-gndend-nofr), as the build reported it.
const ROUTED_TOO_LONG = ["tscircuit build failed (exit 1):", "PCB trace is 10.51mm long, exceeding the 5mm maximum (.U6 > .VDDIO to .C9 > .pin1)", "Via unnamed via and trace .U6 > .VDD to .C8 > .pin1 are too close (clearance: 0.085mm, minimum: 0.1mm)", "Circuits  0 passed 1 failed", `Freerouting's layout: Freerouting: ${FREEROUTING_MISSING}`].join("\n")
// The CNC's 2-layer refusal before routing (scratchpad cnc81-gnd2).
const BEFORE_ROUTING = "tscircuit build failed (placement check, no layout built):\nAutorouting was skipped because the 5mm maximum length for .C29 > .pin2 to net.GND cannot be satisfied: its endpoints are 13.07mm apart (8 additional violations). Every one of 20 layouts leaves a pin capacitor out of reach."
const UNROUTED = "tscircuit build failed (exit 1):\nPort [U5.GND] is missing a trace\nCircuits  0 passed 1 failed"

test("a trace past its bound goes to 4 layers only where Freerouting can route it", () => {
	assert.ok(sizeFailure(ROUTED_TOO_LONG) && sizeFailure(BEFORE_ROUTING), "both are size failures: the size is recorded either way")
	assert.equal(retryOnFour(ROUTED_TOO_LONG, false), false, "free tier: the 4-layer retry has the same bound and placement")
	assert.equal(retryOnFour(BEFORE_ROUTING, false), false)
	assert.equal(retryOnFour(ROUTED_TOO_LONG, true), true, "with Freerouting, as the CNC routes on 4 layers")
	assert.equal(retryOnFour(BEFORE_ROUTING, true), true)
	assert.equal(retryOnFour(UNROUTED, false), true, "a crowded board still gets its planes")
	assert.equal(retryOnFour("Unknown footprint 'sot99' for U3", false), false)
})

test("BRINGUP_FREEROUTING=off is a machine without the jar", () => {
	const was = process.env.BRINGUP_FREEROUTING
	try {
		process.env.BRINGUP_FREEROUTING = "off"
		assert.equal(freeroutingAvailable(process.cwd()), false)
		delete process.env.BRINGUP_FREEROUTING
		assert.equal(freeroutingAvailable("/nonexistent"), false)
	} finally {
		if (was === undefined) delete process.env.BRINGUP_FREEROUTING
		else process.env.BRINGUP_FREEROUTING = was
	}
})

test("the widening's reason names the bounded trace, or stays general", () => {
	assert.equal(routingFailureReason(ROUTED_TOO_LONG), "a decoupling trace exceeded its 5 mm bound (.U6 > .VDDIO to .C9 > .pin1: 10.51 mm)")
	assert.equal(routingFailureReason(BEFORE_ROUTING), "a decoupling trace exceeded its 5 mm bound (.C29 > .pin2 to net.GND: 13.07 mm apart)")
	assert.equal(routingFailureReason(UNROUTED), "tscircuit left pins without a trace")
})
