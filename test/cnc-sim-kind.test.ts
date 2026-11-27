// The simulated CNC as a build kind (src/agents/builders.ts createCncSimBuilder, src/contract/builds.js cncsim): a design
// with a cnc field runs grblHAL in Renode; a failed check reaches the mechanics engineer and waits while stale; the
// report and the dashboard name it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { BUILDS } from "../src/contract/builds.js"
import { ALL_KINDS, cncNotNeeded } from "../src/agents/builders.ts"
import { BUILDER_TOOLS } from "../src/tools/stubs.ts"
import { checkConsistency, type Artifacts } from "../src/contract/consistency.ts"
import { shownLanes, LANES } from "../src/timeline/lanes.js"
import { cncSimLines, CNC_SIM_LIMITS } from "../src/tools/cnc-sim.ts"
import { CNC_MACHINE } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const sim = (result: "pass" | "fail" | "not run"): NonNullable<Artifacts["cncsim"]> => ({
	revision: 5,
	dir: "/nowhere",
	result,
	reason: result === "fail" ? "hard limit: no hard-limit alarm" : result === "not run" ? "Renode 1.17 is missing" : "",
	checks: result === "not run" ? [] : [{ name: "X steps", ok: true, detail: "800 step pulses on PA0, 800 expected" }, { name: "hard limit", ok: result === "pass", detail: result === "pass" ? "X's limit tripped mid-move: ALARM:1" : "no hard-limit alarm" }],
	knownLimits: CNC_SIM_LIMITS,
	wallS: 60,
})

test("the simulated CNC is a build of its own, from the cnc field and the board's pins, only for a CNC", () => {
	assert.ok(ALL_KINDS.includes("cncsim"))
	assert.deepEqual(BUILDS.cncsim, { inputs: ["cnc", "cncTargets", "pins", "parts"], requires: ["cnc", "pins"], optional: "cnc" })
	assert.deepEqual(BUILDER_TOOLS.cncsim, ["pio"])
	const c = fixtureContract()
	assert.match(cncNotNeeded(c) ?? "", /no cnc design/)
	assert.equal(cncNotNeeded({ ...c, values: { ...c.values, cnc: CNC_MACHINE } }), null)
})

test("a failed simulated check reaches the mechanics engineer; a stale run's waits; a pass or a run that didn't run says nothing", () => {
	const c = fixtureContract()
	const of = (a: Artifacts, cncsimStale = false) => checkConsistency(c, a, "", { quick: true, cncsimStale }).filter((v) => v.kind === "cnc-sim")
	assert.deepEqual(of({ cncsim: sim("pass") }), [])
	assert.deepEqual(of({ cncsim: sim("not run") }), [])
	const [v] = of({ cncsim: sim("fail") })
	assert.deepEqual(v.affects, ["mechanics"])
	assert.deepEqual(v.fields, ["cnc"])
	assert.match(v.message, /hard limit: no hard-limit alarm/)
	assert.deepEqual(of({ cncsim: sim("fail") }, true)[0].affects, [])
})

test("a CNC design shows its simulated machine and mechanics engineer; others don't; the page names the tile", () => {
	const lanes = shownLanes([{ type: "contract.changed", payload: { field: "cnc" } }])
	assert.ok(lanes.includes("build:cncsim") && lanes.includes("mechanics"))
	assert.ok(!shownLanes([]).includes("build:cncsim"))
	assert.equal(LANES.find((l: { key: string }) => l.key === "build:cncsim")?.label, "Simulated machine")
	const page = readFileSync(resolve(import.meta.dirname, "../src/dashboard/page.html"), "utf8")
	assert.match(page, /"build:cncsim": \["Simulated machine", "M"\]/)
})

test("the report's lines: each check and the known limits; a run that didn't run says why", () => {
	const lines = cncSimLines(sim("fail"))
	assert.match(lines[0], /Simulated machine \(grblHAL in Renode, rev 5\): FAILS in 60 s/)
	assert.ok(lines.some((l) => /\*\*FAILS\*\* hard limit/.test(l)))
	assert.ok(lines.at(-1)!.includes("known limits: ") && lines.at(-1)!.includes("STM32F412"))
	assert.deepEqual(cncSimLines(sim("not run")), ["- Simulated machine: not run (Renode 1.17 is missing)"])
	assert.deepEqual(cncSimLines(undefined), [])
})
