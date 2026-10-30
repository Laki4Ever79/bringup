import { test } from "node:test"
import assert from "node:assert/strict"
import { detectEnvironment } from "../src/tools/env.ts"
import { run } from "../src/tools/exec.ts"
import { tempDir } from "./helpers.ts"

test("env reports missing repo-local tools", async () => {
	const env = await detectEnvironment(tempDir())
	assert.equal(env.tsci, null)
	assert.equal(env.python, null)
	assert.equal(env.pio, null)
})

test("run returns non-zero exit codes instead of throwing", async () => {
	const r = await run("sh", ["-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 5000 })
	assert.equal(r.code, 3)
	assert.equal(r.stdout.trim(), "out")
	assert.equal(r.stderr.trim(), "err")
})

test("run reports a timeout as code -1", async () => {
	const r = await run("sleep", ["5"], { timeoutMs: 100 })
	assert.equal(r.code, -1)
})

test("run reports a missing binary as code -1", async () => {
	const r = await run("definitely-not-a-binary-xyz", [], { timeoutMs: 1000 })
	assert.equal(r.code, -1)
	assert.match(r.stderr, /ENOENT|not found/)
})
