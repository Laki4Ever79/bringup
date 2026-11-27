// The run's time follows its builds (src/runner/run-time.ts): a build still running at the cap is waited for, up to the
// grace; the plan says both numbers. The CNC's full mock (27 Nov 2026) ended at its 30-min cap with the board build,
// about 26 min, still running.
import { test } from "node:test"
import assert from "node:assert/strict"
import { baseRunMs, buildGraceMs, runDeadline, runTimeText } from "../src/runner/run-time.ts"

test("the cap and the grace from the environment; the plan's line says both", () => {
	assert.equal(baseRunMs({}), 30 * 60_000)
	assert.equal(baseRunMs({ BRINGUP_PROVIDER: "claude-code" }), 60 * 60_000)
	assert.equal(buildGraceMs({}), 45 * 60_000)
	assert.equal(buildGraceMs({ BRINGUP_BUILD_GRACE_MIN: "0" }), 0)
	assert.equal(runTimeText({ BRINGUP_PROVIDER: "claude-code" }), "The run stops after about 60 min, or up to 105 min if a build (the board, firmware) is still finishing then.")
	assert.equal(runTimeText({ BRINGUP_BUILD_GRACE_MIN: "0" }), "The run stops after about 30 min.")
})

test("the deadline: at the cap with nothing building; after the build when one is running; never past the grace", async () => {
	const at = async (cap: number, grace: number, inFlight: () => string[]) => {
		const t0 = Date.now()
		let told: string[] | null = null
		await runDeadline(cap, grace, inFlight, (k) => (told = k), 5)
		return { ms: Date.now() - t0, told }
	}
	const idle = await at(30, 1000, () => [])
	assert.ok(idle.ms < 200 && idle.told === null)
	// The board finishes 100 ms after the cap: the deadline waits for it, and says so once.
	const t0 = Date.now()
	const done = await at(30, 1000, () => (Date.now() - t0 < 130 ? ["board"] : []))
	assert.ok(done.ms >= 125 && done.ms < 400, String(done.ms))
	assert.deepEqual(done.told, ["board"])
	// A build that never ends: stopped at cap + grace.
	const stuck = await at(30, 100, () => ["board"])
	assert.ok(stuck.ms >= 125 && stuck.ms < 400, String(stuck.ms))
})
