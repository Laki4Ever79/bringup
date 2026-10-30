import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { buildBoard } from "../src/tools/board.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const env = await detectEnvironment(new URL("..", import.meta.url).pathname)

test("buildBoard produces a routed, exported board that matches the contract", { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 300_000 }, async () => {
	const s = fixtureContract()
	const board = await buildBoard(env, tempDir(), s, s.revision)
	assert.equal(board.revision, s.revision)
	assert.ok(existsSync(board.pcbPath))
	assert.ok(board.stepPath && existsSync(board.stepPath), "STEP export missing")
	assert.ok(board.renderPath && existsSync(board.renderPath), "render missing")
	assert.deepEqual(checkConsistency(s, { board }), [])
})

test("buildBoard fails with tscircuit's message when the board can't be built", { skip: !env.tsci && "tsci missing", timeout: 300_000 }, async () => {
	const s = fixtureContract()
	s.values.outline = { widthMm: 4, heightMm: 4, thicknessMm: 1.6 }
	await assert.rejects(buildBoard(env, tempDir(), s, s.revision), /tscircuit build failed/)
})

test("buildBoard works when the output folder is inside the repo", { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 300_000 }, async () => {
	const { mkdirSync, rmSync } = await import("node:fs")
	const dir = new URL(`../out/.test-board-${process.pid}`, import.meta.url).pathname
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
