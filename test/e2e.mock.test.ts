import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { detectEnvironment } from "../src/tools/env.ts"
import { run } from "../src/tools/exec.ts"
import { tempDir } from "./helpers.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const env = await detectEnvironment(root)
const ready = env.tsci && env.kicad && env.python && env.pio

test("bringup --mock turns the logger brief into a consistent design", { skip: !ready && "a hardware tool is missing", timeout: 900_000 }, async () => {
	const out = tempDir()
	const r = await run(join(root, "node_modules/.bin/tsx"), ["src/main.ts", "briefs/logger.md", "--mock", "--out", out], { cwd: root, timeoutMs: 880_000 })
	assert.equal(r.code, 0, `exit ${r.code}\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`)
	const report = readFileSync(join(out, "report.md"), "utf8")
	assert.match(report, /Violations: 0/)
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const ready = new Set(trace.filter((e) => e.type === "artifact.ready").map((e) => e.payload.kind))
	assert.deepEqual([...ready].sort(), ["board", "enclosure", "firmware"])
	const types = trace.map((e) => e.type)
	assert.ok(types.indexOf("change.proposed") >= 0 && types.indexOf("change.proposed") < types.indexOf("change.decided"), "no held change")
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	assert.ok(contract.values.pins.some((p: { signal: string }) => p.signal === "STATUS_LED"))
})
