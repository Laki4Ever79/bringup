// A plain product's build package has its case (src/package/build.ts packageCase): case and lid as STL and STEP in
// printed/, pictures of the board in it, and assembly steps that print and close it. Before (27 Nov 2026) the package
// of a board-in-a-case design shipped no case at all.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { assemblyOrder, packageCase } from "../src/package/build.ts"
import { casePictures } from "../src/package/assembly-pictures.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { tempDir } from "./helpers.ts"

const root = process.cwd()
const python = [join(root, ".venv/bin/python")].find(existsSync)
const snap = (values: object) => ({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(values)) }) as never

test("a board-in-a-case package gets its case and lid (STL and STEP), their pictures and the steps to close it", { skip: python ? false : "no .venv python with build123d" }, async () => {
	const work = tempDir(), out = tempDir()
	const k = await packageCase(python!, root, join(work, "enclosure"), out, snap(LOGGER_DESIGN), 1)
	assert.deepEqual(k.missing, [])
	assert.deepEqual(readdirSync(join(out, "printed")).sort(), ["case.step", "case.stl", "lid.step", "lid.stl"])
	const pics = await casePictures(python!, root, k.dir!, out)
	assert.ok(pics.files.includes("assembly/exploded.png"), JSON.stringify(pics))
	const steps = assemblyOrder(snap(LOGGER_DESIGN), k.stls.map((f) => f.split(/[\\/]/).pop()!))
	assert.match(steps, /Print case\.stl and lid\.stl from printed\//)
	assert.match(steps, /standoffs/)
})

test("no case of ours (requirements.enclosure none), a robot or an arm: nothing is built here", async () => {
	const out = tempDir()
	const bare = await packageCase("python-not-needed", root, tempDir(), out, snap({ ...LOGGER_DESIGN, requirements: { ...LOGGER_DESIGN.requirements, enclosure: "none" } }), 1)
	assert.deepEqual(bare, { dir: null, stls: [], findings: [], missing: [] })
	assert.equal((await packageCase("python-not-needed", root, tempDir(), out, snap({ ...LOGGER_DESIGN, mechanics: {} }), 1)).dir, null)
	assert.ok(!existsSync(join(out, "printed")))
})
