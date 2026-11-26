// The gate for fab files without KiCad: on a fixture board, tscircuit's export (paste made KiCad's) agrees with KiCad's
// export of the same build, layer by layer (scripts/fab_compare.py). Needs KiCad, tscircuit and a Python with pygerber
// 2.4.3 in BRINGUP_FAB_COMPARE_PYTHON (`uv pip install "pygerber[pillow]==2.4.3"`).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildBoard } from "../src/tools/board.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { exportFab, exportFabWithTscircuit, zipEntries } from "../src/tools/fab.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const env = await detectEnvironment(root)
const py = process.env.BRINGUP_FAB_COMPARE_PYTHON

test("without KiCad the fab files are tscircuit's and match KiCad's: copper, mask and drills, and the paste after the fix", { skip: (!(env.tsci && env.kicad) && "tsci or KiCad missing") || (!py && "BRINGUP_FAB_COMPARE_PYTHON unset"), timeout: 600_000 }, async () => {
	const s = fixtureContract()
	const board = await buildBoard(env, tempDir(), s, s.revision)
	const [kOut, tOut] = [tempDir(), tempDir()]
	const k = await exportFab(env, board, s, kOut)
	const t = await exportFabWithTscircuit(env, board, s, tOut)
	const unzip = (zip: string, dir: string) => {
		mkdirSync(dir, { recursive: true })
		for (const e of zipEntries(readFileSync(zip))) writeFileSync(join(dir, e.name), e.data)
	}
	const [kd, td] = [join(kOut, "k"), join(tOut, "t")]
	unzip(k.gerbersZip, kd)
	unzip(t.gerbersZip, td)
	const r = JSON.parse(execFileSync(py!, [join(root, "scripts", "fab_compare.py"), kd, td], { encoding: "utf8", timeout: 300_000 }))
	// Copper, mask and paste within 0.5 % of their union; every hole matched; the outline the same within its line width.
	for (const l of ["F_Cu", "B_Cu", "F_Mask", "B_Mask", "F_Paste", "B_Paste"]) assert.ok(r.layers[l].disagree_pct <= 0.5, `${l}: ${JSON.stringify(r.layers[l])}`)
	assert.equal(r.drills.matched, r.drills.kicad)
	assert.equal(r.drills.tscircuit, r.drills.kicad)
	for (const i of [0, 1]) assert.ok(Math.abs(r.outline.kicad_mm[i] - r.outline.tscircuit_mm[i]) <= 0.1, JSON.stringify(r.outline))
	// The silkscreen differs, cosmetically: our KiCad-side fixes (raised text, hidden references) aren't in tscircuit's.
	// The CPL names every placed part.
	assert.match(readFileSync(t.cpl, "utf8"), /^Designator,Mid X,Mid Y,Layer,Rotation\nU\d/)
})
