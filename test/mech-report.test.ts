// The report's Mechanics section: the brief's targets against the computed values (from the same code as the checks),
// the estimates used, and the simulated drive's result.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { writeReport } from "../src/report.ts"
import { BringupState } from "../src/runtime.ts"
import type { Env } from "../src/tools/env.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const env: Env = { root: ".", tsci: "tsci", kicad: "docker", python: "python", pio: "pio" }

function state(values: object): BringupState {
	const s = new BringupState(tempDir())
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	for (const [k, v] of Object.entries(JSON.parse(JSON.stringify(values)))) (s.contract as any).values[k] = v
	return s
}
const report = (s: BringupState) => readFileSync(writeReport(s.outDir, s, env, true, { noHardware: true }), "utf8")
const section = (r: string) => r.slice(r.indexOf("## Mechanics"), r.indexOf("\n## ", r.indexOf("## Mechanics") + 3))

test("a rover's report has a Mechanics section: each check's number against its limit, the estimates, the drive", () => {
	const s = state(ROVER_BOARD)
	s.artifacts.drive = { revision: 5, dir: "/d", result: "pass", reason: "every segment passed", segments: [{ name: "edge crossed", pass: true, detail: "the caster reached x = 1.20 m (the step is 3 mm at 0.6 m)" }], peakA: 0.41, topSpeedMps: 0.3, closestWallMm: 160 }
	const m = section(report(s))
	assert.match(m, /^## Mechanics/)
	assert.match(m, /Top speed \| 0\.\d+ m\/s \| at least 0\.3 m\/s \| ok/)
	assert.match(m, /Caster climb \| \d+ % of the weight \| at most \d+ % \| ok/)
	assert.match(m, /Runtime \| \d+ min \| at least 30 min/)
	assert.match(m, /\(estimate: floorMu 0\.6\)/)
	assert.match(m, /Simulated drive: pass/)
	assert.match(m, /edge crossed: pass/)
})

test("without a drive the report says the mechanics are not proven in simulation", () => {
	assert.match(section(report(state(ROVER_BOARD))), /not proven in simulation/)
})

test("a board with no motion targets has no Mechanics section", () => {
	const s = new BringupState(tempDir())
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	for (const [k, v] of Object.entries(fixtureContract().values)) (s.contract as any).values[k] = v
	assert.doesNotMatch(report(s), /## Mechanics/)
})

test("a robot's boot line points at the simulated drive, not the product firmware's QEMU boot", () => {
	const s = state(ROVER_BOARD)
	const r = readFileSync(writeReport(s.outDir, s, env, true), "utf8")
	assert.match(r, /Firmware boot \(QEMU\): proven by the simulated drive/)
})
