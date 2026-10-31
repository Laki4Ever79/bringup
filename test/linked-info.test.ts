import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { serveDashboard } from "../src/dashboard/server.ts"
import { commitPaths, ensureRepo } from "../src/runner/git.ts"
import { linkedInfo, LINKED_FILE, rippleMessage } from "../src/runner/linked.ts"
import { tempDir } from "./helpers.ts"

const ev = (type: string, payload: unknown, at = "2026-10-31T12:00:00.000Z") => ({ at, type, payload })

test("the commit message carries the request and where it came from, for the Files panel", () => {
	const typed = rippleMessage([ev("run.started", {}), ev("change.requested", { id: "req-1", text: "make the board 40 mm wide" })], 9)
	assert.match(typed, /^Bringup-Revision: 9\nBringup-Request: req-1\nBringup-Source: typed$/m)
	const file = rippleMessage([ev("run.started", {}), ev("change.requested", { id: "req-2", text: "edited pins.h: …", source: { kind: "file", path: "firmware/pins.h", revision: 8, items: [] } })], 10)
	assert.match(file, /^Bringup-Source: file$/m)
	assert.match(rippleMessage([ev("run.started", {})], 7), /^Bringup-Revision: 7\nBringup-Source: brief$/m)
})

test("linkedInfo: the folder, git, dirty or clean, and Bringup's commits newest first; the hub serves it with the drift", async () => {
	const out = join(tempDir(), "run-1")
	const dir = join(tempDir(), "design")
	mkdirSync(join(dir, "firmware"), { recursive: true })
	mkdirSync(out, { recursive: true })
	writeFileSync(join(out, "trace.jsonl"), "")
	ensureRepo(dir)
	writeFileSync(join(dir, "firmware/pins.h"), "#define PIN_I2C_SDA 8\n")
	commitPaths(dir, ["firmware/pins.h"], rippleMessage([ev("run.started", {})], 7))
	writeFileSync(join(dir, "firmware/pins.h"), "#define PIN_I2C_SDA 4\n")
	commitPaths(dir, ["firmware/pins.h"], rippleMessage([ev("run.started", {}), ev("change.requested", { id: "req-1", text: "edited pins.h: I2C_SDA GPIO8 → GPIO4", source: { kind: "file", path: "firmware/pins.h", revision: 7, items: [] } })], 8))
	writeFileSync(join(out, LINKED_FILE), JSON.stringify({ dir }))
	assert.equal(linkedInfo(out)!.dirty, false)
	writeFileSync(join(dir, "firmware/pins.h"), "#define PIN_I2C_SDA 4\n#define DEBUG 1\n")
	const info = linkedInfo(out)!
	assert.equal(info.dir, dir)
	assert.equal(info.git, true)
	assert.equal(info.dirty, true)
	assert.deepEqual(info.commits.map((c) => [c.revision, c.subject, c.source, c.requestId]), [
		[8, "Bringup rev 8: edited pins.h: I2C_SDA GPIO8 → GPIO4", "file", "req-1"],
		[7, "Bringup rev 7: the design from the brief", "brief", null],
	])
	assert.match(info.commits[0].id, /^[0-9a-f]{7,}$/)
	assert.match(info.commits[0].at, /^\d{4}-\d\d-\d\dT/)
	assert.equal(linkedInfo(tempDir()), null, "not linked")

	const dash = await serveDashboard(out, 0)
	try {
		const body = (await (await fetch(`${dash.url}/api/runs/run-1/files`)).json()) as { linked: { dir: string; commits: unknown[] }; entries: unknown[] }
		assert.equal(body.linked.dir, dir)
		assert.equal(body.linked.commits.length, 2)
		assert.deepEqual(body.entries, [])
	} finally {
		await dash.close()
	}
})
