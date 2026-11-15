// The shared 3D scene's pure helpers (src/dashboard/world3d.js): where boards sit, how the camera flies, how much
// detail each board gets.
import { test } from "node:test"
import assert from "node:assert/strict"
import { assemblyPlacement, autoLayout, resolvePlaces, detailFor, flyCamera, pickBoard } from "../src/dashboard/world3d.js"

const board = (name: string, w = 50, h = 30) => ({ name, outline: { widthMm: w, heightMm: h } })
const link = (a: string, b: string) => ({ id: `${a}${b}`, a: { board: a }, b: { board: b } })

function overlaps(pos: Record<string, { x: number; y: number }>, boards: ReturnType<typeof board>[], gap: number) {
	for (const a of boards)
		for (const b of boards) {
			if (a === b) continue
			const pa = pos[a.name], pb = pos[b.name]
			const dx = Math.abs(pa.x - pb.x) - (a.outline.widthMm + b.outline.widthMm) / 2
			const dy = Math.abs(pa.y - pb.y) - (a.outline.heightMm + b.outline.heightMm) / 2
			if (dx < gap - 1e-9 && dy < gap - 1e-9) return `${a.name} and ${b.name}`
		}
	return null
}

test("boards never overlap, with the gap kept, for 2, 3 and 6 boards", () => {
	for (const n of [2, 3, 6]) {
		const boards = Array.from({ length: n }, (_, i) => board(`b${i}`, 30 + i * 7, 20 + i * 3))
		const pos = autoLayout(boards, [], 20)
		assert.deepEqual(Object.keys(pos).sort(), boards.map((b) => b.name).sort())
		assert.equal(overlaps(pos, boards, 20), null, `${n} boards`)
	}
})

test("linked boards sit closer than unlinked ones", () => {
	const boards = [board("a"), board("d"), board("b"), board("c")]
	const pos = autoLayout(boards, [link("a", "b"), link("b", "c")], 20)
	const dist = (p: string, q: string) => Math.hypot(pos[p].x - pos[q].x, pos[p].y - pos[q].y)
	assert.ok(dist("a", "b") < dist("a", "d"))
})

test("a link to a board that was not passed in is ignored, not a crash (a placed sibling of a robot)", () => {
	const pos = autoLayout([board("main")], [link("main", "climate")], 20)
	assert.deepEqual(Object.keys(pos), ["main"])
	const two = autoLayout([board("main"), board("x")], [link("main", "climate"), link("climate", "x")], 20)
	assert.deepEqual(Object.keys(two).sort(), ["main", "x"])
})

test("the camera fly starts at the first view, ends at the second and passes between, easing in and out", () => {
	const a = { yaw: 0, pitch: 0.5, distance: 200, target: [0, 0, 0] }
	const b = { yaw: 1, pitch: 0.9, distance: 80, target: [40, 10, 0] }
	assert.deepEqual(flyCamera(a, b, 0), a)
	assert.deepEqual(flyCamera(a, b, 1), b)
	const mid = flyCamera(a, b, 0.5)
	assert.ok(mid.distance < 200 && mid.distance > 80)
	assert.ok(Math.abs(mid.target[0] - 20) < 1e-9, "symmetric easing is halfway at t = 0.5")
	assert.ok(flyCamera(a, b, 0.1).distance > 200 - 0.1 * 120, "eases in: slower than linear at the start")
})

test("the yaw takes the short way round", () => {
	const mid = flyCamera({ yaw: 3.0, pitch: 0, distance: 1, target: [0, 0, 0] }, { yaw: -3.0, pitch: 0, distance: 1, target: [0, 0, 0] }, 0.5)
	assert.ok(Math.abs(Math.abs(mid.yaw) - Math.PI) < 0.01)
})

test("small systems show every board in full; large ones only the focused board", () => {
	assert.equal(detailFor("a", null, 2), "full")
	assert.equal(detailFor("a", "b", 4), "full")
	assert.equal(detailFor("a", null, 6), "box")
	assert.equal(detailFor("a", "a", 6), "full")
})

test("a ray picks the nearest board it passes through", () => {
	const boxes = [
		{ name: "far", min: [-10, -10, 0], max: [10, 10, 2] },
		{ name: "near", min: [-10, -10, 20], max: [10, 10, 22] },
	]
	assert.equal(pickBoard([0, 0, 100], [0, 0, -1], boxes), "near")
	assert.equal(pickBoard([50, 50, 100], [0, 0, -1], boxes), null)
})

// The rover on the start screen and in its run (user, 11 Nov: "why don't we show the rover as a sample"): its board on
// standoffs over the chassis plate, the drive wheels, motors, caster, battery and distance sensor, from the chassis
// spec, standing on the floor (z 0).
import { readFileSync } from "node:fs"
import { boardGeometry, rotateZ } from "../src/dashboard/world3d.js"
function boxStl(min: number[], max: number[]): ArrayBuffer {
	const v = (x: number, y: number, z: number) => [x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]]
	const faces = [[[0,0,0],[1,0,0],[1,1,0]],[[0,0,0],[1,1,0],[0,1,0]],[[0,0,1],[1,1,1],[1,0,1]],[[0,0,1],[0,1,1],[1,1,1]]]
	const buf = Buffer.alloc(84 + faces.length * 50)
	buf.write("binary box", 0)
	buf.writeUInt32LE(faces.length, 80)
	faces.forEach((f, i) => f.forEach((p, k) => v(p[0], p[1], p[2]).forEach((c, j) => buf.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + j * 4))))
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
}
const CHASSIS = { plate: { lengthMm: 150, widthMm: 90, thicknessMm: 3, clearanceMm: 50.5 }, standoffMm: 10, motors: [{ side: "left", xMm: 30, yMm: 37, bodyMm: [26, 12, 10], axleDropMm: 10.5 }, { side: "right", xMm: 30, yMm: -37, bodyMm: [26, 12, 10], axleDropMm: 10.5 }], caster: { xMm: -50, wheelMm: 38, heightMm: 50.5 }, battery: { xMm: 25, yMm: 0, sizeMm: [60, 36, 7] }, boards: [{ name: "main", xMm: 10, yMm: 0, widthMm: 50, heightMm: 30, rotDeg: 0 }], sensor: { xMm: 72, yMm: 0, zMm: 65, sizeMm: [21, 18, 2.8] }, drive: { trackMm: 110, axleXMm: 30, wheelbaseMm: 80, wheelDiameterMm: 80, wheelWidthMm: 10 } }

test("a rover stands on the floor with its wheels, caster, chassis and board where the chassis spec puts them", () => {
	const circuit = JSON.parse(readFileSync("examples/logger/boards/main/circuit.json", "utf8"))
	const g = boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, circuit, chassisStl: boxStl([-75, -45, 0], [75, 45, 3]), chassisSpec: CHASSIS })
	assert.ok(Math.abs(g.extent.min[2]) < 0.5, `stands on the floor: lowest point at ${g.extent.min[2]} mm`)
	assert.ok(g.extent.max[2] >= 65 + 9 - 0.5, `the sensor's top (65 + 9 mm) is in: highest point ${g.extent.max[2]} mm`)
	// Centred on its own origin, like every board in the world. Across: the wheels outside the plate at the track,
	// 110 + 10 = 120 mm. Front to back: the 150 mm plate (the wheels, -10..70, and the sensor, to 73.4, sit within it).
	const [w, l] = [g.extent.max[1] - g.extent.min[1], g.extent.max[0] - g.extent.min[0]]
	assert.ok(Math.abs(w - 120) < 0.5, `${w} mm across`)
	assert.ok(Math.abs(l - 150) < 0.5, `${l} mm long`)
	assert.ok(Math.abs(g.extent.max[1] + g.extent.min[1]) < 0.5, "centred across")
	assert.ok(g.solid && g.solid.length > 0)
})

test("assemblyPlacement puts a second board beside the main one on the standoffs, in the frame boardGeometry applied", () => {
	const circuit = JSON.parse(readFileSync("examples/logger/boards/main/circuit.json", "utf8"))
	const g = boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, circuit, chassisStl: boxStl([-75, -45, 0], [75, 45, 3]), chassisSpec: CHASSIS })
	assert.ok(g.robotFrame, "a robot board reports the frame it applied")
	assert.equal(boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, circuit }).robotFrame, undefined, "a plain board has none")
	const assembly = { boards: [{ name: "drive", xMm: 10, yMm: 0 }, { name: "front", xMm: 55, yMm: 0 }] }
	const p = assemblyPlacement(assembly, g.robotFrame!)
	assert.deepEqual(Object.keys(p).sort(), ["drive", "front"], "keyed by system names")
	assert.ok(Math.abs(p.front.x - p.drive.x - 45) < 1e-9)
	assert.equal(p.front.z, p.drive.z)
	assert.ok(p.front.z > 50.5 + 3, "above the plate's top")
	// The robot is drawn recentred by the frame's shift; a point at the chassis centre lands at that shift. The plate
	// (-75..75) is the widest thing along x, so the shift there is 0 and a board at x 10 is 10 from the drawn centre.
	assert.ok(Math.abs(p.drive.x - (10 + g.robotFrame!.shift[0])) < 1e-9)
	assert.ok(Math.abs(g.robotFrame!.shift[0]) < 0.5 && Math.abs(p.drive.x - 10) < 0.5)
})

test("resolvePlaces: placed boards stand on the robot's place with their z; the rest keep the automatic layout", () => {
	const boards = [{ name: "robot" }, { name: "front" }, { name: "other" }]
	const auto = { robot: { x: 7, y: -3 }, front: { x: 99, y: 99 }, other: { x: -40, y: 12 } }
	const on = { robot: "robot", places: { robot: { x: 10, y: 0, z: 63.5 }, front: { x: 55, y: 4, z: 63.5 } } }
	const r = resolvePlaces(boards, auto, on)
	assert.deepEqual(r.front, { x: 62, y: 1, z: 63.5 })
	assert.deepEqual(r.robot, { x: 7, y: -3, z: 0 }, "the robot stays where the layout put it")
	assert.deepEqual(r.other, { x: -40, y: 12, z: 0 }, "an unplaced board keeps its automatic place exactly")
	// No assembly: identical to the automatic layout, and an explicit `at` still wins.
	const plain = resolvePlaces([...boards.slice(0, 2), { name: "other", at: { x: 1, y: 2 } }], auto)
	assert.deepEqual(plain, { robot: { x: 7, y: -3, z: 0 }, front: { x: 99, y: 99, z: 0 }, other: { x: 1, y: 2, z: 0 } })
})

// Task 6 (system view phase 3): the 3D view honours a board's rotDeg, counter-clockwise from above like Top.
test("a board turned 90 degrees swaps its extent in 3D, and 0 leaves it alone", () => {
	const circuit = JSON.parse(readFileSync("examples/logger/boards/main/circuit.json", "utf8"))
	const w = (g: ReturnType<typeof boardGeometry>, k: number) => g.extent.max[k] - g.extent.min[k]
	const flat = boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, circuit })
	const turned = boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, circuit, rotDeg: 90 })
	assert.ok(Math.abs(w(turned, 0) - w(flat, 1)) < 1e-3 && Math.abs(w(turned, 1) - w(flat, 0)) < 1e-3, "x and y extents swap")
	assert.ok(w(flat, 0) > w(flat, 1))
	assert.deepEqual(boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, circuit, rotDeg: 0 }).extent, flat.extent)
	// The picking box stand-in turns with it: 30 wide in x, 50 in y.
	const box = boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, rotDeg: 90 })
	assert.ok(Math.abs(box.extent.max[0] - box.extent.min[0] - 30) < 1e-3 && Math.abs(box.extent.max[1] - box.extent.min[1] - 50) < 1e-3)
})

test("direction: 90 degrees is counter-clockwise from above, so local (+10, 0) lands at (0, +10)", () => {
	const r = rotateZ(new Float32Array([10, 0, 0, 0, 10, 0, -10, 0, 0]), 90)
	assert.ok(Math.abs(r[0]) < 1e-5 && Math.abs(r[1] - 10) < 1e-5, `(+10,0) -> (${r[0]}, ${r[1]})`)
	assert.ok(Math.abs(r[3] + 10) < 1e-5 && Math.abs(r[4]) < 1e-5, `(0,+10) -> (${r[3]}, ${r[4]})`)
	// And through boardGeometry: a case that sits only at +x ends up only at +y when the board is turned.
	const g = boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, rotDeg: 90 })
	assert.ok(g.extent.max[0] - g.extent.min[0] < g.extent.max[1] - g.extent.min[1], "long side along y")
	const p = assemblyPlacement({ boards: [{ name: "front", xMm: 55, yMm: 0, rotDeg: 90 }] }, { shift: [0, 0], boardZ: 60 })
	assert.equal(p.front.rotDeg, 90)
})

test("the main board on a chassis turns by the chassis spec's rotDeg, and its extent follows", () => {
	const circuit = JSON.parse(readFileSync("examples/logger/boards/main/circuit.json", "utf8"))
	const mk = (rotDeg: number) => boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, circuit, chassisStl: boxStl([-75, -45, 0], [75, 45, 3]), chassisSpec: { ...CHASSIS, boards: [{ ...CHASSIS.boards[0], rotDeg }] } })
	const a = mk(0), b = mk(90)
	assert.ok(a.solid && b.solid && a.solid.length === b.solid.length)
	let diff = 0
	for (let i = 0; i < a.solid!.length; i++) diff = Math.max(diff, Math.abs(a.solid![i] - b.solid![i]))
	assert.ok(diff > 5, "the board's triangles moved")
	assert.ok(Math.abs(b.robotFrame!.boardZ - a.robotFrame!.boardZ) < 1e-9)
})

test("a board on a chassis draws no case shell; in its own body the case still draws", () => {
	const circuit = JSON.parse(readFileSync("examples/logger/boards/main/circuit.json", "utf8"))
	const caseStl = boxStl([-30, -20, 0], [30, 20, 20])
	const own = boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, circuit, caseStl })
	assert.ok(own.shell && own.shell.length > 0, "own case drawn")
	const onChassis = boardGeometry({ outline: { widthMm: 50, heightMm: 30 }, circuit, caseStl, onChassis: true })
	assert.equal(onChassis.shell, null)
	assert.ok(onChassis.solid && onChassis.solid.length > 0)
})
