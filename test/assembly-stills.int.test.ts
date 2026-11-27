// The build package's robot pictures without the hosted page (py/stills.py, src/package/assembly-pictures.ts): the
// scripted rover's chassis built, then drawn per assembly step, exploded, from the top and the side.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildChassis } from "../src/tools/chassis.ts"
import { assemblyPictures, casePictures, cncSimPictures, drivePictures } from "../src/package/assembly-pictures.ts"
import { buildEnclosure } from "../src/tools/enclosure.ts"
import { ASSEMBLY_STEPS } from "../src/geometry/assembly-steps.js"
import { LOGGER_DESIGN, ROVER_BOARD } from "../src/inference/scripts.ts"
import { tempDir } from "./helpers.ts"

const root = process.cwd()
const python = [join(root, ".venv/bin/python")].find(existsSync)

test("a built rover gets its assembly pictures with no page and no browser", { skip: python ? false : "no .venv python with build123d" }, async () => {
	const work = tempDir(), out = tempDir()
	const s = { revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) } as never
	const ch = await buildChassis(python!, root, work, s, 1)
	assert.ok(ch.ok, JSON.stringify(ch))
	const r = await assemblyPictures(python!, root, work, out)
	assert.equal(r.note, null)
	assert.deepEqual(r.files, [...ASSEMBLY_STEPS.map((n, k) => `assembly/step-${k + 1}-${n}.png`), "assembly/exploded.png", "assembly/view-top.png", "assembly/view-side.png"])
	for (const f of r.files) {
		const png = readFileSync(join(out, f))
		assert.equal(png.subarray(1, 4).toString(), "PNG", f)
		assert.equal(png.readUInt32BE(16), 1200, f)
	}
})

test("a board in its built case gets pictures: the open case, the board in it, the lid on, exploded, top and side", { skip: python ? false : "no .venv python with build123d" }, async () => {
	const work = tempDir(), out = tempDir()
	const s = { revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(LOGGER_DESIGN)) } as never
	const e = await buildEnclosure(python!, root, work, s, 1)
	assert.ok(existsSync(join(work, "case.stl")), JSON.stringify(e))
	const r = await casePictures(python!, root, work, out)
	assert.equal(r.note, null)
	assert.deepEqual(r.files, ["step-1-case", "step-2-board", ...(existsSync(join(work, "lid.stl")) ? ["step-3-lid"] : []), "exploded", "view-top", "view-side"].map((f) => `assembly/${f}.png`))
	for (const f of r.files) assert.equal(readFileSync(join(out, f)).subarray(1, 4).toString(), "PNG", f)
	// No case built: says so instead of failing.
	assert.match((await casePictures(python!, root, tempDir(), out)).note ?? "", /no built case/)
})

test("stills.py's printed names are read the same from Windows' \\r\\n lines", async () => {
	const { pngLines } = await import("../src/package/assembly-pictures.ts")
	assert.deepEqual(pngLines("step-1-case.png\r\nexploded.png\r\n"), ["assembly/step-1-case.png", "assembly/exploded.png"])
	assert.deepEqual(pngLines("step-1-case.png\nexploded.png\n"), ["assembly/step-1-case.png", "assembly/exploded.png"])
})

test("a rover's simulated drive is drawn from its trajectory: the course from above, three frames, a GIF", { skip: python ? false : "no .venv python with build123d" }, async () => {
	const work = tempDir(), out = tempDir(), drive = join(tempDir(), "rev-1")
	const s = { revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) } as never
	const ch = await buildChassis(python!, root, work, s, 1)
	assert.ok(ch.ok, JSON.stringify(ch))
	// drive.py's rows: [t, x, y, yaw, left duty, right duty, rise mm]: ahead 1 m, then a quarter turn left.
	const rows = Array.from({ length: 30 }, (_, i) => (i < 20 ? [i * 0.2, i * 0.05, 0, 0, 0.6, 0.6, 0] : [i * 0.2, 0.95, 0, ((i - 19) / 10) * (Math.PI / 2), -0.5, 0.5, 0]))
	mkdirSync(drive, { recursive: true })
	writeFileSync(join(drive, "trajectory.json"), JSON.stringify(rows))
	const r = await drivePictures(python!, root, work, drive, out)
	assert.equal(r.note, null)
	assert.deepEqual(r.files, ["drive/drive-track.png", "drive/drive-1-start.png", "drive/drive-2-farthest.png", "drive/drive-3-end.png", "drive/drive.gif"])
	for (const f of r.files.slice(0, 4)) assert.equal(readFileSync(join(out, f)).subarray(1, 4).toString(), "PNG", f)
	assert.equal(readFileSync(join(out, "drive/drive.gif")).subarray(0, 6).toString(), "GIF89a")
	// No trajectory: a note, no pictures.
	assert.match((await drivePictures(python!, root, work, tempDir(), out)).note ?? "", /holds no trajectory/)
})

test("a CNC's toolpath is drawn from grblHAL's reported positions: from above on a mm grid with the bed, from the front left, a GIF; pictures.json names the revision", { skip: python ? false : "no .venv python" }, async () => {
	const sim = join(tempDir(), "rev-7"), out = tempDir()
	mkdirSync(sim, { recursive: true })
	const points = [[0, 0, 0], [0, 0, -1], [6, 0, -1], [6, 3, -1], [0, 3, -1], [0, 0, -1], [6, 3, -1], [6, 3, 0]]
	writeFileSync(join(sim, "toolpath.json"), JSON.stringify({ points, originMm: [2.7, 1, -0.5], finished: true, travelMm: { x: 18, y: 9, z: 2 }, workAreaMm: { x: 300, y: 200, z: 50 }, pulseCheck: [{ axis: "x", ok: true, detail: "7200 STEP pulses = 18.00 mm at 400/mm; grblHAL reported 18 mm" }] }))
	const r = await cncSimPictures(python!, root, sim, out)
	assert.equal(r.note, null)
	assert.deepEqual(r.files, ["cncsim/cnc-toolpath.png", "cncsim/cnc-toolpath-3d.png", "cncsim/cnc.gif"])
	assert.equal(readFileSync(join(out, "cncsim/cnc.gif")).subarray(0, 6).toString(), "GIF89a")
	const index = JSON.parse(readFileSync(join(out, "cncsim/pictures.json"), "utf8"))
	assert.equal(index.revision, 7)
	assert.deepEqual(index.files, ["cnc-toolpath.png", "cnc-toolpath-3d.png", "cnc.gif"])
	assert.match((await cncSimPictures(python!, root, tempDir(), out)).note ?? "", /holds no toolpath/)
})
