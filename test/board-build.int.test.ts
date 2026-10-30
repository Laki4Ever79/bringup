import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildBoard } from "../src/tools/board.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const env = await detectEnvironment(fileURLToPath(new URL("..", import.meta.url)))

test("buildBoard produces a routed, exported board that matches the contract", { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 300_000 }, async () => {
	const s = fixtureContract()
	const board = await buildBoard(env, tempDir(), s, s.revision)
	assert.equal(board.revision, s.revision)
	assert.ok(existsSync(board.pcbPath))
	assert.ok(board.stepPath && existsSync(board.stepPath), "STEP export missing")
	assert.ok(board.renderPath && existsSync(board.renderPath), "render missing")
	assert.deepEqual(checkConsistency(s, { board }), [])
	// The four M2 mounting holes are drilled, and they survive the KiCad export (the fab package's drill file).
	assert.deepEqual(board.holes, [[3, 3], [47, 3], [3, 27], [47, 27]].map(([xMm, yMm]) => ({ xMm, yMm, diameterMm: 2.2 })))
	assert.equal(readFileSync(board.pcbPath, "utf8").match(/np_thru_hole[^)]*\)[^)]*\)\s*\(drill 2\.2\)/g)?.length, 4, "the KiCad board lacks the mounting holes")
	assert.ok(board.drc, "DRC did not run")
	assert.equal(board.drc!.unconnected, 0)
	assert.equal(board.drc!.byType.via_diameter ?? 0, 0, "vias are below the fab minimum")
	assert.equal(board.drc!.byType.track_width ?? 0, 0, "tracks are below the fab minimum")
})

test("buildBoard fails with tscircuit's message when the board can't be built", { skip: !env.tsci && "tsci missing", timeout: 300_000 }, async () => {
	const s = fixtureContract()
	s.values.outline = { widthMm: 4, heightMm: 4, thicknessMm: 1.6 }
	await assert.rejects(buildBoard(env, tempDir(), s, s.revision), /tscircuit build failed/)
})

test("buildBoard works when the output folder is inside the repo", { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 300_000 }, async () => {
	const { mkdirSync, rmSync } = await import("node:fs")
	const dir = fileURLToPath(new URL(`../out/.test-board-${process.pid}`, import.meta.url))
	mkdirSync(dir, { recursive: true })
	try {
		const s = fixtureContract()
		const board = await buildBoard(env, dir, s, s.revision)
		assert.ok(board.pcbPath.startsWith(dir), board.pcbPath)
		assert.deepEqual(checkConsistency(s, { board }), [])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("the logger board routes at every width from 45 to 70 mm", { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 900_000 }, async () => {
	const { LOGGER_DESIGN } = await import("../src/inference/scripts.ts")
	const failures: string[] = []
	await Promise.all(
		[45, 50, 55, 60, 65, 70].map(async (width) => {
			const s = fixtureContract()
			s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN), outline: { ...LOGGER_DESIGN.outline, widthMm: width } }
			try {
				const board = await buildBoard(env, tempDir(), s, s.revision)
				const v = checkConsistency(s, { board })
				if (v.length) failures.push(`${width} mm: ${v.map((x) => x.kind).join(", ")}`)
			} catch (error) {
				failures.push(`${width} mm: ${String(error).split("\n").slice(0, 3).join(" | ")}`)
			}
		}),
	)
	assert.deepEqual(failures, [])
})

test("build errors lead with the real cause, not tscircuit's advisory warnings", async () => {
	const { buildErrors } = await import("../src/tools/board.ts")
	const out = "All pins on U1 are underspecified (no pinAttributes set)\nU2 has no pin with requires_power=true\nVia hole at (-21.24mm, 2.40mm) overlaps SMD pad J1.pin6\nBuild exiting with code 1: circuit build errors occurred"
	assert.equal(buildErrors(out), "Via hole at (-21.24mm, 2.40mm) overlaps SMD pad J1.pin6\nBuild exiting with code 1: circuit build errors occurred")
})
