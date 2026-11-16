// Temp folders a killed process left (src/tmp.ts): swept when older than STALE_HOURS, kept when recent, kept with
// BRINGUP_KEEP_TMP=1. And the test helper's own folders are removed when a test file ends cleanly.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { sweepStaleTemp } from "../src/tmp.ts"

test("stale bringup-* folders are swept, recent ones and others' are left", () => {
	const root = mkdtempSync(join(tmpdir(), "sweep-root-"))
	const old = join(root, "bringup-board-old"), recent = join(root, "bringup-board-new"), other = join(root, "someone-else")
	for (const d of [old, recent, other]) { mkdirSync(d); writeFileSync(join(d, "f"), "x") }
	const day = (Date.now() - 24 * 3_600_000) / 1000
	utimesSync(old, day, day)
	utimesSync(other, day, day)
	assert.deepEqual(sweepStaleTemp({ root, env: { BRINGUP_KEEP_TMP: "1" } }), [])
	assert.deepEqual(sweepStaleTemp({ root, env: {} }), [old])
	assert.equal(existsSync(old), false)
	assert.equal(existsSync(recent), true)
	assert.equal(existsSync(other), true)
})

test("a test file's tempDir folders are gone after it ends cleanly, kept after it fails", () => {
	const script = (fail: boolean) => `import { tempDir } from ${JSON.stringify(new URL("./helpers.ts", import.meta.url).pathname)}\nconst d = tempDir()\nconsole.log(d)\n${fail ? "process.exitCode = 1" : ""}\n`
	for (const fail of [false, true]) {
		const r = spawnSync("npx", ["tsx", "-e", script(fail)], { encoding: "utf8", env: { ...process.env, BRINGUP_KEEP_TMP: "" } })
		const dir = r.stdout.trim().split("\n").at(-1)!
		assert.ok(dir.includes("bringup-"), r.stderr)
		assert.equal(existsSync(dir), fail, fail ? "a failing file keeps its folder" : "a clean file removes its folder")
	}
})
