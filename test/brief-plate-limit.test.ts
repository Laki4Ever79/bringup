// A robot's plate keeps within its brief's size from the first layout, before any board has written motion (the forked
// Rover + climate starter, 15 Nov 2026: Build laid it out with no limit, a 156 mm plate on a "15 × 12 cm" brief, and no
// relayout brought it back, so the fork never settled).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { buildSpec, type Plan } from "../src/system/plan.ts"
import { briefPlateLimitMm, neededPlate } from "../src/system/assembly.ts"
import { motionFromBrief } from "../src/mechanics/brief.ts"

const starter = JSON.parse(readFileSync("examples/rover-climate/starter.json", "utf8"))

test("the brief's size is read from the board that states it", () => {
	const max = motionFromBrief(starter.briefs.main).maxSizeMm!
	assert.deepEqual(briefPlateLimitMm([starter.briefs.climate, starter.briefs.main]), max)
	assert.equal(briefPlateLimitMm([starter.briefs.climate]), undefined)
})

test("the forked Rover + climate's Build: the plate and the boards keep within the brief's size", () => {
	const plan = { ...starter, spec: starter.spec, briefs: starter.briefs, robot: true } as unknown as Plan
	const a = buildSpec(plan).assembly!
	const [len, wid] = motionFromBrief(starter.briefs.main).maxSizeMm!
	assert.ok(a.plate!.lengthMm <= len && a.plate!.widthMm <= wid, `plate ${a.plate!.lengthMm} × ${a.plate!.widthMm} over ${len} × ${wid}`)
	const n = neededPlate(a.boards)
	assert.ok(n.lengthMm <= len && n.widthMm <= wid, `boards need ${n.lengthMm} × ${n.widthMm}`)
})
