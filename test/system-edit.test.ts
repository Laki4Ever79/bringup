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

test("a board over a battery thin enough for its standoffs is fine (the mechanics' rule: the pack fits under boards on standoffs)", () => {
	const thin = { ...chassis, battery: { xMm: 0, yMm: 40, sizeMm: [30, 20, 7] } } as unknown as ChassisSpec
	const e = editor(start({ chassis: thin }))
	e.apply({ kind: "move", board: "front", xMm: 0, yMm: 40 })
	assert.ok(!e.findings().some((x) => /battery/.test(x.message)), "7 mm under 8 mm standoffs")
	e.apply({ kind: "standoff", board: "front", heightMm: 6 })
	assert.ok(e.findings().some((x) => x.target.board === "front" && /battery/.test(x.message)), "6 mm standoffs don't clear a 7 mm pack")
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
	e.apply({ kind: "cable-route", link: "L1", points: [{ xMm: -20, yMm: 0 }, { xMm: -20, yMm: 50 }, { xMm: 2200, yMm: 50 }, { xMm: 2200, yMm: -40 }, { xMm: 0, yMm: -40 }, { xMm: 0, yMm: 0 }, { xMm: 20, yMm: 0 }] })
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

test("a board with no standoff of its own takes the chassis's standoffs for the battery rule (a 9 mm pack under 10 mm)", () => {
	const ch = { ...chassis, standoffMm: 10, battery: { xMm: 0, yMm: 40, sizeMm: [30, 20, 9] } } as unknown as ChassisSpec
	const e = editor(start({ chassis: ch }))
	e.apply({ kind: "move", board: "front", xMm: 0, yMm: 40 })
	assert.ok(!e.findings().some((x) => /battery/.test(x.message)), "10 mm chassis standoffs clear a 9 mm pack")
	const thick = editor(start({ chassis: { ...ch, battery: { xMm: 0, yMm: 40, sizeMm: [30, 20, 9.5] } } as unknown as ChassisSpec }))
	thick.apply({ kind: "move", board: "front", xMm: 0, yMm: 40 })
	assert.ok(thick.findings().some((x) => x.level === "error" && /battery/.test(x.message)), "9.5 mm is over 10 − 1")
})

test("a board over the caster is not a finding: the caster hangs under the plate", () => {
	const e = editor(start({ chassis }))
	e.apply({ kind: "move", board: "front", xMm: 75, yMm: 0 })
	assert.deepEqual(e.findings().filter((x) => /caster/.test(x.message)), [])
})

test("check(op) gives an edit's findings without touching the history", () => {
	const e = editor(start())
	e.apply({ kind: "move", board: "front", xMm: 30, yMm: 0 })
	e.undo()
	assert.ok(e.canRedo())
	const f = e.check({ kind: "move", board: "front", xMm: -40, yMm: 0 })
	assert.ok(f.some((x) => /overlaps/.test(x.message)))
	assert.ok(e.canRedo(), "redo kept")
	assert.equal(e.diff(), null)
	assert.equal(e.apply({ kind: "move", board: "front", xMm: 40, yMm: 0 }), false, "a move back to the start is no edit")
	assert.ok(e.canRedo(), "and keeps redo")
})

test("pending() lists the edits since the last Apply, to replay on a newer design", () => {
	const e = editor(start())
	e.apply({ kind: "move", board: "front", xMm: 30, yMm: 0 })
	e.markApplied()
	e.apply({ kind: "rotate", board: "main" })
	e.apply({ kind: "move", board: "main", xMm: -45, yMm: 0 })
	e.undo()
	assert.deepEqual(e.pending(), [{ kind: "rotate", board: "main" }])
	const newer = assembly()
	newer.boards[1].xMm = 50 // the round moved front
	const r = editor({ assembly: newer, links: [] })
	for (const op of e.pending()) r.apply(op)
	assert.deepEqual(r.state().assembly.boards.map((b) => [b.name, b.xMm, b.rotDeg]), [["main", -40, 90], ["front", 50, 0]])
})

// robot-2's own numbers (out/robot-2: main's chassis spec rev-25, the system's assembly, each board's link connector).
const r2Chassis = {
	plate: { lengthMm: 156, widthMm: 110, thicknessMm: 3, clearanceMm: 50.5 },
	standoffMm: 10,
	motors: [{ side: "left", xMm: 30, yMm: 47, bodyMm: [26, 12, 10], axleDropMm: 10.5 }, { side: "right", xMm: 30, yMm: -47, bodyMm: [26, 12, 10], axleDropMm: 10.5 }],
	caster: { xMm: -50, holesMm: [], holeDiaMm: 4.2, wheelMm: 38, heightMm: 50.5 },
	battery: { xMm: 25, yMm: 0, sizeMm: [60, 36, 7] },
	sensor: { xMm: 72, yMm: 0, zMm: 65, sizeMm: [21, 18, 2.8], rangeMm: 1200, updateMs: 33 },
	drive: { trackMm: 130, axleXMm: 30, wheelbaseMm: 80, wheelDiameterMm: 80, wheelWidthMm: 10 },
} as unknown as ChassisSpec
const r2 = (extra = {}) => ({
	assembly: {
		body: "chassis", plate: { lengthMm: 156, widthMm: 110 },
		boards: [
			{ name: "main", xMm: 0, yMm: 0, rotDeg: 0, outline: { widthMm: 33, heightMm: 42 }, outlineSource: "built" },
			{ name: "climate", xMm: 48, yMm: 0, rotDeg: 0, outline: { widthMm: 36, heightMm: 26 }, outlineSource: "built" },
		],
	} as SystemAssembly,
	links: [{ id: "L1", kind: "uart", a: { board: "main" }, b: { board: "climate" }, baud: 115200, cable: { lengthMm: 300 } }] as SystemLink[],
	chassis: r2Chassis,
	maxSizeMm: [160, 150] as [number, number],
	...extra,
})

test("robot-2 as built has no findings", () => {
	assert.deepEqual(editor(r2()).findings(), [])
})

test("mech-fit on the move: a plate wider than track − wheel − 4 rubs the wheels (robot-2: 130 mm is an error, 116 is not)", () => {
	const e = editor(r2())
	assert.ok(e.check({ kind: "plate", lengthMm: 156, widthMm: 130 }).some((x) => x.level === "error" && x.target.plate && /rub/.test(x.message) && /116 mm/.test(x.message)), "130 mm rubs")
	assert.deepEqual(e.check({ kind: "plate", lengthMm: 156, widthMm: 116 }).filter((x) => /rub/.test(x.message)), [])
	assert.ok(e.check({ kind: "plate", lengthMm: 156, widthMm: 116.5 }).some((x) => x.target.plate && /rub/.test(x.message)), "one step past")
})

test("mech-fit on the move: a narrow plate leaves the motors less than half under it", () => {
	const f = editor(r2()).check({ kind: "plate", lengthMm: 156, widthMm: 90 })
	assert.ok(f.some((x) => x.level === "error" && x.target.plate && /motor left/.test(x.message) && /half/.test(x.message)), "the motors need half under the plate")
})

test("mech-fit on the move: a short plate drops the sensor, the caster and the battery", () => {
	const e = editor(r2())
	assert.ok(e.check({ kind: "plate", lengthMm: 140, widthMm: 110 }).some((x) => x.level === "error" && x.target.plate && /^sensor/.test(x.message)), "the sensor is off a 140 mm plate")
	assert.ok(e.check({ kind: "plate", lengthMm: 120, widthMm: 110 }).some((x) => x.target.plate && /^caster/.test(x.message)), "the caster is off a 120 mm plate")
	assert.ok(e.check({ kind: "plate", lengthMm: 100, widthMm: 110 }).some((x) => x.target.plate && /^battery/.test(x.message)), "the battery is off a 100 mm plate")
})

test("mech-fit on the move: a board in front of the distance sensor is an error on that board", () => {
	const e = editor(r2())
	e.apply({ kind: "move", board: "climate", xMm: 92, yMm: 0 })
	assert.ok(e.findings().some((x) => x.level === "error" && x.target.board === "climate" && /in front of the distance sensor/.test(x.message)), "climate blocks the sensor")
	e.undo()
	e.apply({ kind: "move", board: "climate", xMm: 92, yMm: 40 })
	assert.ok(!e.findings().some((x) => /distance sensor/.test(x.message)), "beside it, not in front")
})

// Each board's link connector, as the payload carries it (robot-2: main's JL1 on its right edge, climate's on its top).
const r2Connectors = { main: [{ ref: "JL1", kind: "header", edge: "right", offsetMm: 15.5 }], climate: [{ ref: "JL1", kind: "header", edge: "top", offsetMm: 13 }] }

test("a cable starts from the boards' real connector edges", () => {
	const l = editor(r2({ connectors: r2Connectors })).state().links[0]
	assert.deepEqual([l.a.edge, l.b.edge], ["right", "top"])
})

test("one bend in L1 on robot-2 keeps both real edges, with no warning", () => {
	const e = editor(r2({ connectors: r2Connectors }))
	e.apply({ kind: "cable-route", link: "L1", points: [{ xMm: 16.5, yMm: 0 }, { xMm: 32, yMm: 40 }, { xMm: 48, yMm: 13 }] })
	const l = e.state().links[0]
	assert.deepEqual([l.a.edge, l.b.edge], ["right", "top"])
	assert.deepEqual(e.findings(), [])
})

test("a route that can't leave from the real edge moves the connector: a warning on the link, and the end on the new edge", () => {
	const e = editor(r2({ connectors: r2Connectors }))
	// Out of main's back, around, into climate's top.
	e.apply({ kind: "cable-route", link: "L1", points: [{ xMm: 16.5, yMm: 0 }, { xMm: -40, yMm: 0 }, { xMm: -40, yMm: 40 }, { xMm: 48, yMm: 40 }, { xMm: 48, yMm: 13 }] })
	const l = e.state().links[0]
	assert.deepEqual([l.a.edge, l.b.edge], ["left", "top"])
	const pts = e.state().assembly.cables![0].points
	assert.deepEqual(pts[0], { xMm: -16.5, yMm: 0 }, "the route starts on main's left edge")
	assert.deepEqual(pts.at(-1), { xMm: 48, yMm: 13 })
	const warn = e.findings().filter((x) => x.level === "warn")
	assert.deepEqual(warn, [{ target: { link: "L1" }, level: "warn", message: "moves JL1 on main from right to left edge: a board change" }])
	assert.deepEqual(e.edgeChanges(), [{ link: "L1", board: "main", ref: "JL1", from: "right", to: "left" }])
})

test("a hand-routed cable keeps its edge on a move while it can reach it; a turn re-faces its end on the board", () => {
	const e = editor(r2({ connectors: r2Connectors }))
	e.apply({ kind: "cable-route", link: "L1", points: [{ xMm: 16.5, yMm: 0 }, { xMm: 32, yMm: 40 }, { xMm: 48, yMm: 13 }] })
	e.apply({ kind: "move", board: "climate", xMm: 48, yMm: -10 })
	assert.deepEqual(e.findings(), [], "climate's top still faces the bend")
	e.apply({ kind: "rotate", board: "main" })
	const l = e.state().links[0]
	// Turned 90°, main's right edge faces +y, toward the bend at (32, 40): kept, and the route's end is on it.
	assert.equal(l.a.edge, "right")
	assert.deepEqual(e.state().assembly.cables![0].points[0], { xMm: 0, yMm: 16.5 })
})

test("a move that leaves a cable's edge facing away from its peer re-faces it, moves its end and warns", () => {
	const e = editor(r2({ connectors: r2Connectors }))
	e.apply({ kind: "cable-route", link: "L1", points: [{ xMm: 16.5, yMm: 0 }, { xMm: 48, yMm: 30 }, { xMm: 48, yMm: 13 }] })
	assert.deepEqual(e.findings(), [])
	e.apply({ kind: "move", board: "climate", xMm: 48, yMm: 40 })
	assert.ok(e.findings().some((x) => x.level === "warn" && x.message === "moves JL1 on climate from top to bottom edge: a board change"), "climate's top now faces away from main")
	assert.deepEqual(e.state().assembly.cables![0].points.at(-1), { xMm: 48, yMm: 27 }, "the end is on climate's bottom edge")
})
