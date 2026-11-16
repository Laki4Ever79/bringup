// The assembly (src/system/assembly.ts): which boards it places, the plate, the footprint, off-plate and overlap checks.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import { assemblyErrors, assemblyFitError, derivedAssembly, BOARD_GAP_MM, defaultAssembly, DEFAULT_PLATE_MM, ESTIMATED_OUTLINE_MM, footprint, PLATE_MARGIN_MM, withOutlines, type AssemblyBoard, type SystemAssembly } from "../src/system/assembly.ts"
import { specErrors, type SystemSpec } from "../src/system/spec.ts"

const placed = (name: string, xMm = 0, yMm = 0, rotDeg: AssemblyBoard["rotDeg"] = 0): AssemblyBoard =>
	({ name, xMm, yMm, rotDeg, outline: { widthMm: 40, heightMm: 30 }, outlineSource: "estimate" })
const spec = (assembly?: SystemAssembly, names = ["main", "front"]): SystemSpec => ({
	name: "two",
	boards: names.map((n) => ({ name: n, brief: `${n}.md` })),
	links: [],
	...(assembly ? { assembly } : {}),
})

test("a board the spec doesn't have is named", () => {
	const s = spec({ body: "separate", boards: [placed("ghost")] }, ["main"])
	assert.deepEqual(assemblyErrors(s), ["assembly: board ghost is not in the system"])
})

test("a spec board missing from a chassis assembly is named", () => {
	const s = spec({ body: "chassis", plate: { lengthMm: 150, widthMm: 110 }, boards: [placed("main")] })
	assert.ok(assemblyErrors(s).includes("assembly: board front has no place on the chassis"))
})

test("a chassis needs a plate; separate devices don't", () => {
	assert.ok(assemblyErrors(spec({ body: "chassis", boards: [placed("main"), placed("front", 50)] })).includes("assembly: a chassis body needs a plate size"))
	assert.deepEqual(assemblyErrors(spec({ body: "separate", boards: [placed("main"), placed("front")] })), [])
})

test("a rotated board's footprint swaps", () => {
	assert.deepEqual(footprint(placed("main", 0, 0, 90)), { xMm: 30, yMm: 40 })
	assert.deepEqual(footprint(placed("main", 0, 0, 180)), { xMm: 40, yMm: 30 })
})

test("a board off the plate is named", () => {
	// Positions are board centres, origin at the plate centre: a 40 x 30 board at x 70 reaches 90, past the 75 half-length.
	const plate = { lengthMm: 150, widthMm: 110 }
	const off = spec({ body: "chassis", plate, boards: [placed("main", 70), placed("front", -40, 0)] })
	assert.ok(assemblyErrors(off).includes("assembly: board main sticks out of the 150 × 110 mm plate"))
	// Flush with the plate edge fits (55 + 20 = 75).
	assert.deepEqual(assemblyErrors(spec({ body: "chassis", plate, boards: [placed("main", 55), placed("front", -55)] })), [])
	// Turned, the 40 x 30 board is 40 tall, which no longer fits a 30 mm wide plate.
	const turned = spec({ body: "chassis", plate: { lengthMm: 150, widthMm: 30 }, boards: [placed("main", -50, 0, 90), placed("front", 30, 0)] })
	const errs = assemblyErrors(turned)
	assert.ok(errs.includes("assembly: board main sticks out of the 150 × 30 mm plate"))
	assert.ok(!errs.some((e) => e.includes("front sticks out")))
})

test("two boards overlapping are named", () => {
	const plate = { lengthMm: 150, widthMm: 110 }
	const s = spec({ body: "chassis", plate, boards: [placed("main", 0, 0), placed("front", 10, 0)] })
	assert.ok(assemblyErrors(s).includes("assembly: boards main and front overlap"))
	const touching = spec({ body: "chassis", plate, boards: [placed("main", -20, 0), placed("front", 20, 0)] })
	assert.deepEqual(assemblyErrors(touching), [])
})

test("no assembly, no errors", () => {
	assert.deepEqual(assemblyErrors(spec()), [])
	assert.deepEqual(specErrors(spec()), [])
	assert.deepEqual(specErrors(spec({ body: "separate", boards: [placed("ghost")] })), ["assembly: board ghost is not in the system"])
})

const sys = (names: string[], links: SystemSpec["links"] = []): SystemSpec => ({ name: "s", boards: names.map((n) => ({ name: n, brief: `${n}.md` })), links })
const link = (id: string, a: string, b: string): SystemSpec["links"][number] => ({ id, kind: "uart", a: { board: a }, b: { board: b }, cable: { lengthMm: 100 } })
const at = (a: SystemAssembly, n: string) => a.boards.find((b) => b.name === n)!

test("the main board sits at the centre", () => {
	const a = defaultAssembly(sys(["front", "main", "rear"]), "chassis")
	assert.deepEqual([at(a, "main").xMm, at(a, "main").yMm], [0, 0])
	// No main: the board with the most links; a tie goes to the first.
	const b = defaultAssembly(sys(["a", "b", "c"], [link("L1", "b", "c"), link("L2", "c", "a")]), "chassis")
	assert.equal(at(b, "c").xMm, 0)
	const t = defaultAssembly(sys(["a", "b"], [link("L1", "a", "b")]), "chassis")
	assert.equal(at(t, "a").xMm, 0)
})

test("other boards line up front and back with the gap kept", () => {
	const a = defaultAssembly(sys(["main", "b", "c", "d"]), "chassis")
	const w = ESTIMATED_OUTLINE_MM.widthMm
	assert.equal(at(a, "b").xMm, w + BOARD_GAP_MM)
	assert.equal(at(a, "c").xMm, -(w + BOARD_GAP_MM))
	assert.equal(at(a, "d").xMm, 2 * (w + BOARD_GAP_MM))
	assert.deepEqual(assemblyErrors({ ...sys(["main", "b", "c", "d"]), assembly: a }), [])
})

test("unknown outlines are estimates", () => {
	const a = defaultAssembly(sys(["main", "b"]), "chassis", { b: { widthMm: 55, heightMm: 20 } })
	assert.deepEqual(at(a, "main").outline, ESTIMATED_OUTLINE_MM)
	assert.equal(at(a, "main").outlineSource, "estimate")
	assert.equal(at(a, "b").outlineSource, "built")
	assert.deepEqual(at(a, "b").outline, { widthMm: 55, heightMm: 20 })
})

test("the plate covers the boards with a margin, never smaller than today's rover plate", () => {
	const big = { widthMm: 60, heightMm: 40 }
	const a = defaultAssembly(sys(["main", "b"]), "chassis", { main: big, b: big })
	const reach = 60 + BOARD_GAP_MM + 30
	assert.ok(a.plate!.lengthMm >= DEFAULT_PLATE_MM.lengthMm && a.plate!.widthMm >= DEFAULT_PLATE_MM.widthMm)
	assert.ok(a.plate!.lengthMm >= 2 * reach + 2 * PLATE_MARGIN_MM)
	assert.ok(a.plate!.widthMm >= 40 + 2 * PLATE_MARGIN_MM)
	const many = defaultAssembly(sys(["main", "b", "c", "d", "e"]), "chassis", { main: big, b: big, c: big, d: big, e: big })
	assert.ok(many.plate!.lengthMm > DEFAULT_PLATE_MM.lengthMm)
	assert.deepEqual(assemblyErrors({ ...sys(["main", "b", "c", "d", "e"]), assembly: many }), [])
})

test("separate devices get positions but no plate", () => {
	const a = defaultAssembly(sys(["main", "b"]), "separate")
	assert.equal(a.plate, undefined)
	assert.equal(a.boards.length, 2)
})

test("withOutlines replaces estimates and re-spaces boards that now overlap", () => {
	const s = sys(["main", "b", "c"])
	const a = defaultAssembly(s, "chassis")
	const big = { widthMm: 60, heightMm: 40 }
	const r = withOutlines(a, { main: big, b: big, c: big })
	assert.ok(r.boards.every((b) => b.outlineSource === "built"))
	assert.deepEqual(assemblyErrors({ ...s, assembly: r }), [])
	assert.ok(at(r, "b").xMm > at(a, "b").xMm && at(r, "c").xMm < at(a, "c").xMm)
	// A board that still fits stays put; the plate grows when needed.
	const same = withOutlines(a, { b: { widthMm: 30, heightMm: 20 } })
	assert.equal(at(same, "b").xMm, at(a, "b").xMm)
	const wide = withOutlines(defaultAssembly(sys(["main", "b"]), "chassis"), { main: { widthMm: 100, heightMm: 40 }, b: { widthMm: 100, heightMm: 40 } })
	assert.ok(wide.plate!.lengthMm > DEFAULT_PLATE_MM.lengthMm)
})

test("an old robot derives its assembly from its mechanics", () => {
	const sys: SystemSpec = { name: "rover", boards: [{ name: "main", brief: "b.md" }], links: [] } as unknown as SystemSpec
	const d = derivedAssembly(sys, ROVER_BOARD.mechanics, { main: { widthMm: 60, heightMm: 40 } })
	assert.equal(d.derived, true)
	assert.equal(d.body, "chassis")
	assert.deepEqual(d.plate, { lengthMm: 150, widthMm: 96 })
	assert.deepEqual(d.boards.map((b) => [b.name, b.xMm, b.yMm, b.rotDeg, b.outlineSource]), [["main", 0, 0, 0, "built"]])
	assert.deepEqual(d.boards[0].outline, { widthMm: 60, heightMm: 40 })
})

test("an old two-board design without a chassis derives separate devices with no positions", () => {
	const sys = { name: "pair", boards: [{ name: "logger", brief: "a.md" }, { name: "beacon", brief: "b.md" }], links: [] } as unknown as SystemSpec
	assert.deepEqual(derivedAssembly(sys), { body: "separate", boards: [], derived: true })
})

// The brief's size limit (motion.maxSizeMm): boards wrap into rows along y before the plate passes it.
const three = (): SystemSpec => spec(undefined, ["main", "climate", "extra"])
const inside = (a: SystemAssembly) => a.boards.every((b) => { const f = footprint(b); return Math.abs(b.xMm) + f.xMm / 2 + PLATE_MARGIN_MM <= a.plate!.lengthMm / 2 && Math.abs(b.yMm) + f.yMm / 2 + PLATE_MARGIN_MM <= a.plate!.widthMm / 2 })

test("the default plate wraps boards into a second row before passing the brief's size limit", () => {
	const wide = { widthMm: 60, heightMm: 30 }
	const limit: [number, number] = [160, 150]
	const free = defaultAssembly(three(), "chassis", { main: wide, climate: wide, extra: wide })
	assert.ok(free.plate!.lengthMm > 160, "without a limit the row grows past it")
	const a = defaultAssembly(three(), "chassis", { main: wide, climate: wide, extra: wide }, limit)
	assert.ok(a.plate!.lengthMm <= 160 && a.plate!.widthMm <= 150, JSON.stringify(a.plate))
	assert.ok(a.boards.some((b) => b.yMm !== 0), "one board is in a second row")
	assert.ok(inside(a))
	assert.deepEqual(assemblyErrors({ ...three(), assembly: a }), [])
	assert.equal(assemblyFitError(a, limit), null)
})

test("a new row clears a centre-row board taller than main", () => {
	const limit: [number, number] = [160, 150]
	const s = spec(undefined, ["main", "a", "b", "c"])
	const a = defaultAssembly(s, "chassis", { main: { widthMm: 40, heightMm: 30 }, a: { widthMm: 40, heightMm: 70 }, b: { widthMm: 60, heightMm: 30 }, c: { widthMm: 60, heightMm: 30 } }, limit)
	assert.deepEqual(assemblyErrors({ ...s, assembly: a }), [])
})

test("grown outlines wrap into a second row instead of passing the limit", () => {
	const limit: [number, number] = [160, 150]
	const start = defaultAssembly(spec(undefined, ["main", "climate"]), "chassis", {}, limit)
	const a = withOutlines(start, { main: { widthMm: 43, heightMm: 30 }, climate: { widthMm: 90, heightMm: 30 } }, limit)
	assert.ok(a.plate!.lengthMm <= 160 && a.plate!.widthMm <= 150, JSON.stringify(a.plate))
	assert.ok(inside(a))
	assert.deepEqual(assemblyErrors({ ...spec(undefined, ["main", "climate"]), assembly: a }), [])
	// Without the limit it is lengthened, as before.
	assert.ok(withOutlines(start, { main: { widthMm: 43, heightMm: 30 }, climate: { widthMm: 90, heightMm: 30 } }).plate!.lengthMm > 160)
})

test("boards that can't fit within the limit at all are named, not silently exceeded", () => {
	const limit: [number, number] = [160, 150]
	const huge = { widthMm: 200, heightMm: 30 }
	const a = defaultAssembly(spec(undefined, ["main", "climate"]), "chassis", { main: { widthMm: 43, heightMm: 30 }, climate: huge }, limit)
	const err = assemblyFitError(a, limit)
	assert.match(err ?? "", /need a \d+ × \d+ mm plate, over the 160 × 150 mm plate the brief's size allows/)
	assert.equal(assemblyFitError(a), null, "no limit, no finding")
})
// The scripted rover + climate (16 Nov): the spec's two 40 mm estimates need 88 of the 130 mm the 150 mm limit leaves,
// but 68 mm on main's side of the centre. The row moves along x as a whole instead of starting a second row (which
// made the plate 126 mm wide against the brief's 96 and left main unable to settle).
test("a row that fits the limit's length but not around main is centred, not split into a second row", async () => {
	const { withOutlines } = await import("../src/system/assembly.ts")
	const a = { body: "chassis" as const, plate: { lengthMm: 150, widthMm: 96 }, boards: [
		{ name: "main", xMm: 0, yMm: 0, rotDeg: 0 as const, outline: { widthMm: 40, heightMm: 30 }, outlineSource: "estimate" as const },
		{ name: "climate", xMm: 48, yMm: 0, rotDeg: 0 as const, outline: { widthMm: 40, heightMm: 30 }, outlineSource: "estimate" as const },
	] }
	const r = withOutlines(a, {}, [150, 96])
	assert.deepEqual(r.plate, { lengthMm: 150, widthMm: 96 })
	assert.deepEqual(r.boards.map((b) => [b.name, b.xMm, b.yMm]), [["main", -24, 0], ["climate", 24, 0]])
	// A row too long even centred still starts a second row.
	const long = withOutlines({ ...a, boards: a.boards.map((b) => ({ ...b, outline: { widthMm: 70, heightMm: 30 } })) }, {}, [150, 96])
	assert.ok(long.boards.some((b) => b.yMm !== 0))
})
