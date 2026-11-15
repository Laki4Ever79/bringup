import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { predictedViolations } from "../src/contract/predict.ts"
import { mechanicsChecks } from "../src/mechanics/checks.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot, Part } from "../src/contract/types.ts"

const brief = readFileSync(resolve(import.meta.dirname, "../briefs/rover.md"), "utf8")
const rover = (): ContractSnapshot => ({ revision: 9, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })

test("removing the sensor's connector from parts is predicted to raise a wiring finding for the parts agent (real rover run 10, rev 37)", () => {
	const s = rover()
	const parts = (s.values.parts as Part[]).filter((p) => p.ref !== "JT1")
	const p = predictedViolations(s, "parts", parts, brief)
	assert.ok(p.some((v) => v.kind === "mech-wiring" && v.affects.includes("parts")), JSON.stringify(p.map((v) => v.message)))
})

test("a change that raises nothing is predicted to raise nothing", () => {
	const s = rover()
	assert.deepEqual(predictedViolations(s, "parts", s.values.parts, brief), [])
})

test("the sensor's plug under another ref: the parts agent and the architect rename it to the mechanics' JT1, not add a second (run 10: J5 and JT1)", () => {
	const s = rover()
	for (const p of s.values.parts as Part[]) if (p.ref === "JT1") p.ref = "J5"
	for (const p of s.values.pins ?? []) if (p.partRef === "JT1") p.partRef = "J5"
	const w = mechanicsChecks(s).filter((v) => v.kind === "mech-wiring")
	assert.ok(w.some((v) => /plug: rename it JT1/.test(v.message) && v.affects.includes("parts") && v.affects.includes("architect")), JSON.stringify(w))
	assert.ok(!w.some((v) => /needs a 4-pin connector JT1/.test(v.message)))
})

test("pins on the sensor's plug are flagged for the architect: the plug takes no pins (real rover run 3: EXP_IO1/2 on JT1)", () => {
	const s = rover()
	s.values.pins = [...(s.values.pins ?? []), { signal: "EXP_IO1", gpio: 4, partRef: "JT1", partPin: "1" } as never]
	const w = mechanicsChecks(s).filter((v) => v.kind === "mech-wiring")
	assert.ok(w.some((v) => /EXP_IO1 \(GPIO4\) goes to the distance sensor's plug JT1: remove it/.test(v.message) && v.affects.includes("architect")), JSON.stringify(w))
})
