import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, runDesign } from "../src/run.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

// One runtime per process: let the previous run's loops wind down first.
afterEach(() => new Promise((r) => setTimeout(r, 300)))

// Every contract write says why: the writer's own reason, the field before and after, and what woke the writer.
test("contract.changed carries the reason, the value before and after, and the cause (brief, request, approval)", { timeout: 90_000 }, async () => {
	const out = tempDir()
	const env = await detectEnvironment(ROOT)
	const r = await runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, noHardware: true, outDir: out, env, timeoutMs: 80_000, changes: ["make the board 60 mm wide"] })
	assert.ok(r.settled)
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const changes = trace.filter((e) => e.type === "contract.changed").map((e) => e.payload)
	assert.ok(changes.length >= 6)
	for (const c of changes) {
		assert.equal(typeof c.reason, "string", `${c.field} v${c.version} has a reason`)
		assert.ok(c.reason.length > 0)
		assert.ok("after" in c, `${c.field} v${c.version} has its new value`)
		assert.ok(c.cause && typeof c.cause.kind === "string", `${c.field} v${c.version} has a cause`)
	}
	// The first outline came from the brief, with nothing before it.
	const first = changes.find((c) => c.field === "outline")
	assert.equal(first.cause.kind, "brief")
	assert.equal(first.before, null)
	assert.equal(first.after.widthMm, 50)
	// The 60 mm one came from the engineer's request, by id and text.
	const wide = changes.find((c) => c.field === "outline" && c.after.widthMm === 60)
	assert.ok(wide, "the request changed the outline")
	assert.deepEqual(wide.cause, { kind: "request", id: "req-1", text: "make the board 60 mm wide" })
	assert.equal(wide.before.widthMm, 50)
	assert.match(wide.reason, /60 mm/)
	// The scripted firmware reviewer's pin change is held and approved: its write cites the approval.
	const approved = changes.find((c) => c.cause.kind === "approval")
	assert.ok(approved, "a held change's write names its approval")
	assert.equal(typeof approved.cause.proposalId, "string")
	assert.ok(approved.cause.approvedBy.length > 0)
	assert.equal(typeof approved.cause.reason, "string")
})
