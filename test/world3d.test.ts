// The shared 3D scene's pure helpers (src/dashboard/world3d.js): where boards sit, how the camera flies, how much
// detail each board gets.
import { test } from "node:test"
import assert from "node:assert/strict"
import { autoLayout, detailFor, flyCamera, pickBoard } from "../src/dashboard/world3d.js"

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
import { boardGeometry } from "../src/dashboard/world3d.js"
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
