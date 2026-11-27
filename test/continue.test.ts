// Continuing an ended design (bringup continue): a new run seeded from its contract, which settles as it was and then
// takes a change request ("make it 50 mm wide") like a run that never ended.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { continueSeed } from "../src/runner/continue.ts"
import { DesignContract } from "../src/contract/contract.ts"

const run = (args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "src/main.ts", ...args, "--mock", "--no-hardware", "--no-cloud"], { env: { ...process.env, BRINGUP_NO_EVIDENCE: "1" }, encoding: "utf8", timeout: 600_000 })

test("continueSeed reads the latest contract or revision N, and names what's missing", () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-continue-"))
	try {
		assert.match((continueSeed(dir) as { error: string }).error, /no brief\.md/)
		run(["briefs/logger.md", "--out", dir])
		const latest = continueSeed(dir) as { contract: { revision: number } }
		assert.ok(latest.contract.revision > 1)
		assert.equal((continueSeed(dir, 2) as { contract: { revision: number } }).contract.revision, 2)
		assert.match((continueSeed(dir, 999) as { error: string }).error, /no revision 999/)
		// The contract restored as it was, its revisions going on from there.
		const c = new DesignContract()
		c.restore(latest.contract as never)
		assert.equal(c.revision, latest.contract.revision)
		assert.deepEqual(c.snapshotAt(latest.contract.revision), latest.contract)

		const next = mkdtempSync(join(tmpdir(), "bringup-continued-"))
		try {
			const out = run(["continue", dir, "--out", next, "--change", "make it 50 mm wide"])
			assert.match(out, /settled at revision \d+ with 0 violation/)
			const s = JSON.parse(readFileSync(join(next, "contract.json"), "utf8"))
			assert.equal(s.values.outline.widthMm, 50)
			assert.ok(s.revision > latest.contract.revision)
			assert.deepEqual(JSON.parse(readFileSync(join(next, "continued-from.json"), "utf8")), { from: dir, revision: latest.contract.revision })
			// The ended run is never written to.
			assert.equal(JSON.parse(readFileSync(join(dir, "contract.json"), "utf8")).revision, latest.contract.revision)
			assert.ok(!existsSync(join(dir, "continued-from.json")))
		} finally {
			rmSync(next, { recursive: true, force: true })
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
