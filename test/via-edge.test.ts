// tscircuit's router can drop a via closer to the board edge than the fab allows (the rover at 42×29 mm with its motor
// driver turned: a via 0.287 mm from the edge against 0.3 mm), and the board then left its debug footprint off. The
// board build moves such a via inward to the fab's clearance and brings the ends of its traces with it
// (src/tools/via-edge.ts); KiCad's DRC then checks the result as before.
import { test } from "node:test"
import assert from "node:assert/strict"
import { nudgeEdgeVias } from "../src/tools/via-edge.ts"

const edge = (x1: number, y1: number, x2: number, y2: number) => `  (gr_line\n    (start ${x1} ${y1})\n    (end ${x2} ${y2})\n    (width 0.1)\n    (layer Edge.Cuts)\n  )\n`
// A 42 × 29 mm board at (79, 85.5)–(121, 114.5), as tscircuit exports it.
const outline = edge(79, 114.5, 121, 114.5) + edge(121, 114.5, 121, 85.5) + edge(121, 85.5, 79, 85.5) + edge(79, 85.5, 79, 114.5)
const via = (x: number, y: number, net: number) => `  (via\n    (at ${x} ${y})\n    (size 0.45)\n    (drill 0.25)\n    (layers F.Cu B.Cu)\n    (net ${net})\n    (uuid v-${x}-${y})\n  )\n`
const seg = (x1: number, y1: number, x2: number, y2: number, net: number, layer = "F.Cu") => `  (segment\n    (start ${x1} ${y1})\n    (end ${x2} ${y2})\n    (width 0.15)\n    (layer ${layer})\n    (net ${net})\n    (uuid s-${x1}-${y1})\n  )\n`
const pcb = (...items: string[]) => `(kicad_pcb\n${outline}${items.join("")})\n`
const vias = (text: string) => [...text.matchAll(/\(via\s+\(at ([\d.]+) ([\d.]+)\)/g)].map((m) => [Number(m[1]), Number(m[2])])
const segs = (text: string) => [...text.matchAll(/\(segment\s+\(start ([\d.]+) ([\d.]+)\)\s+\(end ([\d.]+) ([\d.]+)\)/g)].map((m) => m.slice(1, 5).map(Number))

test("a via too near the left edge moves inward to the fab's clearance, and the traces ending on it follow", () => {
	// Centre 0.512 mm from the edge: its copper (radius 0.225) is 0.287 mm from it, under 0.3.
	const before = pcb(via(79.512, 100, 7), seg(85, 100, 79.512, 100, 7), seg(79.512, 100, 79.512, 104, 7, "B.Cu"))
	const r = nudgeEdgeVias(before, 0.3)
	assert.equal(r.moved.length, 1)
	const [[x, y]] = vias(r.pcb)
	assert.ok(x - 79 - 0.225 >= 0.3, `copper ${(x - 79 - 0.225).toFixed(3)} mm from the edge`)
	assert.ok(x - 79 - 0.225 < 0.35, "moved no further than needed")
	assert.equal(y, 100)
	const [a, b] = segs(r.pcb)
	assert.deepEqual([a[2], a[3]], [x, y], "the F.Cu trace's end is on the via")
	assert.deepEqual([b[0], b[1]], [x, y], "the B.Cu trace's start is on the via")
	assert.deepEqual([a[0], a[1], b[2], b[3]], [85, 100, 79.512, 104], "the traces' far ends stay")
})

test("a via near a corner moves in on both axes", () => {
	const r = nudgeEdgeVias(pcb(via(120.6, 114.2, 3)), 0.3)
	const [[x, y]] = vias(r.pcb)
	assert.ok(121 - x - 0.225 >= 0.3 && 114.5 - y - 0.225 >= 0.3, `${x}, ${y}`)
})

test("a via already clear of the edge, and another net's trace through the old spot, are left alone", () => {
	const ok = pcb(via(100, 100, 7), seg(79.512, 90, 90, 90, 9))
	const r = nudgeEdgeVias(ok, 0.3)
	assert.equal(r.moved.length, 0)
	assert.equal(r.pcb, ok)
	const near = nudgeEdgeVias(pcb(via(79.512, 100, 7), seg(79.512, 100, 85, 100, 8)), 0.3)
	assert.deepEqual(segs(near.pcb)[0], [79.512, 100, 85, 100], "a trace of another net is not dragged along")
})

test("a board with no Edge.Cuts outline is returned unchanged", () => {
	const text = `(kicad_pcb\n${via(79.512, 100, 7)})\n`
	assert.deepEqual(nudgeEdgeVias(text, 0.3), { pcb: text, moved: [] })
})

// The scripted rover at 43×28 mm (15 Nov 2026) left its debug footprint off: a GND via 0.1734 mm from one of the
// TC2030's unplated holes against the fab's 0.2 mm. The footprint is turned 90° on the bottom; its hole's place comes
// from the footprint's own position and turn.
const npth = (fx: number, fy: number, rot: number, lx: number, ly: number, d: number) =>
	`  (footprint\n    "tscircuit:chip"\n    (layer B.Cu)\n    (at ${fx} ${fy} ${rot})\n    (pad "" np_thru_hole circle\n      (at ${lx} ${ly} 0)\n      (size ${d} ${d})\n      (drill ${d})\n      (layers *.Cu *.Mask)\n    )\n  )\n`

test("a via too near an unplated hole moves straight away from it to the fab's hole clearance, its traces with it", async () => {
	const { nudgeVias } = await import("../src/tools/via-edge.ts")
	// The real case: JD1 at (107.5, 108) turned 90°, its hole at local (-2.54, 1.016), so at (108.516, 110.54).
	const before = pcb(npth(107.5, 108, 90, -2.54, 1.016, 0.991), via(107.892, 109.9, 4), seg(104, 109.9, 107.892, 109.9, 4))
	const r = nudgeVias(before, { edgeMm: 0.3, holeMm: 0.2 })
	assert.equal(r.moved.length, 1)
	const [[x, y]] = vias(r.pcb)
	const gap = Math.hypot(x - 108.516, y - 110.54) - 0.991 / 2 - 0.225
	assert.ok(gap >= 0.2 && gap < 0.25, `copper ${gap.toFixed(3)} mm from the hole`)
	assert.deepEqual(segs(r.pcb)[0].slice(2), [x, y], "the trace's end is on the via")
	// A via already clear of the hole stays.
	const clear = pcb(npth(107.5, 108, 90, -2.54, 1.016, 0.991), via(100, 100, 4))
	assert.equal(nudgeVias(clear, { edgeMm: 0.3, holeMm: 0.2 }).moved.length, 0)
})

// The subscription run's 64×25 mm rover (15 Nov 2026) left its debug footprint off: the router ran JD1.pin2's trace to
// U1 along the board's edge, its copper 0.25 mm from it against the fab's 0.3. A trace's corner too near the edge moves
// inward by what's missing, with the same net's segment ends that meet it.
test("a trace running too near the edge moves inward by what's missing, its joints with it", async () => {
	const { nudgeVias } = await import("../src/tools/via-edge.ts")
	// The top edge is y = 85.5 (KiCad y down); a 0.15 mm trace at y = 85.86 has its copper 0.285 mm from it.
	const before = pcb(seg(90, 88, 92, 85.86, 5), seg(92, 85.86, 96, 85.86, 5), seg(96, 85.86, 98, 88, 5), seg(90, 85.86, 92, 85.86, 6))
	const r = nudgeVias(before, { edgeMm: 0.3, holeMm: 0.2 })
	const s = segs(r.pcb)
	const need = 85.5 + 0.3 + 0.075
	for (const [i, k] of [[0, 3], [1, 1], [1, 3], [2, 1]] as const) assert.ok(s[i][k] >= need, `segment ${i} end at y ${s[i][k]}`)
	assert.equal(s[0][3], s[1][1], "the joint stays joined")
	assert.equal(s[1][3], s[2][1], "the joint stays joined")
	assert.deepEqual([s[0][0], s[0][1], s[2][2], s[2][3]], [90, 88, 98, 88], "ends away from the edge stay")
	assert.ok(s[3][1] >= need && s[3][3] >= need, "another net's trace too")
	assert.ok(s[3][1] - 85.86 < 0.05, "moved no further than needed")
})

test("a trace end on a pad at the edge stays on the pad (an edge connector's pads are there on purpose)", async () => {
	const { nudgeVias } = await import("../src/tools/via-edge.ts")
	const pad = `  (footprint\n    "tscircuit:usb"\n    (layer F.Cu)\n    (at 100 85.7 0)\n    (pad "1" smd rect\n      (at 0 0 0)\n      (size 0.6 1.2)\n      (layers F.Cu)\n    )\n  )\n`
	const r = nudgeVias(pcb(pad, seg(100, 85.7, 100, 90, 5)), { edgeMm: 0.3, holeMm: 0.2 })
	assert.deepEqual(segs(r.pcb)[0], [100, 85.7, 100, 90])
})
