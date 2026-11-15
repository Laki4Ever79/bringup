// A starter forked and tried for free, end to end: fork Rover + climate over the hub's API, Try for free (scripted
// agents on the real toolchain, the hub's own launcher with --stay), the system settles with no findings between the
// boards, and the starter's forks.jsonl holds one record with that result.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { startRunProcess } from "../src/runner/spawn-run.ts"
import { serveHub } from "../src/dashboard/server.ts"
import { forksFile } from "../src/dashboard/starters.ts"
import { tempDir, slow } from "./helpers.ts"

const env = await detectEnvironment(ROOT)
const skip = env.tsci && env.kicad && env.python ? false : "needs tscircuit, KiCad and the .venv with build123d (npm run doctor)"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("fork Rover + climate → Try for free → it settles with 0 findings → forks.jsonl has one record with the result", { skip: slow || skip, timeout: 2_400_000 }, async () => {
	const root = tempDir()
	const hub = await serveHub({ outRoot: root, port: 0, launch: startRunProcess, examplesRoot: join(ROOT, "examples"), forkPollMs: 1000 })
	let design = ""
	try {
		const post = async (path: string, body: unknown) => {
			const r = await fetch(`${hub.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
			return { status: r.status, body: (await r.json()) as Record<string, any> }
		}
		const fork = await post("/api/starters/rover-climate/fork", {})
		assert.equal(fork.status, 201)
		const built = await post(`/api/plans/${fork.body.id}/build`, { mock: true, hardware: true, review: false })
		assert.equal(built.status, 201, JSON.stringify(built.body))
		design = built.body.systemId
		assert.equal(design, `${fork.body.id}-free`)
		const records = () => (existsSync(forksFile(root, "rover-climate")) ? readFileSync(forksFile(root, "rover-climate"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
		assert.equal(records().length, 1, "the build is recorded when it starts")
		const t0 = Date.now()
		while (Date.now() - t0 < 2_000_000 && records()[0]?.result === null) await sleep(2000)
		const [rec] = records()
		console.log(`# fork → settle took ${Math.round((Date.now() - t0) / 1000)} s`)
		assert.equal(records().length, 1)
		assert.equal(rec.planId, fork.body.id)
		assert.deepEqual(rec.diff, { added: [], removed: [], changed: [] }, "an unchanged fork")
		assert.ok(rec.result, "the record got its result")
		assert.equal(rec.result.settled, true, rec.result.status)
		assert.equal(rec.result.findings, 0)
	} finally {
		if (design) await fetch(`${hub.url}/api/systems/${design}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {})
		await sleep(1000)
		await hub.close()
	}
})
