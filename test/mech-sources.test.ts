import { test } from "node:test"
import assert from "node:assert/strict"
import { mechanicsChecks, mechanicsFigures } from "../src/mechanics/checks.ts"
import { mechanicsSection } from "../src/mechanics/report.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const rover = (): ContractSnapshot => ({ revision: 9, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })

test("every mechanics figure cites the datasheet numbers it used, with the page and where on it", () => {
	const figs = mechanicsFigures(rover())
	assert.ok(figs.length >= 10)
	for (const f of figs) assert.ok(f.sources?.length, `${f.check} has no source`)
	const top = figs.find((f) => f.check === "Top speed")!
	// The load line: speed constant, winding (stall torque and current), the wheel, the pack, and the masses rolling.
	const fields = new Set(top.sources!.map((s) => s.field))
	for (const f of ["diameterMm", "noLoadRpm", "nominalV", "ratedV", "stallTorqueNm", "stallA", "massG"]) assert.ok(fields.has(f), `Top speed cites ${f}`)
	assert.ok(top.sources!.every((s) => /^https:\/\//.test(s.url) && s.where.length > 0))
})

test("a finding cites its numbers: a stall current over the pack's peak names the motor's stallA and the pack's peakA pages", () => {
	const s = rover()
	// Two 1.6 A HP motors on the 1.2 A-peak 1200 mAh cell (real rover run 8 drew 2.88 A from it).
	s.values.mechanics!.battery.pack = "ADAFRUIT-258 LP-503562 1200 mAh"
	s.values.mechanics!.drive.motor = "POLOLU-998 50:1 HP 6V"
	const v = mechanicsChecks(s).find((x) => x.kind === "mech-current")
	assert.ok(v, "no mech-current finding")
	assert.ok(v.sources!.some((x) => x.field === "stallA") && v.sources!.some((x) => x.field === "peakA"))
})

test("the report lists each datasheet page once, numbered, and each figure points at its numbers", () => {
	const text = mechanicsSection(rover(), undefined).join("\n")
	assert.match(text, /\| Sources \|/)
	assert.match(text, /Datasheet sources:\n1\. /)
	assert.match(text, /\| Top speed \|.*\[\d+\]/)
})
