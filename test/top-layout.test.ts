// The top view's pure geometry (src/dashboard/top-layout.js): plate, boards and cables in SVG millimetres.
import { test } from "node:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import assert from "node:assert/strict"
import { topLayout, boardShapes } from "../src/dashboard/top-layout.js"
import { autoLayout } from "../src/dashboard/world3d.js"

const ab = (name: string, xMm: number, yMm: number, w: number, h: number, rotDeg = 0, outlineSource = "built") => ({ name, xMm, yMm, rotDeg, outline: { widthMm: w, heightMm: h }, outlineSource })
const link = (id: string, a: string, b: string, extra: Record<string, unknown> = {}) => ({ id, kind: "uart", a: { board: a }, b: { board: b }, cable: { lengthMm: 300 }, ...extra })
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`)

test("chassis robot: plate and boards in svg millimetres", () => {
	const assembly = { body: "chassis", plate: { lengthMm: 156, widthMm: 110 }, boards: [ab("main", 0, 0, 33, 42), ab("climate", 40, 20, 36, 26)] }
	const s = topLayout(assembly, [{ name: "main" }, { name: "climate" }], [link("L1", "main", "climate")])
	assert.deepEqual(s.plate, { x: -78, y: -55, w: 156, h: 110 })
	const main = s.boards.find((b) => b.name === "main")!
	assert.deepEqual({ x: main.x, y: main.y }, { x: -16.5, y: -21 })
	const cl = s.boards.find((b) => b.name === "climate")!
	assert.deepEqual({ x: cl.x, y: cl.y }, { x: 22, y: -33 }) // y flips: left (+20) is up (-)
	assert.deepEqual(s.bounds, { x: -88, y: -65, w: 176, h: 130 })
})

test("a 90° board swaps its footprint", () => {
	const s = topLayout({ body: "chassis", plate: { lengthMm: 100, widthMm: 100 }, boards: [ab("a", 0, 0, 40, 30, 90)] }, [{ name: "a" }], [])
	assert.equal(s.boards[0].w, 30)
	assert.equal(s.boards[0].h, 40)
})

test("unbuilt board draws as its planned box", () => {
	const s = topLayout({ body: "chassis", plate: { lengthMm: 100, widthMm: 100 }, boards: [ab("a", 0, 0, 20, 10, 0, "estimate")] }, [{ name: "a" }], [])
	assert.equal(s.boards[0].built, false)
	assert.equal(s.boards[0].w, 20)
	assert.equal(s.boards[0].h, 10)
})

test("a cable with no edge ends on the facing edge", () => {
	const s = topLayout({ body: "chassis", plate: { lengthMm: 200, widthMm: 100 }, boards: [ab("a", -40, 0, 20, 20), ab("b", 40, 0, 20, 20)] }, [{ name: "a" }, { name: "b" }], [link("L1", "a", "b")])
	const c = s.cables[0]
	assert.deepEqual(c.from, { x: -30, y: 0 })
	assert.deepEqual(c.to, { x: 30, y: 0 })
	assert.equal(c.path, "M-30 0L30 0")
})

test("a cable ends at its connector when the board names one", () => {
	const boards = [{ name: "a", connectors: [{ ref: "J1", kind: "header", edge: "left", offsetMm: 5 }] }, { name: "b" }]
	const s = topLayout({ body: "chassis", plate: { lengthMm: 200, widthMm: 100 }, boards: [ab("a", 0, 0, 20, 20), ab("b", 60, 0, 20, 20)] }, boards, [link("L1", "a", "b", { a: { board: "a", edge: "left" } })])
	const c = s.cables[0]
	// a's left edge is x=-10; 5 mm from the bottom (y=-10 in assembly) is assembly y -5, svg y 5.
	near(c.from.x, -10)
	near(c.from.y, 5)
	assert.ok(c.path.includes("Q"), "edges that do not face each other bend")
})

test("separate body falls back to autoLayout", () => {
	const boards = [{ name: "a", outline: { widthMm: 40, heightMm: 30 } }, { name: "b", outline: { widthMm: 20, heightMm: 20 } }]
	const links = [link("L1", "a", "b")]
	const s = topLayout({ body: "separate", boards: [] }, boards, links)
	const auto = autoLayout(boards, links)
	assert.equal(s.plate, null)
	const a = s.boards.find((b) => b.name === "a")!
	near(a.x, auto.a.x - 20)
	near(a.y, -auto.a.y - 15)
	assert.equal(a.built, true)
	assert.equal(s.bounds.w, Math.max(...s.boards.map((b) => b.x + b.w)) - Math.min(...s.boards.map((b) => b.x)) + 20)
})

test("label carries id, kind and length", () => {
	const s = topLayout({ body: "chassis", plate: { lengthMm: 200, widthMm: 100 }, boards: [ab("a", -40, 0, 20, 20), ab("b", 40, 0, 20, 20)] }, [{ name: "a" }, { name: "b" }], [link("L1", "a", "b")])
	assert.equal(s.cables[0].label, "L1 · UART · 300 mm")
	assert.deepEqual(s.cables[0].mid, { x: 0, y: 0 })
})

test("a board the assembly does not place is still drawn, beside the plate, with its cable", () => {
	const s = topLayout({ body: "chassis", plate: { lengthMm: 100, widthMm: 80 }, boards: [ab("a", 0, 0, 20, 20)] }, [{ name: "a" }, { name: "b", outline: { widthMm: 20, heightMm: 10 } }, { name: "c" }], [link("L1", "a", "b")])
	assert.equal(s.boards.length, 3)
	const b = s.boards.find((x) => x.name === "b")!
	assert.ok(b.x >= 50, "right of the plate")
	assert.equal(b.built, true)
	assert.equal(s.boards.find((x) => x.name === "c")!.built, false)
	assert.equal(s.cables.length, 1)
	assert.ok(s.bounds.x + s.bounds.w >= b.x + b.w, "bounds cover it")
})

test("a separate board with no outline is the 40 x 30 planned box, unbuilt", () => {
	const s = topLayout({ body: "separate", boards: [] }, [{ name: "a" }], [])
	assert.deepEqual([s.boards[0].w, s.boards[0].h, s.boards[0].built], [40, 30, false])
})

test("a link with no cable length has no length in its label", () => {
	const s = topLayout({ body: "chassis", plate: { lengthMm: 200, widthMm: 100 }, boards: [ab("a", -40, 0, 20, 20), ab("b", 40, 0, 20, 20)] }, [{ name: "a" }, { name: "b" }], [link("L1", "a", "b", { cable: undefined })])
	assert.equal(s.cables[0].label, "L1 · UART")
})

test("a cable end on a 90° board lies on the turned board's edge", () => {
	// 40 x 20 board turned a quarter (counter-clockwise from above, as in src/mechanics): its unturned left edge
	// (x=-20) now faces down the svg page's bottom (assembly -y); offset 5 from the bottom of that edge.
	const boards = [{ name: "a", connectors: [{ ref: "J1", kind: "header", edge: "left", offsetMm: 5 }] }, { name: "b" }]
	const s = topLayout({ body: "chassis", plate: { lengthMm: 200, widthMm: 100 }, boards: [ab("a", 0, 0, 40, 20, 90), ab("b", 0, -60, 20, 20)] }, boards, [link("L1", "a", "b", { a: { board: "a", edge: "left" } })])
	const a = s.boards.find((x) => x.name === "a")!
	assert.deepEqual([a.w, a.h], [20, 40])
	const f = s.cables[0].from
	near(f.y, a.y + a.h) // the bottom edge of the turned footprint
	assert.ok(f.x >= a.x && f.x <= a.x + a.w)
	near(f.x, 5) // local (-20,-5) turned 90 CCW is (5,-20); svg x = 5
})

const fixtureCircuit = (() => {
	const base = "out/system-real-5/boards/logger/board"
	if (!existsSync(base)) return null
	const revs = readdirSync(base).filter((d) => /^rev-\d+$/.test(d)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
	for (const p of [...revs.reverse().map((r) => `${base}/${r}/dist/board/circuit.json`), `${base}/circuit.json`]) if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"))
	return null
})()

test("boardShapes: outline matches pcb_board", { skip: !fixtureCircuit }, () => {
	const b = (fixtureCircuit as any[]).find((e) => e.type === "pcb_board")
	const s = boardShapes(fixtureCircuit)
	assert.equal(s.outline.w, b.width)
	assert.equal(s.outline.h, b.height)
	assert.ok(s.parts.length > 0 && s.pads.length > 0)
})

test("boardShapes: parts sit inside the outline", { skip: !fixtureCircuit }, () => {
	const s = boardShapes(fixtureCircuit)
	for (const p of s.parts) {
		assert.ok(p.x >= -0.5 && p.y >= -0.5 && p.x + p.w <= s.outline.w + 0.5 && p.y + p.h <= s.outline.h + 0.5, `${p.ref} ${JSON.stringify(p)}`)
	}
})

test("boardShapes: a hand-made circuit gives one part and two pads", () => {
	const s = boardShapes([
		{ type: "pcb_board", center: { x: 0, y: 0 }, width: 20, height: 10 },
		{ type: "source_component", source_component_id: "s0", name: "R1" },
		{ type: "pcb_component", pcb_component_id: "c0", source_component_id: "s0", center: { x: 0, y: 0 }, width: 3, height: 1, rotation: 0 },
		{ type: "pcb_smtpad", pcb_component_id: "c0", shape: "rect", x: -1, y: 0, width: 1, height: 1 },
		{ type: "pcb_smtpad", pcb_component_id: "c0", shape: "rect", x: 1, y: 0, width: 1, height: 1 },
		{ type: "pcb_hole", x: -9, y: 4, hole_diameter: 2 },
	])
	assert.deepEqual(s.outline, { w: 20, h: 10 })
	assert.deepEqual(s.parts, [{ x: 8.5, y: 4.5, w: 3, h: 1, ref: "R1" }])
	assert.equal(s.pads.length, 2)
	assert.deepEqual(s.pads[0], { x: 8.5, y: 4.5, w: 1, h: 1 })
	assert.deepEqual(s.holes, [{ x: 1, y: 1, r: 1 }])
})
