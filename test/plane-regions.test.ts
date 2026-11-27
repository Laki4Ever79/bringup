import { test } from "node:test"
import assert from "node:assert/strict"
import { planeRegions } from "../src/codegen/plane-regions.ts"

const inside = (o: { x: number; y: number }[], p: { x: number; y: number }) => {
	let c = false
	for (let i = 0, j = o.length - 1; i < o.length; j = i++) if (o[i].y > p.y !== o[j].y > p.y && p.x < ((o[j].x - o[i].x) * (p.y - o[i].y)) / (o[j].y - o[i].y) + o[i].x) c = !c
	return c
}

test("two rails split the layer: each region holds its own pads, none of the other's, and a gap keeps them apart", () => {
	const rails = [{ net: "A", points: [{ x: -15, y: -5 }, { x: -15, y: 5 }] }, { net: "B", points: [{ x: 15, y: 0 }] }]
	const r = planeRegions(40, 30, rails)
	assert.deepEqual(r.map((x) => x.net).sort(), ["A", "B"])
	const a = r.find((x) => x.net === "A")!, b = r.find((x) => x.net === "B")!
	for (const p of rails[0].points) assert.ok(inside(a.outline, p) && !inside(b.outline, p))
	assert.ok(inside(b.outline, rails[1].points[0]) && !inside(a.outline, rails[1].points[0]))
	// The gap: every vertex of each outline is at least 0.5 mm from the other's edges, and the two never overlap.
	const segDist = (p: { x: number; y: number }, a1: { x: number; y: number }, a2: { x: number; y: number }) => {
		const dx = a2.x - a1.x, dy = a2.y - a1.y
		const t = Math.max(0, Math.min(1, ((p.x - a1.x) * dx + (p.y - a1.y) * dy) / (dx * dx + dy * dy || 1)))
		return Math.hypot(p.x - a1.x - t * dx, p.y - a1.y - t * dy)
	}
	const minGap = (u: typeof a.outline, v: typeof a.outline) => Math.min(...u.map((p) => Math.min(...v.map((q, k) => segDist(p, q, v[(k + 1) % v.length])))))
	assert.ok(Math.min(minGap(a.outline, b.outline), minGap(b.outline, a.outline)) >= 0.5 - 1e-9)
	for (const p of a.outline) assert.ok(!inside(b.outline, p))
	// A wide region: its neck between its two pads is wide (most of the left half).
	assert.ok(a.neckMm >= 8, String(a.neckMm))
})

test("a rail whose pads sit far apart past another rail's gets a thin neck, which the width check can hold against its need", () => {
	// A's pads at the two ends of a strip; B's pads crowd the middle, leaving A only a narrow passage along the edges.
	const rails = [
		{ net: "A", points: [{ x: -18, y: 0 }, { x: 18, y: 0 }] },
		{ net: "B", points: [{ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: -2 }, { x: 0, y: 2 }] },
	]
	const r = planeRegions(40, 8, rails)
	const a = r.filter((x) => x.net === "A")
	// A is cut in two by B (no passage) or joined by a thin one: either way no wide neck joins its pads.
	assert.ok(a.length === 2 || a[0].neckMm < 2, JSON.stringify(a.map((x) => x.neckMm)))
})

test("the power layer's split is weighted by need: the arm mock's VSERVO1 got 1 mm against 1.5 mm; every region now takes its rail", async () => {
	const { readFileSync } = await import("node:fs")
	const { powerPlaneRegions, supplyWidths } = await import("../src/codegen/circuit.ts")
	const c = JSON.parse(readFileSync(new URL("./fixtures/arm-mock-rev14.json", import.meta.url), "utf8"))
	const s = c.values ? c : { values: c }
	const need = supplyWidths(s)
	const regions = powerPlaneRegions(s).filter((r) => Number.isFinite(r.neckMm))
	assert.ok(regions.some((r) => r.net === "VSERVO1"))
	for (const r of regions) assert.ok(r.neckMm >= need.get(r.net)!, `${r.net} ${r.neckMm} < ${need.get(r.net)}`)
})

// A rail whose region surrounds another's keeps it, the hole cut in by a keyhole: dropped before, the rail had no plane
// (the arm fixture's VSERVO3, 27 Nov 2026).
test("a region with another rail's inside it is kept, as one outline round both loops", async () => {
	const { planeRegions } = await import("../src/codegen/plane-regions.ts")
	// A at the four corners of a 40×40 board, B alone in the middle: B's region is an island in A's.
	const rs = planeRegions(40, 40, [
		{ net: "A", points: [{ x: -15, y: -15 }, { x: 15, y: -15 }, { x: 15, y: 15 }, { x: -15, y: 15 }] },
		{ net: "B", points: [{ x: 0, y: 0 }] },
	])
	const a = rs.find((r) => r.net === "A")
	const b = rs.find((r) => r.net === "B")
	assert.ok(a && b, "both rails have a region")
	// A's outline holds its corner pad and not B's middle (ray casting over the keyhole outline).
	const inside = (p: { x: number; y: number }[], x: number, y: number) => {
		let c = false
		for (let i = 0, j = p.length - 1; i < p.length; j = i++) if (p[i].y > y !== p[j].y > y && x < ((p[j].x - p[i].x) * (y - p[i].y)) / (p[j].y - p[i].y) + p[i].x) c = !c
		return c
	}
	assert.equal(inside(a.outline, -15, -15), true)
	assert.equal(inside(a.outline, 0, 0), false, "B's middle is A's hole")
})

// The antenna's keep-out band (lead-2, 27 Nov 2026: the In2 cut, the follow-up to the band on the pours): a cell outside
// the given outline belongs to no rail, so a region stops at the band's edge.
test("a region stays inside the outline it is given: the antenna band's notch is left out", () => {
	// 40×30 board, a 10×8 notch at the top edge from x = 5 to 15.
	const within = [{ x: -20, y: -15 }, { x: -20, y: 15 }, { x: 5, y: 15 }, { x: 5, y: 7 }, { x: 15, y: 7 }, { x: 15, y: 15 }, { x: 20, y: 15 }, { x: 20, y: -15 }]
	const rails = [{ net: "A", points: [{ x: -10, y: 0 }] }, { net: "B", points: [{ x: 10, y: 0 }] }]
	const whole = planeRegions(40, 30, rails)
	const cut = planeRegions(40, 30, rails, undefined, undefined, undefined, within)
	const b = cut.find((r) => r.net === "B")!
	assert.equal(inside(b.outline, { x: 10, y: 11 }), false, "the notch is outside B's region")
	assert.equal(inside(b.outline, { x: 17, y: 11 }), true, "beside the notch B keeps its copper")
	assert.equal(whole.find((r) => r.net === "B")!.cells - b.cells, 11 * 8 * 4, "B loses the notch grown to whole cells (x 4.5..15.5, y 6.5..14.5 at a 0.5 mm step), no more")
	assert.equal(cut.find((r) => r.net === "A")!.cells, whole.find((r) => r.net === "A")!.cells, "A, away from the notch, is untouched")
})

test("the arm's In2 rail regions leave its antenna band out (bar the module's own column), as the ground pour does", async () => {
	const { readFileSync } = await import("node:fs")
	const { layoutBoard, powerPlaneRegions, antennaNotch } = await import("../src/codegen/circuit.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-mock-rev14.json", import.meta.url), "utf8"))
	const z = layoutBoard(s).antennaZone!
	assert.ok(z, "the arm has a band")
	const o = s.values.outline
	const notch = antennaNotch(o.widthMm, o.heightMm, z)!
	const cut = powerPlaneRegions(s)
	const whole = powerPlaneRegions(s, undefined, null)
	// Every corner of every region lies inside the notched outline (a vertex on its edge counts: nudge toward the board's middle).
	for (const r of cut) for (const p of r.outline) assert.ok(inside(notch, { x: p.x * 0.999, y: p.y * 0.999 }), `${r.net} at ${p.x},${p.y} is in the band`)
	const cells = (rs: typeof cut) => rs.reduce((t, r) => t + r.cells, 0)
	assert.ok(cells(cut) < cells(whole), "the band's cells are taken off")
	assert.deepEqual(cut.map((r) => r.neckMm), whole.map((r) => r.neckMm), "no rail's neck narrows")
})
