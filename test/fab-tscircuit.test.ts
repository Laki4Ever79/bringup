// The fab files without KiCad (src/tools/fab.ts exportFabWithTscircuit): the paste made KiCad's, the CPL from tscircuit's.
import { test } from "node:test"
import assert from "node:assert/strict"
import { cplFromTscircuit, fullPadPaste } from "../src/tools/fab.ts"

test("paste: each SMD pad's opening is the full pad; none over plated through-hole pads and slots", () => {
	const pad = { type: "pcb_smtpad", pcb_smtpad_id: "p0", layer: "top", shape: "rect", width: 0.8, height: 0.4, x: 1, y: 2, port_hints: ["1"], pcb_port_id: "port0" }
	const out = fullPadPaste([
		pad,
		{ type: "pcb_solder_paste", pcb_solder_paste_id: "s0", pcb_smtpad_id: "p0", layer: "top", shape: "rect", width: 0.56, height: 0.28, x: 1, y: 2 },
		{ type: "pcb_solder_paste", pcb_solder_paste_id: "s1", layer: "bottom", shape: "rotated_pill", width: 1.1, height: 2, x: 4, y: -7 },
		{ type: "pcb_trace", pcb_trace_id: "t0" },
	])
	const paste = out.filter((e) => e.type === "pcb_solder_paste")
	assert.equal(paste.length, 1)
	assert.deepEqual({ w: paste[0].width, h: paste[0].height, x: paste[0].x, y: paste[0].y, layer: paste[0].layer, id: paste[0].pcb_solder_paste_id }, { w: 0.8, h: 0.4, x: 1, y: 2, layer: "top", id: "s0" })
	assert.equal(paste[0].port_hints, undefined)
	assert.ok(out.some((e) => e.type === "pcb_trace"))
})

test("the CPL from tscircuit's pick-and-place: JLC's columns, mm, Top/Bottom, rotation 0-360", () => {
	const cpl = cplFromTscircuit("Designator,Mid X,Mid Y,Layer,Rotation\nU1,-11.500,1.300,top,0\nC3,2.25,-4,bottom,-90\n")
	assert.equal(cpl, "Designator,Mid X,Mid Y,Layer,Rotation\nU1,-11.5mm,1.3mm,Top,0\nC3,2.25mm,-4mm,Bottom,270\n")
})
