// The 3D view's rover drawn up to an assembly step (src/dashboard/world3d.js roverParts upTo/explode), for the build
// package's step pictures.
import { test } from "node:test"
import assert from "node:assert/strict"
import { assemblyView, roverParts, ASSEMBLY_STEPS } from "../src/dashboard/world3d.js"
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

test("the page URL picks the step and the explode: ?step=N or a step's name, ?explode[=mm]", () => {
	assert.deepEqual(assemblyView(""), {})
	assert.deepEqual(assemblyView(undefined), {})
	assert.deepEqual(assemblyView("?step=2"), { upTo: 2 })
	assert.deepEqual(assemblyView("?step=board"), { upTo: ASSEMBLY_STEPS.indexOf("board") })
	assert.deepEqual(assemblyView("?explode"), { explode: 40 })
	assert.deepEqual(assemblyView("?step=6&explode=25"), { upTo: 6, explode: 25 })
	// A step past the last, or one that isn't a step, draws everything.
	assert.deepEqual(assemblyView("?step=99"), {})
	assert.deepEqual(assemblyView("?step=wings"), {})
})

test("the build package takes no pictures of a directory that isn't a run with a chassis, and says so", async () => {
	const { assemblyPictures } = await import("../src/package/assembly-pictures.ts")
	const { tempDir } = await import("./helpers.ts")
	const r = await assemblyPictures(tempDir(), tempDir())
	assert.deepEqual(r.files, [])
	assert.match(r.note!, /not a run with a built chassis/)
})
