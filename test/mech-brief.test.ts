import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { motionBriefChecks, motionFromBrief } from "../src/mechanics/brief.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const rover = readFileSync(resolve(import.meta.dirname, "../briefs/rover.md"), "utf8")
const right = { speedMps: 0.3, runtimeMin: 30, edgeMm: 3, maxSlopeDeg: 10, stopBeforeWallMm: 150, payloadG: 20, maxSizeMm: [150, 120] as [number, number], maxMassG: 500 }
const snap = (motion: unknown) => ({ revision: 1, values: { motion } }) as unknown as ContractSnapshot

test("the rover brief's targets are read from its own words", () => {
	assert.deepEqual(motionFromBrief(rover), { speedMps: 0.3, runtimeMin: 30, edgeMm: 3, stopBeforeWallMm: 150, payloadG: 20, maxMassG: 500, maxSizeMm: [150, 120] })
})

test("motion that copies the brief raises nothing", () => {
	assert.deepEqual(motionBriefChecks(snap(right), rover), [])
	// rounding inside the 10 % tolerance is not a mistake
	assert.deepEqual(motionBriefChecks(snap({ ...right, speedMps: 0.31 }), rover), [])
})

test("real rover run 9's motion (edge 10, stop 50, runtime 60, payload 100) goes back to the architect, naming each", () => {
	const v = motionBriefChecks(snap({ ...right, runtimeMin: 60, edgeMm: 10, stopBeforeWallMm: 50, payloadG: 100 }), rover)
	assert.equal(v.length, 1)
	assert.deepEqual(v[0].affects, ["architect"])
	assert.deepEqual(v[0].fields, ["motion"])
	for (const s of ["edgeMm 10 where the brief says 3 mm", "stopBeforeWallMm 50 where the brief says 150 mm", "runtimeMin 60 where the brief says 30 min", "payloadG 100 where the brief says 20 g"]) assert.match(v[0].message, new RegExp(s))
})

test("no motion or no brief: nothing to compare (a board without motion, such as the climate board on a rover, is never checked)", () => {
	assert.deepEqual(motionBriefChecks(snap(undefined), rover), [])
	assert.deepEqual(motionBriefChecks(snap(undefined), readFileSync(resolve(import.meta.dirname, "../briefs/logger.md"), "utf8")), [])
	assert.deepEqual(motionBriefChecks(snap(right), ""), [])
})

test("real rover run 8's motion (strong models) missed the brief too: a 10 cm stop where it asks 15 cm, no payload", () => {
	const v = motionBriefChecks(snap({ ...right, runtimeMin: 60, edgeMm: 5, maxSlopeDeg: 8, stopBeforeWallMm: 100, payloadG: 0 }), rover)
	assert.match(v[0].message, /stopBeforeWallMm 100 where the brief says 150 mm/)
	assert.match(v[0].message, /payloadG 0 where the brief says 20 g/)
})

test("a system's shared plate leaves room for the wheels: the brief's 150 × 120 mm with 10 mm wheels allows a 150 × 96 mm plate", async () => {
	const { plateLimitMm } = await import("../src/mechanics/checks.ts")
	const { ROVER_MECHANICS, ROVER_MOTION } = await import("../src/inference/scripts.ts")
	assert.deepEqual(plateLimitMm({ revision: 1, values: { motion: ROVER_MOTION, mechanics: ROVER_MECHANICS } } as unknown as ContractSnapshot), [150, 96])
	// before the mechanics names a wheel: the brief's own size
	assert.deepEqual(plateLimitMm({ revision: 1, values: { motion: ROVER_MOTION } } as unknown as ContractSnapshot), [150, 120])
	// the scripted rover copies the brief, so the new check passes on it
	assert.deepEqual(motionBriefChecks(snap(ROVER_MOTION), rover), [])
})
