// The build package's robot pictures without the hosted page (py/stills.py, src/package/assembly-pictures.ts): the
// scripted rover's chassis built, then drawn per assembly step, exploded, from the top and the side.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildChassis } from "../src/tools/chassis.ts"
import { assemblyPictures, casePictures } from "../src/package/assembly-pictures.ts"
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
