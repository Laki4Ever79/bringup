// Click-to-reference editing (19 Nov 2026, text-to-cad's prompt references): a click on the case names the feature
// nearest the picked point (the case build's refs.json), or the surface, and the composer puts that reference before
// the change request for the case designer (src/dashboard/scene3d.js nearestCaseRef, refPrefix).
import { test } from "node:test"
import assert from "node:assert/strict"
import { nearestCaseRef, refPrefix } from "../src/dashboard/scene3d.js"
import { CASE_DESIGN } from "../src/agents/roles.ts"

const refs = [
	{ ref: "case#cutout:J1", kind: "cutout", label: "J1's opening in the bottom wall", atMm: [25, -4, 8.2] as [number, number, number], madeBy: "py/enclosure.py:108 slot" },
	{ ref: "case#feature:gland", kind: "hole", label: "6 mm hole in the left wall", atMm: [-5, 15, 7] as [number, number, number], madeBy: "py/enclosure.py:247 teardrop" },
]
const bounds = { min: [-6, -6, 0], max: [56, 36, 16] }

test("a click near a feature names it; elsewhere it names the wall, the floor or the lid", () => {
	assert.equal(nearestCaseRef([-5.5, 16, 8], "case", refs, bounds).ref, "case#feature:gland")
	assert.equal(nearestCaseRef([24, -5, 9], "case", refs, bounds).ref, "case#cutout:J1")
	assert.equal(nearestCaseRef([55, 20, 8], "case", refs, bounds).ref, "case#wall:right")
	assert.equal(nearestCaseRef([20, 35.5, 8], "case", refs, bounds).ref, "case#wall:top")
	assert.equal(nearestCaseRef([20, 15, 0.5], "case", refs, bounds).ref, "case#floor")
	assert.equal(nearestCaseRef([20, 15, 18], "lid", refs, bounds).ref, "case#lid")
	// No refs.json (an older run): still a surface.
	assert.equal(nearestCaseRef([-5.5, 16, 8], "case", null, bounds).ref, "case#wall:left")
})

test("the reference goes before the request, in the form the case designer is told to read", () => {
	const r = nearestCaseRef([-5.5, 16, 8], "case", refs, bounds)
	assert.equal(refPrefix(r), "[case#feature:gland: 6 mm hole in the left wall; made by py/enclosure.py:247 teardrop] ")
	assert.equal(refPrefix(null), "")
	assert.match(CASE_DESIGN, /\[case#feature:<id>: …\]/)
})

test("on a robot a click names the printed part nearby, else the chassis plate; the mechanics engineer reads the prefix", async () => {
	const chassisRefs = [{ ref: "chassis#sensor-bracket", kind: "sensor-bracket", label: "the distance sensor's bracket", atMm: [70.2, 0, 15] as [number, number, number], madeBy: "py/chassis.py:220 build" }]
	const b = { min: [-75, -48, -20], max: [75, 48, 30] }
	assert.equal(nearestCaseRef([72, 5, 20], "case", chassisRefs, b, undefined, "chassis").ref, "chassis#sensor-bracket", "within the robot's 20 mm radius")
	assert.equal(nearestCaseRef([-40, 10, 1], "case", chassisRefs, b, undefined, "chassis").ref, "chassis#plate")
	const { MECHANICS_RULES } = await import("../src/agents/roles.ts")
	assert.match(MECHANICS_RULES, /\[chassis#sensor-bracket: …\]/)
})
