import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, runDesign } from "../src/run.ts"
import { appendRequest } from "../src/runner/requests.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

// One runtime per process: let the previous run's loops wind down first.
afterEach(() => new Promise((r) => setTimeout(r, 300)))

const settles = (out: string) => (existsSync(join(out, "trace.jsonl")) ? readFileSync(join(out, "trace.jsonl"), "utf8").split("\n").filter((l) => l.includes('"design.settled"')).length : 0)
const until = async (cond: () => boolean, ms: number) => {
	const end = Date.now() + ms
	while (!cond()) {
		if (Date.now() > end) throw new Error("timed out")
		await new Promise((r) => setTimeout(r, 100))
	}
}

test("--stay: the run settles, takes a change request, re-settles, and only ends when stopped", { timeout: 90_000 }, async () => {
	const out = tempDir()
	const env = await detectEnvironment(ROOT)
	let stop: () => void = () => {}
	const stopped = new Promise<void>((r) => (stop = r))
	let done = false
	const run = runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, noHardware: true, outDir: out, env, timeoutMs: 80_000, stay: { until: stopped } }).then((r) => ((done = true), r))
	await until(() => settles(out) >= 1, 40_000)
	const started = readFileSync(join(out, "trace.jsonl"), "utf8").split("\n").find((l) => l.includes('"run.started"'))!
	assert.equal(JSON.parse(started).payload.stay, true)
	assert.ok(existsSync(join(out, "report.md")), "the report is written at each settle")
	await new Promise((r) => setTimeout(r, 2000))
	assert.equal(done, false, "settled, but still waiting for a change")
	appendRequest(out, "make the board 60 mm wide")
	await until(() => settles(out) >= 2, 40_000)
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	assert.equal(contract.values.outline.widthMm, 60, "contract.json follows the re-settle")
	assert.equal(done, false)
	stop()
	const r = await run
	assert.ok(r.settled)
	const ended = readFileSync(join(out, "trace.jsonl"), "utf8").split("\n").filter((l) => l.includes('"run.ended"'))
	assert.equal(ended.length, 1, "the page knows the run is gone and closes the composer")
	assert.equal(JSON.parse(ended[0]).payload.settled, true)
})
