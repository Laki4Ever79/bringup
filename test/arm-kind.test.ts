// The arm as a build kind (src/agents/builders.ts createArmBuilder, src/contract/builds.js arm): a run with an arm field
// builds the printed parts and sweeps them; the sweep's clashes and the print check reach the mechanics engineer, and
// wait for the rebuild while the built arm is older than the contract.
import { test } from "node:test"
import assert from "node:assert/strict"
import { BUILDS } from "../src/contract/builds.js"
import { ALL_KINDS, armNotNeeded } from "../src/agents/builders.ts"
import { checkConsistency, type Artifacts } from "../src/contract/consistency.ts"
import { shownLanes } from "../src/timeline/lanes.js"
import { fixtureContract } from "./fixture.ts"
import { ARM } from "./arm-contract.test.ts"

const built = (clash: boolean, printOk = true): NonNullable<Artifacts["arm"]> => ({
	ok: true,
	dir: "/nowhere",
	files: [],
	links: [],
	revision: 3,
	built: { poses: 182, pairs: 15, clashes: clash ? [{ pose: [0, 90, -90, 0, 0], a: "forearm", b: "base", mm3: 12 }] : [], print: { ok: printOk, issues: printOk ? [] : ["a 0.4 mm wall"], notes: [], bedMm: [220, 220] } },
})

test("the arm is a build kind of its own: built from the arm and its targets, only when the design has an arm", () => {
	assert.ok(ALL_KINDS.includes("arm"))
	assert.deepEqual(BUILDS.arm, { inputs: ["arm", "armTargets"], requires: ["arm"], optional: "arm" })
	const c = fixtureContract()
	assert.match(armNotNeeded(c) ?? "", /no arm design/)
	assert.equal(armNotNeeded({ ...c, values: { ...c.values, arm: ARM } }), null)
})

test("a built arm's clash and print problem reach the mechanics engineer; a stale build's wait for the rebuild", () => {
	const c = fixtureContract()
	const arm = (a: Artifacts, armStale = false) => checkConsistency(c, a, "", { quick: true, armStale }).filter((v) => v.kind.startsWith("arm-"))
	assert.deepEqual(arm({ arm: built(false) }), [])
	const v = arm({ arm: built(true, false) })
	assert.deepEqual(v.map((x) => x.kind), ["arm-interference", "arm-dfm"])
	assert.ok(v.every((x) => x.affects.length === 1 && x.affects[0] === "mechanics"))
	assert.match(v[0].message, /forearm hits its base/)
	assert.ok(arm({ arm: built(true) }, true).every((x) => x.affects.length === 0))
	// A stub (--no-hardware) proves nothing and says nothing.
	assert.deepEqual(arm({ arm: { ...built(true), stub: true } }), [])
})

test("an arm design shows the mechanics engineer and the printed arm, not a rover's chassis and drive", () => {
	const lanes = shownLanes([{ type: "contract.changed", payload: { field: "arm" } }])
	assert.ok(lanes.includes("build:arm") && lanes.includes("mechanics"))
	assert.ok(lanes.includes("build:armsim"))
	assert.ok(!lanes.includes("build:chassis") && !lanes.includes("build:drive"))
	assert.ok(!shownLanes([]).includes("build:arm"))
})

test("the simulated pick-and-place is a build of its own; a miss reaches the mechanics engineer, a stale one waits", () => {
	assert.ok(ALL_KINDS.includes("armsim"))
	assert.deepEqual(BUILDS.armsim, { inputs: ["arm", "armTargets", "pins", "parts"], requires: ["arm", "armTargets", "pins"], optional: "arm" })
	const c = fixtureContract()
	const sim = (result: "pass" | "fail" | "not run"): NonNullable<Artifacts["armsim"]> => ({ revision: 4, dir: "/nowhere", result, reason: result === "fail" ? "2 cubes missed the cup" : "", landed: 3, attempts: 5, worstMm: 41, note: "" })
	const of = (a: Artifacts, armsimStale = false) => checkConsistency(c, a, "", { quick: true, armsimStale }).filter((v) => v.kind === "arm-sim")
	assert.deepEqual(of({ armsim: sim("pass") }), [])
	assert.deepEqual(of({ armsim: sim("not run") }), [])
	const [v] = of({ armsim: sim("fail") })
	assert.deepEqual(v.affects, ["mechanics"])
	assert.match(v.message, /3 of 5 landed, worst 41 mm/)
	assert.deepEqual(of({ armsim: sim("fail") }, true)[0].affects, [])
})
