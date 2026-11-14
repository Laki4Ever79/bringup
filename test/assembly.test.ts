// The assembly (src/system/assembly.ts): which boards it places, the plate, the footprint, off-plate and overlap checks.
import { test } from "node:test"
import assert from "node:assert/strict"
import { assemblyErrors, footprint, type AssemblyBoard, type SystemAssembly } from "../src/system/assembly.ts"
import { specErrors, type SystemSpec } from "../src/system/spec.ts"

const placed = (name: string, xMm = 0, yMm = 0, rotDeg: AssemblyBoard["rotDeg"] = 0): AssemblyBoard =>
	({ name, xMm, yMm, rotDeg, outline: { widthMm: 40, heightMm: 30 }, outlineSource: "estimate" })
const spec = (assembly?: SystemAssembly, names = ["main", "front"]): SystemSpec => ({
	name: "two",
	boards: names.map((n) => ({ name: n, brief: `${n}.md` })),
	links: [],
	...(assembly ? { assembly } : {}),
})

test("a board the spec doesn't have is named", () => {
	const s = spec({ body: "separate", boards: [placed("ghost")] }, ["main"])
	assert.deepEqual(assemblyErrors(s), ["assembly: board ghost is not in the system"])
})

test("a spec board missing from a chassis assembly is named", () => {
	const s = spec({ body: "chassis", plate: { lengthMm: 150, widthMm: 110 }, boards: [placed("main")] })
	assert.ok(assemblyErrors(s).includes("assembly: board front has no place on the chassis"))
})

test("a chassis needs a plate; separate devices don't", () => {
	assert.ok(assemblyErrors(spec({ body: "chassis", boards: [placed("main"), placed("front", 50)] })).includes("assembly: a chassis body needs a plate size"))
	assert.deepEqual(assemblyErrors(spec({ body: "separate", boards: [placed("main"), placed("front")] })), [])
})

test("a rotated board's footprint swaps", () => {
	assert.deepEqual(footprint(placed("main", 0, 0, 90)), { xMm: 30, yMm: 40 })
	assert.deepEqual(footprint(placed("main", 0, 0, 180)), { xMm: 40, yMm: 30 })
})

test("a board off the plate is named", () => {
	const plate = { lengthMm: 150, widthMm: 110 }
	// A 90 mm wide board starting at x 70 ends at 160, past the 150 mm plate.
	const wide = { ...placed("main", 70), outline: { widthMm: 90, heightMm: 30 } }
	const off = spec({ body: "chassis", plate, boards: [wide, placed("front", 0, 50)] })
	assert.ok(assemblyErrors(off).includes("assembly: board main sticks out of the 150 × 110 mm plate"))
	// Exactly flush with the plate edge fits.
	const flat = spec({ body: "chassis", plate, boards: [placed("main", 110), placed("front", 0, 50)] })
	assert.deepEqual(assemblyErrors(flat), [])
	// Turned, the 40 x 30 board is 30 wide and 40 tall, which no longer fits a 30 mm deep plate.
	const turned = spec({ body: "chassis", plate: { lengthMm: 150, widthMm: 30 }, boards: [placed("main", 0, 0, 90), placed("front", 40, 0)] })
	assert.ok(assemblyErrors(turned).includes("assembly: board main sticks out of the 150 × 30 mm plate"))
})

test("two boards overlapping are named", () => {
	const plate = { lengthMm: 150, widthMm: 110 }
	const s = spec({ body: "chassis", plate, boards: [placed("main", 0, 0), placed("front", 10, 0)] })
	assert.ok(assemblyErrors(s).includes("assembly: boards main and front overlap"))
	const touching = spec({ body: "chassis", plate, boards: [placed("main", 0, 0), placed("front", 40, 0)] })
	assert.deepEqual(assemblyErrors(touching), [])
})

test("no assembly, no errors", () => {
	assert.deepEqual(assemblyErrors(spec()), [])
	assert.deepEqual(specErrors(spec()), [])
	assert.deepEqual(specErrors(spec({ body: "separate", boards: [placed("ghost")] })), ["assembly: board ghost is not in the system"])
})
