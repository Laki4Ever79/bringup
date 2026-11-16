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
	assert.equal(figs.length, 12)
	assert.ok(figs.every((f) => f.ok))
})

// The base carries the opponent's 400 g beacon at 430 mm: braking at the floor's grip would tip it, so its firmware ramps
// the duty (mechanics.drive.maxAccelMps2); the plain rover's header has no ramp (its firmware is as before).
test("the Eurobot base's firmware ramps its duty; the reference rover's doesn't", async () => {
	const { roverHeader } = await import("../src/mechanics/firmware.ts")
	const { ROVER_BOARD } = await import("../src/inference/scripts.ts")
	const ramp = /#define ROVER_RAMP_PER_TICK ([\d.]+)f/.exec(roverHeader(snap()))
	assert.ok(ramp && Number(ramp[1]) > 0 && Number(ramp[1]) < 0.2, "a small duty step per tick")
	assert.doesNotMatch(roverHeader({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) }), /ROVER_RAMP_PER_TICK/)
	const noRamp = snap()
	delete noRamp.values.mechanics.drive.maxAccelMps2
	const tip = mechanicsChecksWith(noRamp, defaultCheckCatalog()!).find((v) => v.kind === "mech-tipping")
	assert.match(tip?.message ?? "", /when braking hard/)
})

// The base's still (16 Nov) showed its battery inside the mast's socket, and no check said so.
test("nothing may stand where the beacon support's mast does", () => {
	const s = snap()
	s.values.mechanics.battery.at = { xMm: 20, yMm: 0 }
	const v = mechanicsChecksWith(s, defaultCheckCatalog()!).filter((x) => x.kind === "mech-fit")
	assert.equal(v.length, 1)
	assert.match(v[0].message, /^battery stands where the beacon support's 70 mm mast/)
})
