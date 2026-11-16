// The scripted Eurobot base (briefs/eurobot-base.md, EUROBOT_BOARD): the brief picks it, and it passes every mechanics,
// safety and rule check as designed (the beacon design took the brief before, for its word "beacon").
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { defaultCheckCatalog, mechanicsChecksWith, mechanicsFigures } from "../src/mechanics/checks.ts"
import { motionBriefChecks } from "../src/mechanics/brief.ts"
import { EUROBOT_BOARD, motionFromBrief, scriptedDesignFor } from "../src/inference/scripts.ts"

const brief = readFileSync(new URL("../briefs/eurobot-base.md", import.meta.url), "utf8")
const snap = () => ({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(EUROBOT_BOARD)) })

test("the Eurobot brief gets the Eurobot base, not the beacon", () => {
	assert.equal(scriptedDesignFor(brief), EUROBOT_BOARD)
	assert.equal(motionFromBrief(brief).rules, "eurobot-2026")
	assert.deepEqual(motionFromBrief(brief).maxSizeMm, [290, 290])
})

test("the Eurobot base passes every mechanics, safety and rule check, and its motion matches the brief", () => {
	assert.deepEqual(mechanicsChecksWith(snap(), defaultCheckCatalog()!), [])
	assert.deepEqual(motionBriefChecks(snap(), brief), [])
	const figs = mechanicsFigures(snap()).filter((f) => f.check.startsWith("eurobot-2026"))
	assert.equal(figs.length, 7)
	assert.ok(figs.every((f) => f.ok))
})
