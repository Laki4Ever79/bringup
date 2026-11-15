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
