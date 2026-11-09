// The shared 3D scene's pure helpers (src/dashboard/world3d.js): where boards sit, how the camera flies, how much
// detail each board gets.
import { test } from "node:test"
import assert from "node:assert/strict"
import { autoLayout, detailFor, flyCamera, pickBoard } from "../src/dashboard/world3d.js"

const board = (name: string, w = 50, h = 30) => ({ name, outline: { widthMm: w, heightMm: h } })
const link = (a: string, b: string) => ({ id: `${a}${b}`, a: { board: a }, b: { board: b } })

function overlaps(pos: Record<string, { x: number; y: number }>, boards: ReturnType<typeof board>[], gap: number) {
	for (const a of boards)
		for (const b of boards) {
			if (a === b) continue
			const pa = pos[a.name], pb = pos[b.name]
			const dx = Math.abs(pa.x - pb.x) - (a.outline.widthMm + b.outline.widthMm) / 2
			const dy = Math.abs(pa.y - pb.y) - (a.outline.heightMm + b.outline.heightMm) / 2
			if (dx < gap - 1e-9 && dy < gap - 1e-9) return `${a.name} and ${b.name}`
		}
	return null
}

test("boards never overlap, with the gap kept, for 2, 3 and 6 boards", () => {
	for (const n of [2, 3, 6]) {
		const boards = Array.from({ length: n }, (_, i) => board(`b${i}`, 30 + i * 7, 20 + i * 3))
		const pos = autoLayout(boards, [], 20)
		assert.deepEqual(Object.keys(pos).sort(), boards.map((b) => b.name).sort())
		assert.equal(overlaps(pos, boards, 20), null, `${n} boards`)
	}
})

test("linked boards sit closer than unlinked ones", () => {
	const boards = [board("a"), board("d"), board("b"), board("c")]
	const pos = autoLayout(boards, [link("a", "b"), link("b", "c")], 20)
	const dist = (p: string, q: string) => Math.hypot(pos[p].x - pos[q].x, pos[p].y - pos[q].y)
	assert.ok(dist("a", "b") < dist("a", "d"))
})

test("the camera fly starts at the first view, ends at the second and passes between, easing in and out", () => {
	const a = { yaw: 0, pitch: 0.5, distance: 200, target: [0, 0, 0] }
	const b = { yaw: 1, pitch: 0.9, distance: 80, target: [40, 10, 0] }
	assert.deepEqual(flyCamera(a, b, 0), a)
	assert.deepEqual(flyCamera(a, b, 1), b)
	const mid = flyCamera(a, b, 0.5)
	assert.ok(mid.distance < 200 && mid.distance > 80)
	assert.ok(Math.abs(mid.target[0] - 20) < 1e-9, "symmetric easing is halfway at t = 0.5")
	assert.ok(flyCamera(a, b, 0.1).distance > 200 - 0.1 * 120, "eases in: slower than linear at the start")
})

test("the yaw takes the short way round", () => {
	const mid = flyCamera({ yaw: 3.0, pitch: 0, distance: 1, target: [0, 0, 0] }, { yaw: -3.0, pitch: 0, distance: 1, target: [0, 0, 0] }, 0.5)
	assert.ok(Math.abs(Math.abs(mid.yaw) - Math.PI) < 0.01)
})

test("small systems show every board in full; large ones only the focused board", () => {
	assert.equal(detailFor("a", null, 2), "full")
	assert.equal(detailFor("a", "b", 4), "full")
	assert.equal(detailFor("a", null, 6), "box")
	assert.equal(detailFor("a", "a", 6), "full")
})

test("a ray picks the nearest board it passes through", () => {
	const boxes = [
		{ name: "far", min: [-10, -10, 0], max: [10, 10, 2] },
		{ name: "near", min: [-10, -10, 20], max: [10, 10, 22] },
	]
	assert.equal(pickBoard([0, 0, 100], [0, 0, -1], boxes), "near")
	assert.equal(pickBoard([50, 50, 100], [0, 0, -1], boxes), null)
})
