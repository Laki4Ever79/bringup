import { test } from "node:test"
import assert from "node:assert/strict"
import { parseNumbers, toCanonical, valueMatches } from "../src/learn/match.ts"

const cases: [string, { value: number | number[]; unit?: string }, string, boolean, number?][] = [
	["comma decimal and diameter sign", { value: 2.2, unit: "mm" }, "Ø2,2 mm", true],
	["22 is not 2.2", { value: 2.2, unit: "mm" }, "22 mm", false],
	["12.2 is not 2.2", { value: 2.2, unit: "mm" }, "12.2", false],
	["tilde range", { value: [3.0, 3.6], unit: "V" }, "3.0 ~ 3.6V", true],
	["en dash range", { value: [2.5, 5.5], unit: "V" }, "VDD 2.5–5.5 V", true],
	["range in the wrong order", { value: [3.6, 3.0], unit: "V" }, "3.0 ~ 3.6V", false],
	["inches to mm", { value: 2.21, unit: "mm" }, '0.087"', true, 0.01],
	["ohms", { value: 8, unit: "Ω" }, "8Ω", true],
	["ohm spelled", { value: 4, unit: "Ω" }, "min load 4 ohm", true],
	["3 W is not 30 W", { value: 30, unit: "W" }, "3 W", false],
	["amps to mA", { value: 1500, unit: "mA" }, "1.5 A", true],
	["unitless number on a unit-carrying page", { value: 0.85 }, "Qts 0.85", true],
	["wrong unit family", { value: 8, unit: "V" }, "8 Ω", false],
	["negative sign isn't a range", { value: [-0.3, 6.0], unit: "V" }, "-0.3 to 6.0 V", true],
]

for (const [name, fact, text, expected, tol] of cases) {
	test(`valueMatches: ${name}`, () => assert.equal(valueMatches(fact, text, tol), expected))
}

test("parseNumbers reads decimals, units and range ends", () => {
	const n = parseNumbers("2.5–5.5 V, 1,2 mm")
	assert.deepEqual(
		n.map((x) => [x.value, x.unit]),
		[
			[2.5, "V"],
			[5.5, "V"],
			[1.2, "mm"],
		],
	)
})

test("toCanonical converts units", () => {
	assert.deepEqual(toCanonical(1, "in"), { value: 25.4, unit: "mm" })
	assert.deepEqual(toCanonical(250, "µA"), { value: 0.25, unit: "mA" })
	assert.deepEqual(toCanonical(3, "kHz"), { value: 3000, unit: "Hz" })
})
