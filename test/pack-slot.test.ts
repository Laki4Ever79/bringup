// The system keeps main's pack slot free (bringup-cad, 19 Nov 2026: the Rover + climate system put main at x 24 and
// climate at -24 on its 150 mm plate; the pack, 60 mm long behind a bracket at x 70.2, landed on main's standoffs).
import { test } from "node:test"
import assert from "node:assert/strict"
import { clearPackSlot, packSlotOf, type SystemAssembly } from "../src/system/assembly.ts"
import { boardsOverlap, footprint } from "../src/dashboard/assembly-geom.js"

const spec = { battery: { sizeMm: [60, 36, 8] as [number, number, number] }, sensor: { xMm: 74.2, sizeMm: [4, 20, 10] as [number, number, number] }, plate: { lengthMm: 150 } }
const est = (w: number, h: number) => ({ widthMm: w, heightMm: h })
const body = (main: number, climate: number): SystemAssembly => ({ body: "chassis", plate: { lengthMm: 150, widthMm: 96 }, boards: [
	{ name: "main", xMm: main, yMm: 0, rotDeg: 0, outline: est(40, 30), outlineSource: "estimate" },
	{ name: "climate", xMm: climate, yMm: 0, rotDeg: 0, outline: est(40, 30), outlineSource: "estimate" },
] })

test("the pack's slot ends behind the bracket and is as long as the pack plus a standoff", () => {
	const s = packSlotOf(spec)
	assert.equal(s.xHi, 74.2 - 2 - 2 - 1)
	assert.equal(+(s.xHi - s.xLo).toFixed(1), 65)
	assert.equal(s.yHalf, 18 + 2 + 2.5)
})

test("boards over the slot move behind it (rows across the plate when one row is too long), clear of it, of each other and on the plate", () => {
	const s = packSlotOf(spec)
	const a = clearPackSlot(body(24, -24), s, [150, 96])
	const [m, c] = a.boards
	assert.ok(!boardsOverlap(m, c), "boards clear of each other")
	for (const b of a.boards) {
		assert.ok(Math.abs(b.yMm) + footprint(b).yMm / 2 <= 48 + 1e-9, `${b.name} within the plate's width`)
		assert.ok(b.xMm + footprint(b).xMm / 2 <= s.xLo - 8 + 1e-9, `${b.name} behind the slot`)
		assert.ok(b.xMm - footprint(b).xMm / 2 >= -75, `${b.name} on the plate`)
	}
	assert.equal(clearPackSlot(a, s, [150, 96]), a, "already clear: unchanged")
})

test("a row that can't fit behind the slot is left as it was (the checks say so)", () => {
	const s = packSlotOf(spec)
	// 80 mm boards: longer than the 71 mm behind the slot.
	const big: SystemAssembly = { ...body(24, -24), boards: body(24, -24).boards.map((b) => ({ ...b, outline: est(80, 30) })) }
	assert.deepEqual(clearPackSlot(big, s, [150, 96]).boards.map((b) => b.xMm), [24, -24])
})
