// The 3D view's rover drawn up to an assembly step (src/dashboard/world3d.js roverParts upTo/explode), for the build
// package's step pictures.
import { test } from "node:test"
import assert from "node:assert/strict"
import { roverParts, ASSEMBLY_STEPS } from "../src/dashboard/world3d.js"
import { chassisSpec } from "../src/tools/chassis.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"

const spec = chassisSpec({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) } as never)!

test("each step adds its groups; the plate comes alone first, everything at the last step", () => {
	const groups = (upTo?: number) => [...new Set(roverParts(spec, null, upTo === undefined ? {} : { upTo }).parts.map((p: { group: string }) => p.group))]
	assert.deepEqual(groups(0), ["plate"])
	assert.deepEqual(groups(ASSEMBLY_STEPS.indexOf("motors")).sort(), ["motors", "plate"])
	assert.ok(groups(ASSEMBLY_STEPS.indexOf("wheels")).includes("wheels"))
	assert.deepEqual(groups(ASSEMBLY_STEPS.length - 1).sort(), groups().sort())
})

test("the exploded view lifts each step's parts by its index", () => {
	const flat = roverParts(spec, null, {}).parts.find((p: { group: string }) => p.group === "sensor")!
	const up = roverParts(spec, null, { explode: 40 }).parts.find((p: { group: string }) => p.group === "sensor")!
	const k = ASSEMBLY_STEPS.indexOf("sensor")
	assert.ok(Math.abs(up.tris[2] - flat.tris[2] - k * 40) < 1e-3)
})
