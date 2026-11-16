// Module evidence from forks of a starter (src/modules/library.ts runSource): a system's board runs are told apart by
// their system, and a forked design's evidence names the starter it came from.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { forkCounts, moduleStatus, readEvidence, recordRun, runSource } from "../src/modules/library.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import { tempDir } from "./helpers.ts"

const ROOT = new URL("..", import.meta.url).pathname
const built = { board: { drc: { errors: 0, unconnected: 0 } }, firmware: { ok: true } } as never

test("a system's board runs are named with their system, so two systems' mains are two runs", () => {
	const out = tempDir()
	assert.deepEqual(runSource(join(out, "sys-a", "boards", "main")), { run: "sys-a/main", design: "sys-a" })
	assert.deepEqual(runSource(join(out, "run-7")), { run: "run-7", design: "run-7" })
})

test("a forked design's evidence names its starter, and the module counts forks per starter", () => {
	const out = tempDir(), ev = tempDir()
	mkdirSync(join(out, "plans", "starters", "rover"), { recursive: true })
	writeFileSync(join(out, "plans", "starters", "rover", "forks.jsonl"), [{ design: "fork-1" }, { design: "fork-2" }].map((r) => JSON.stringify({ planId: "p", starterHash: "h", diff: null, result: null, at: "", ...r })).join("\n") + "\n")
	for (const d of ["fork-1", "fork-2", "own-3"]) {
		const src = runSource(join(out, d, "boards", "main"))
		recordRun(ROOT, JSON.parse(JSON.stringify(ROVER_BOARD)), built, src.run, 5, ev, {}, { design: src.design, ...(src.starter ? { starter: src.starter } : {}) })
	}
	const e = readEvidence("motor-stage-drv8833", ev)
	assert.deepEqual(e.map((x) => [x.run, x.starter ?? null]), [["fork-1/main", "rover"], ["fork-2/main", "rover"], ["own-3/main", null]])
	assert.deepEqual(forkCounts(e), { rover: 2 })
	const s = moduleStatus(ROOT, ev).find((x) => x.module.id === "motor-stage-drv8833")!
	assert.equal(s.runs, 3)
	assert.deepEqual(s.forks, { rover: 2 })
})
