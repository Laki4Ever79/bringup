// The system edit model (src/dashboard/system-edit.js): moves with code checks, undo stops at the applied state.
import { test } from "node:test"
import assert from "node:assert/strict"
import { editor } from "../src/dashboard/system-edit.js"
import { i2cCableLimit } from "../src/dashboard/assembly-geom.js"
import { assemblyErrors, mergeRequest, type SystemAssembly } from "../src/system/assembly.ts"
import type { SystemLink, SystemSpec } from "../src/system/spec.ts"
import type { ChassisSpec } from "../src/tools/chassis.ts"

const bd = (name: string, xMm: number, yMm = 0) => ({ name, xMm, yMm, rotDeg: 0 as const, outline: { widthMm: 40, heightMm: 30 }, outlineSource: "estimate" as const })
const assembly = (): SystemAssembly => ({ body: "chassis", plate: { lengthMm: 200, widthMm: 120 }, boards: [bd("main", -40), bd("front", 40)] })
const chassis = { drive: { trackMm: 130, axleXMm: -60, wheelbaseMm: 90, wheelDiameterMm: 40, wheelWidthMm: 10 }, caster: { xMm: 80, wheelMm: 20 }, battery: { xMm: 0, yMm: 40, sizeMm: [30, 20, 15] } } as unknown as ChassisSpec
const start = (extra = {}) => ({ assembly: assembly(), links: [] as SystemLink[], ...extra })

test("a move snaps to 0.5 mm", () => {
	const e = editor(start())
	e.apply({ kind: "move", board: "main", xMm: -33.26, yMm: 4.74 })
	const b = e.state().assembly.boards[0]
	assert.deepEqual([b.xMm, b.yMm], [-33.5, 4.5])
})

test("four rotations return to 0", () => {
	const e = editor(start())
	const seen = []
	for (let i = 0; i < 4; i++) { e.apply({ kind: "rotate", board: "main" }); seen.push(e.state().assembly.boards[0].rotDeg) }
	assert.deepEqual(seen, [90, 180, 270, 0])
})

test("an overlap is an error on both boards", () => {
	const e = editor(start())
	assert.deepEqual(e.findings(), [])
	e.apply({ kind: "move", board: "front", xMm: -30, yMm: 0 })
	const f = e.findings().filter((x) => x.level === "error")
	assert.deepEqual(f.map((x) => x.target.board).sort(), ["front", "main"])
})

test("the editor and the server agree on overlap and on-plate", () => {
	const e = editor(start())
	e.apply({ kind: "move", board: "front", xMm: 95, yMm: 0 })
	const spec: SystemSpec = { name: "s", boards: [{ name: "main", brief: "m" }, { name: "front", brief: "f" }], links: [], assembly: e.state().assembly }
	assert.equal(assemblyErrors(spec).length, 1)
	assert.equal(e.findings().filter((x) => x.level === "error").length, 1)
})

test("a board over a wheel is an error", () => {
	const e = editor(start({ chassis }))
	e.apply({ kind: "plate", lengthMm: 200, widthMm: 160 })
	e.apply({ kind: "move", board: "front", xMm: -60, yMm: 65 })
	assert.ok(e.findings().some((x) => x.level === "error" && x.target.board === "front" && /wheel/.test(x.message)))
})

test("a board over the battery is an error", () => {
	const e = editor(start({ chassis }))
	e.apply({ kind: "move", board: "front", xMm: 0, yMm: 40 })
	assert.ok(e.findings().some((x) => x.target.board === "front" && /battery/.test(x.message)))
})

test("the brief's size limit is checked, wheels included", () => {
	const e = editor(start({ chassis, maxSizeMm: [200, 120] }))
	assert.ok(e.findings().some((x) => x.target.plate && /over the/.test(x.message)), "track + wheel is 140 wide")
	const ok = editor(start({ chassis: null, maxSizeMm: [200, 120] }))
	assert.deepEqual(ok.findings(), [])
	ok.apply({ kind: "plate", lengthMm: 210, widthMm: 120 })
	assert.ok(ok.findings().some((x) => x.target.plate))
})

test("an I2C route over the limit is an error; UART is not limited", () => {
	const e = editor(start())
	e.apply({ kind: "cable-add", a: "main", b: "front", cableKind: "i2c" })
	const { maxMm } = i2cCableLimit(100, 0)
	assert.deepEqual(e.findings(), [], "a short bus cable is fine")
	e.apply({ kind: "cable-route", link: "L1", points: [{ xMm: -20, yMm: 0 }, { xMm: -20, yMm: 50 }, { xMm: 20, yMm: 50 }, { xMm: 20, yMm: 0 }, { xMm: 60, yMm: 0 }, { xMm: 60, yMm: -40 }, { xMm: 2200, yMm: -40 }] })
	const route = e.state().assembly.cables![0].points
	assert.ok(e.state().links[0].cable.lengthMm > maxMm)
	assert.equal(route.length, 7)
	assert.ok(e.findings().some((x) => x.level === "error" && x.target.link === "L1"))
	e.apply({ kind: "cable-kind", link: "L1", cableKind: "uart" })
	assert.deepEqual(e.findings(), [])
})

test("the I2C limit sums the devices on both boards, as the server's check does", () => {
	const limit = i2cCableLimit(100, 3).maxMm
	const route = (len: number) => ({ kind: "cable-route" as const, link: "L1", points: [{ xMm: -20, yMm: 0 }, { xMm: -20 + len, yMm: 0 }] })
	const over = (byBoard: Record<string, number>) => {
		const e = editor(start({ i2cDevicesByBoard: byBoard }))
		e.apply({ kind: "cable-add", a: "main", b: "front", cableKind: "i2c" })
		e.apply(route(limit - 40 + 10))
		return e.findings().some((x) => x.level === "error" && x.target.link === "L1")
	}
	assert.equal(over({ main: 2, front: 1 }), true)
	assert.equal(over({ main: 2, front: 0 }), false)
	assert.equal(over({}), false)
})

test("undo and redo", () => {
	const e = editor(start())
	e.apply({ kind: "move", board: "main", xMm: -50, yMm: 0 })
	e.apply({ kind: "move", board: "main", xMm: -60, yMm: 0 })
	e.undo()
	assert.equal(e.state().assembly.boards[0].xMm, -50)
	e.redo()
	assert.equal(e.state().assembly.boards[0].xMm, -60)
	e.undo(); e.undo()
	assert.equal(e.state().assembly.boards[0].xMm, -40)
	assert.equal(e.undo(), false)
	e.apply({ kind: "move", board: "main", xMm: -45, yMm: 0 })
	assert.equal(e.redo(), false, "a new edit drops the redo branch")
})

test("undo stops at the applied state", () => {
	const e = editor(start())
	e.apply({ kind: "move", board: "main", xMm: -50, yMm: 0 })
	e.markApplied()
	e.apply({ kind: "move", board: "main", xMm: -60, yMm: 0 })
	assert.equal(e.undo(), true)
	assert.equal(e.undo(), false)
	assert.equal(e.state().assembly.boards[0].xMm, -50)
	assert.equal(e.diff(), null)
})

test("diff is null after markApplied and names only what changed", () => {
	const e = editor(start())
	assert.equal(e.diff(), null)
	e.apply({ kind: "move", board: "main", xMm: -50, yMm: 0 })
	const d = e.diff()!
	assert.deepEqual(Object.keys(d.assembly!), ["boards"])
	assert.equal(d.links, undefined)
	e.markApplied()
	assert.equal(e.diff(), null)
	e.apply({ kind: "plate", lengthMm: 220, widthMm: 120 })
	assert.deepEqual(Object.keys(e.diff()!.assembly!), ["plate"])
})

test("cable-add sets both edges facing each other, and rotating re-faces the route", () => {
	const e = editor(start())
	e.apply({ kind: "cable-add", a: "main", b: "front", cableKind: "uart" })
	let l = e.state().links[0]
	assert.deepEqual([l.a.edge, l.b.edge], ["right", "left"])
	const pts = e.state().assembly.cables![0].points
	assert.deepEqual(pts, [{ xMm: -20, yMm: 0 }, { xMm: 20, yMm: 0 }])
	assert.equal(l.cable.lengthMm, 80)
	e.apply({ kind: "move", board: "front", xMm: -40, yMm: 50 })
	l = e.state().links[0]
	assert.deepEqual([l.a.edge, l.b.edge], ["top", "bottom"], "front now sits above main: the edges follow")
	e.apply({ kind: "rotate", board: "front" })
	l = e.state().links[0]
	assert.equal(l.b.edge, "left", "turned 90 deg counter-clockwise, its left edge faces down")
	e.apply({ kind: "cable-edge", link: "L1", end: "b", edge: "bottom" })
	e.apply({ kind: "rotate", board: "front" })
	e.apply({ kind: "move", board: "main", xMm: -42, yMm: 0 })
	l = e.state().links[0]
	assert.equal(l.b.edge, "bottom", "a pinned edge survives moves and turns")
	assert.equal(l.a.edge, "top", "an unpinned end still follows")
	e.apply({ kind: "cable-remove", link: "L1" })
	assert.deepEqual(e.state().links, [])
	assert.deepEqual(e.state().assembly.cables, [])
})

test("a routed cable sets its edges from its direction and its length with slack", () => {
	const e = editor(start())
	e.apply({ kind: "cable-add", a: "main", b: "front", cableKind: "uart" })
	e.apply({ kind: "cable-route", link: "L1", points: [{ xMm: -40, yMm: 15 }, { xMm: -40, yMm: 40 }, { xMm: 40, yMm: 40 }, { xMm: 40, yMm: 15 }] })
	const l = e.state().links[0]
	assert.deepEqual([l.a.edge, l.b.edge], ["top", "top"])
	assert.equal(l.cable.lengthMm, 25 + 80 + 25 + 40)
})

test("standoffs: kept by the request merge; 3-30 mm is the range and 5-20 the usual", () => {
	const e = editor(start())
	e.apply({ kind: "standoff", board: "main", heightMm: 12 })
	assert.deepEqual(e.findings(), [])
	e.apply({ kind: "standoff", board: "main", heightMm: 25 })
	assert.deepEqual(e.findings().map((x) => x.level), ["warn"])
	e.apply({ kind: "standoff", board: "main", heightMm: 2 })
	assert.deepEqual(e.findings().map((x) => x.level), ["error"])
	e.apply({ kind: "standoff", board: "main", heightMm: 12 })
	const spec: SystemSpec = { name: "s", boards: [{ name: "main", brief: "m" }, { name: "front", brief: "f" }], links: [], assembly: assembly() }
	const merged = mergeRequest(spec, e.diff()!)
	assert.equal(merged.assembly!.boards[0].standoffMm, 12)
	const tooLow = { ...merged, assembly: { ...merged.assembly!, boards: [{ ...merged.assembly!.boards[0], standoffMm: 2 }, merged.assembly!.boards[1]] } }
	assert.ok(assemblyErrors(tooLow).some((m) => /standoffs/.test(m)))
})
