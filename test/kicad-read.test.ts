import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { readBoardEdits } from "../src/tools/kicad-read.ts"

// A logger board as built: 40×30 mm, J1 (USB-C) on the left edge 15 mm up, J2 the battery JST (a part, not a connector).
const PCB = readFileSync(join(ROOT, "test/data/drc-j1/board.kicad_pcb"), "utf8")
const J1_AT = "(at 86 100 270)"

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 0.1, `${what}: ${a} vs ${b}`)
const j1 = (text: string) => readBoardEdits(text).connectors.find((c) => c.ref === "J1")!

test("reads the Edge.Cuts outline and J1's edge and offset back from a built board", () => {
	const { outline, connectors } = readBoardEdits(PCB)
	near(outline.widthMm, 40, "width")
	near(outline.heightMm, 30, "height")
	assert.deepEqual(connectors.map((c) => c.ref).sort(), ["J1", "J2"])
	assert.equal(j1(PCB).edge, "left")
	near(j1(PCB).offsetMm, 15, "J1 offset")
})

test("moving J1 in the file moves its offset: KiCad's y runs down, the contract's offset runs up from the bottom", () => {
	assert.ok(PCB.includes(J1_AT))
	near(j1(PCB.replace(J1_AT, "(at 86 95 270)")).offsetMm, 20, "5 mm up")
	near(j1(PCB.replace(J1_AT, "(at 86 108.5 270)")).offsetMm, 6.5, "8.5 mm down")
})

test("J1 dragged to another edge and turned there reports that edge, offset from the bottom-left corner", () => {
	// Bottom edge (KiCad y 115), 6 mm in, mouth down: rotation 0.
	const bottom = j1(PCB.replace(J1_AT, "(at 92 109 0)"))
	assert.deepEqual([bottom.edge, Math.round(bottom.offsetMm)], ["bottom", 12])
	const top = j1(PCB.replace(J1_AT, "(at 110 91 180)"))
	assert.deepEqual([top.edge, Math.round(top.offsetMm)], ["top", 30])
	const right = j1(PCB.replace(J1_AT, "(at 114 90 90)"))
	assert.deepEqual([right.edge, Math.round(right.offsetMm)], ["right", 25])
	// Near a corner the rotation decides: 4 mm above the bottom edge but still turned for the left one.
	const corner = j1(PCB.replace(J1_AT, "(at 86 111 270)"))
	assert.deepEqual([corner.edge, Math.round(corner.offsetMm)], ["left", 4])
	// Dragged to the bottom edge without turning it: the nearest edge wins.
	const unturned = j1(PCB.replace(J1_AT, "(at 100 113 270)"))
	assert.equal(unturned.edge, "bottom")
})

test("a KiCad re-save (new formatting, a gr_rect outline, moved origin, extra footprints and tracks) reads the same", () => {
	const edge = /\(gr_line\s+\(start [^)]*\)\s+\(end [^)]*\)\s+\(width [^)]*\)\s+\(layer Edge\.Cuts\)\s+\)/g
	assert.equal(PCB.match(edge)?.length, 4)
	let resaved = PCB.replace(edge, "").replace(/^\(kicad_pcb/, '(kicad_pcb\n\t(gr_rect (start 80 85) (end 120 115) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "e1"))')
	// Tabs, quoted layer names, the reference as fp_text the way older KiCad writes it.
	resaved = resaved.replace(/\n {2,}/g, (m) => "\n" + "\t".repeat((m.length - 1) / 2)).replace(/\(layer F\.Cu\)/g, '(layer "F.Cu")')
	resaved = resaved.replace(/\(property "Reference" "J1"/, '(fp_text reference "J1"')
	resaved = resaved.replace(/\)\s*$/, '\t(footprint "Resistor_SMD:R_0402" (layer "F.Cu") (at 101 99 90) (property "Reference" "R99" (at 0 0 0)))\n\t(segment (start 85 85) (end 120 115) (width 0.2) (layer "F.Cu") (net 1))\n\t(gr_line (start 0 0) (end 500 500) (stroke (width 0.1)) (layer "F.SilkS"))\n)\n')
	const shift = (t: string) => t.replace(/\((start|end|at) ([-\d.]+) ([-\d.]+)/g, (_, k, x, y) => `(${k} ${+x + 50} ${+y - 20}`)
	for (const text of [resaved, shift(resaved)]) {
		const { outline, connectors } = readBoardEdits(text)
		near(outline.widthMm, 40, "width")
		near(outline.heightMm, 30, "height")
		assert.deepEqual(connectors.map((c) => c.ref).sort(), ["J1", "J2"])
		assert.equal(j1(text).edge, "left")
		near(j1(text).offsetMm, 15, "J1 offset")
	}
})

test("a file with no Edge.Cuts outline is an error, not a 0×0 board", () => {
	assert.throws(() => readBoardEdits("(kicad_pcb (version 20241229))"), /Edge\.Cuts/)
})
