import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { detectEnvironment } from "../src/tools/env.ts"
import { runTournament } from "../src/tournament/run.ts"
import { rankRows, type ScoreRow } from "../src/tournament/score.ts"
import { tempDir } from "./helpers.ts"

const root = resolve(import.meta.dirname, "..")
const env = await detectEnvironment(root)
const skip = env.tsci && env.kicad && env.python && env.pio ? false : "a full run needs tsci, KiCad, python and pio"

test("two mock variants run concurrently and are ranked", { skip, timeout: 600_000 }, async () => {
	const outRoot = tempDir()
	const finished: string[] = []
	const board = await runTournament({
		briefPath: join(root, "briefs/logger.md"),
		variants: [
			{ name: "baseline", constraint: "" },
			{ name: "narrow-40mm", constraint: "Board must be at most 40 mm wide." },
		],
		mock: true,
		outRoot,
		onFinished: (variant) => finished.push(variant),
	})
	assert.deepEqual(finished.sort(), ["baseline", "narrow-40mm"])
	assert.equal(board.rows.length, 2)

	// Both processes were alive at the same time.
	const [a, b] = board.rows.map((r) => [Date.parse(r.startedAt!), Date.parse(r.endedAt!)])
	assert.ok(a[0] < b[1] && b[0] < a[1], `runs did not overlap: ${JSON.stringify(board.rows.map((r) => [r.startedAt, r.endedAt]))}`)

	// The variant constraint reached the design. Whether 40 mm still routes is the tournament's question, not the
	// test's: on 30 Oct tscircuit put a via on a USB-C pad at 40 mm, so that variant ended unsettled.
	const byName = Object.fromEntries(board.rows.map((r) => [r.variant, r])) as Record<string, ScoreRow>
	assert.equal(byName["narrow-40mm"].boardAreaMm2, 1200)
	assert.equal(byName.baseline.boardAreaMm2, 1500)
	assert.equal(byName.baseline.settled, true, JSON.stringify(byName.baseline))
	assert.equal(byName.baseline.violations, 0)
	assert.deepEqual(board.rows.map((r) => r.variant), rankRows(board.rows).map((r) => r.variant))
	if (!byName["narrow-40mm"].settled) assert.equal(board.rows[0].variant, "baseline", "a settled design outranks an unsettled one")

	assert.ok(readFileSync(join(outRoot, "narrow-40mm", "brief.md"), "utf8").includes("Board must be at most 40 mm wide."))
	const json = JSON.parse(readFileSync(join(outRoot, "scoreboard.json"), "utf8")) as { rows: ScoreRow[] }
	assert.deepEqual(json.rows.map((r) => r.variant), board.rows.map((r) => r.variant))
	assert.ok(existsSync(join(outRoot, "scoreboard.md")))
})
