// A board built without KiCad (an npx install: no Docker image) still gets its pictures, from tscircuit itself.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildBoard } from "../src/tools/board.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const env = await detectEnvironment(fileURLToPath(new URL("..", import.meta.url)))

test("without KiCad the board's pictures come from tscircuit: a 3D board.png, the PCB and the schematic as SVG", { skip: !env.tsci && "tsci missing", timeout: 400_000 }, async () => {
	const s = fixtureContract()
	const board = await buildBoard({ ...env, kicad: null }, tempDir(), s, s.revision)
	assert.ok(existsSync(board.pcbPath))
	assert.equal(board.stepPath, null) // KiCad's STEP export needs KiCad
	assert.ok(board.renderPath && existsSync(board.renderPath), "board.png missing")
	assert.deepEqual([...readFileSync(board.renderPath!).subarray(1, 4)].map((c) => String.fromCharCode(c)).join(""), "PNG")
	for (const f of ["board-pcb.svg", "board-schematic.svg"]) assert.match(readFileSync(join(board.dir, f), "utf8"), /^<svg/, f)
	assert.ok(!existsSync(join(board.dir, "__snapshots__")), "the snapshot folder is tidied away")
})
