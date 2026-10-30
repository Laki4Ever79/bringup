import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { buildBoard } from "../src/tools/board.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { exportFab, zipEntries } from "../src/tools/fab.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const env = await detectEnvironment(fileURLToPath(new URL("..", import.meta.url)))

test("the fixture board exports a JLC fab package", { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 600_000 }, async () => {
	const s = fixtureContract()
	const dir = tempDir()
	const board = await buildBoard(env, dir, s, s.revision)
	const fab = await exportFab(env, board, s, dir)
	assert.equal(fab.dir, join(dir, "fab"))
	for (const f of [fab.gerbersZip, fab.bom, fab.cpl, fab.readme]) assert.ok(existsSync(f), `${f} missing`)

	const names = zipEntries(readFileSync(fab.gerbersZip)).map((e) => e.name)
	assert.ok(names.some((n) => /Edge_Cuts/.test(n)), `no Edge.Cuts gerber in ${names}`)
	assert.ok(names.some((n) => /\.drl$/.test(n)), `no Excellon drill file in ${names}`)
	for (const layer of ["F_Cu", "B_Cu", "F_Mask", "B_Mask", "F_Silkscreen", "F_Paste"]) assert.ok(names.some((n) => n.includes(layer)), `no ${layer} in ${names}`)

	const bom = readFileSync(fab.bom, "utf8")
	assert.match(bom, /^Comment,Designator,Footprint,LCSC Part #/)
	assert.match(bom, /"U1","esp32_c3_mini_1","C2838502"/)
	const cpl = readFileSync(fab.cpl, "utf8")
	assert.match(cpl, /^Designator,Mid X,Mid Y,Layer,Rotation/)
	for (const ref of ["U1", "U2", "D1", "J1"]) assert.match(cpl, new RegExp(`^${ref},`, "m"), `${ref} missing from cpl.csv`)
	assert.match(readFileSync(fab.readme, "utf8"), /CHECKLIST/)
})
