// A passive the agents wired is never a stand-in for a generated support part (src/codegen/circuit.ts supportParts):
// the CNC without its LED resistor R1 had its UART TX resistor R20 (1 kΩ, the same LCSC C11702) claimed as the LED's,
// pin2 on GND as well as @STEPPER_UART: a short (gap 2 parts probe, 27 Nov 2026).
import { test } from "node:test"
import assert from "node:assert/strict"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { generatedNets, supportParts } from "../src/codegen/circuit.ts"
import { completePowerTree } from "../src/contract/power-auto.ts"
import type { ContractSnapshot, Part } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const b = fixtureContract()
const cnc = (parts: Part[]): ContractSnapshot => {
	const s = { ...b, values: { ...b.values, ...CNC_DESIGN, parts, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as ContractSnapshot
	return { ...s, values: { ...s.values, parts: completePowerTree(parts, undefined, s).parts } }
}
const netsOf = (s: ContractSnapshot, pin: string) => [...generatedNets(s).entries()].filter(([, ps]) => ps.includes(pin)).map(([n]) => n)

test("without R1, the LED gets a generated resistor and R20 stays on the drivers' line alone", () => {
	const s = cnc(CNC_DESIGN.parts!.filter((p) => p.ref !== "R1"))
	assert.deepEqual(netsOf(s, "R20.pin2"), ["STEPPER_UART"])
	const led = supportParts(s).find((j) => /^LED D1 cathode/.test(j.job))!
	assert.equal(led.added, true)
	assert.notEqual(led.ref, "R20")
})

test("an unwired passive of the same part still stands in (no duplicate beside the generator's own)", () => {
	const s = cnc(CNC_DESIGN.parts!)
	const led = supportParts(s).find((j) => /^LED D1 cathode/.test(j.job))!
	assert.deepEqual([led.ref, led.added], ["R1", false])
})
