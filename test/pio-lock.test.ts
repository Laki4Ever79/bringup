// One PlatformIO build at a time in a run (src/run.ts pioLock): two at once failed FluidNC's library install (the CNC's
// FluidNC mock, 28 Nov 2026). The lock serializes, and every builder in the run takes the lock its tools call for.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { BuildLock } from "../src/agents/builders.ts"
import { BUILDER_TOOLS } from "../src/tools/stubs.ts"

test("the lock runs builds one after the other", async () => {
	const lock = new BuildLock()
	const log: string[] = []
	const job = (n: string) => () => new Promise<void>((r) => { log.push(`${n} start`); setTimeout(() => { log.push(`${n} end`); r() }, 20) })
	await Promise.all([lock.run(job("a")), lock.run(job("b"))])
	assert.deepEqual(log, ["a start", "a end", "b start", "b end"])
})

test("every builder the run makes takes lockFor(its kind), and the pio ones share it", () => {
	const run = readFileSync(resolve(import.meta.dirname, "../src/run.ts"), "utf8")
	const line = run.split("\n").find((l) => l.includes("const real = {"))!
	const made = [...line.matchAll(/(\w+): \(\) => create\w+Builder\(env(, lockFor\("(\w+)"\))?\)/g)]
	assert.ok(made.length >= 10)
	for (const m of made) assert.equal(m[3], m[1], `${m[1]} takes lockFor("${m[1]}")`)
	const pio = Object.entries(BUILDER_TOOLS).filter(([, t]) => t.includes("pio")).map(([k]) => k).sort()
	assert.deepEqual(pio, ["armsim", "cncsim", "drive", "firmware", "machinefw"])
})
