// The pours' outline with the module antenna's keep-out band cut out beside the module (antennaNotch): the band at
// the module's edge, its width the module's plus the clearance either side, less the module's own column.
import { test } from "node:test"
import assert from "node:assert/strict"
import { antennaNotch } from "../src/codegen/circuit.ts"

// The polygon's area (shoelace) and whether a point is inside it (ray casting).
const area = (p: { x: number; y: number }[]) => Math.abs(p.reduce((a, q, i) => a + q.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * q.y, 0)) / 2
const inside = (p: { x: number; y: number }[], x: number, y: number) => {
	let c = false
	for (let i = 0, j = p.length - 1; i < p.length; j = i++) if (p[i].y > y !== p[j].y > y && x < ((p[j].x - p[i].x) * (y - p[i].y)) / (p[j].y - p[i].y) + p[i].x) c = !c
	return c
}

test("the band beside the module is cut from the pour on every edge; the module's column and the rest keep it", () => {
	// A 40×30 board, the module 10 wide and 8 deep at the middle of each edge in turn, a 5 mm band.
	const cases = [
		{ edge: "top", z: { x: 0, y: 12.5, w: 20, h: 5, module: { x: 0, y: 11, w: 10, h: 8 } }, beside: [7.5, 13], module: [0, 13], free: [0, 0] },
		{ edge: "bottom", z: { x: 0, y: -12.5, w: 20, h: 5, module: { x: 0, y: -11, w: 10, h: 8 } }, beside: [-7.5, -13], module: [0, -13], free: [0, 0] },
		{ edge: "right", z: { x: 17.5, y: 0, w: 5, h: 20, module: { x: 16, y: 0, w: 8, h: 10 } }, beside: [18, 7.5], module: [18, 0], free: [0, 0] },
		{ edge: "left", z: { x: -17.5, y: 0, w: 5, h: 20, module: { x: -16, y: 0, w: 8, h: 10 } }, beside: [-18, -7.5], module: [-18, 0], free: [0, 0] },
	]
	for (const c of cases) {
		const p = antennaNotch(40, 30, c.z)
		assert.ok(p, c.edge)
		assert.equal(inside(p, c.beside[0], c.beside[1]), false, `${c.edge}: beside the module is cut`)
		assert.equal(inside(p, c.module[0], c.module[1]), true, `${c.edge}: the module's column keeps its pour`)
		assert.equal(inside(p, c.free[0], c.free[1]), true, `${c.edge}: the rest of the board keeps it`)
		// Two 5×5 notches out of 40×30.
		assert.equal(+area(p).toFixed(3), 1200 - 2 * 25, c.edge)
	}
})

test("a band reaching a corner leaves a clean polygon: no point in line with its neighbours", () => {
	// The 60×21 rover: the band runs past the left corner (cc-rover-60x21-rev17 at 12 mm).
	const p = antennaNotch(60, 21, { x: -13.5, y: 4.5, w: 37.2, h: 12, module: { x: -13.5, y: 4.65, w: 13.2, h: 11.7 } })!
	for (let i = 0; i < p.length; i++) {
		const [a, b, c] = [p[(i + p.length - 1) % p.length], p[i], p[(i + 1) % p.length]]
		assert.notEqual(Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 1e-9, true, `point ${i} in line`)
	}
	assert.equal(inside(p, -25, 5), false, "the corner piece is cut")
	assert.equal(inside(p, -13.5, 8), true, "the module keeps its pour")
	// 60×21 less 9.9×12 at the corner and 12×12 on the other side.
	assert.equal(+area(p).toFixed(2), +(60 * 21 - 9.9 * 12 - 12 * 12).toFixed(2))
})

test("a band that doesn't reach an edge cuts nothing", () => {
	assert.equal(antennaNotch(40, 30, { x: 0, y: 0, w: 10, h: 5, module: { x: 0, y: 0, w: 4, h: 4 } }), null)
})
