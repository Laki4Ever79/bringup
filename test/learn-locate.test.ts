// Finding a value the model claims among the page's own words (src/learn/locate.ts): the model's box only says roughly
// where to look; the fact's region is the words' own box.
import { test } from "node:test"
import assert from "node:assert/strict"
import { claimsExposedPad, locatePins, locateValue, parsePinPairs, type Word } from "../src/learn/locate.ts"

// Words laid out like pdftotext -bbox gives them, on a 612 × 792 pt page: one row per entry, each word at its x (pt).
const W = 612
const H = 792
function rows(lines: [number, [number, string][]][]): Word[] {
	return lines.flatMap(([y, words]) => words.map(([x, text]) => ({ text, region: [x / W, (y - 8) / H, (text.length * 4) / W, 9 / H] as [number, number, number, number] })))
}

// A TI-style pin table: names in alphabetical order, pin numbers in a column, a second package's grid names (A1) beside.
const PIN_TABLE = rows([
	[300, [[30, "NAME"], [150, "GQY,"], [180, "ZQY"], [260, "DRB,"], [290, "DGN"]]],
	[320, [[30, "GND"], [140, "A2,"], [160, "A3"], [270, "7"], [320, "I"], [360, "High-current"], [420, "ground"]]],
	[340, [[30, "IN-"], [150, "D1"], [270, "4"], [320, "I"], [360, "Negative"]]],
	[360, [[30, "IN+"], [150, "C1"], [270, "3"], [320, "I"], [360, "Positive"]]],
	[380, [[30, "NC"], [150, "B1"], [270, "2"], [360, "No"], [380, "internal"]]],
	[400, [[30, "SHUTDOWN"], [150, "A1"], [270, "1"], [320, "I"], [360, "Shutdown"]]],
	[420, [[30, "VDD"], [150, "B4,"], [170, "C4"], [270, "6"], [320, "I"], [360, "Power"]]],
	[440, [[30, "VO−"], [150, "A4"], [270, "8"], [320, "O"], [360, "Negative"]]],
	[460, [[30, "VO+"], [150, "D4"], [270, "5"], [320, "O"], [360, "Positive"]]],
])

test("pins are checked row by row: each number beside its name, whatever order the table lists them in", () => {
	const hit = locatePins("1 SHUTDOWN, 2 NC, 3 IN+, 4 IN-, 5 VO+, 6 VDD, 7 GND, 8 VO-", PIN_TABLE)
	assert.ok(hit, "every pair is on one row")
	assert.deepEqual(hit.names, ["SHUTDOWN", "NC", "IN+", "IN-", "VO+", "VDD", "GND", "VO-"])
	const [, y, , h] = hit.region
	assert.ok(y <= 312 / H && y + h >= 452 / H, "the region spans the table's rows")
})

test("a pin given the wrong number isn't confirmed", () => {
	assert.equal(locatePins("1 SHUTDOWN, 2 NC, 3 IN-, 4 IN+, 5 VO+, 6 VDD, 7 GND, 8 VO-", PIN_TABLE), null)
	// A grid name (A1) is not pin number 1.
	assert.equal(locatePins("1 NC", rows([[100, [[30, "NC"], [150, "A1"]]]])), null)
})

test("pin pairs: numbers 1..n each once, names kept as written; names alone are not pairs", () => {
	assert.deepEqual(parsePinPairs("2 GAIN, 1 SD"), [{ number: 1, name: "SD" }, { number: 2, name: "GAIN" }])
	assert.deepEqual(parsePinPairs("1: +, 2: -"), [{ number: 1, name: "+" }, { number: 2, name: "-" }])
	assert.equal(parsePinPairs("SD, GAIN"), null)
	assert.equal(parsePinPairs("1 SD, 5 GAIN"), null, "pins 2-4 missing")
	assert.equal(parsePinPairs("1 SD, 1 GAIN"), null)
})

const TABLE = rows([
	[140, [[50, "Supply"], [90, "voltage"], [130, "VDD"], [250, "2.5"], [270, "~"], [280, "5.5"], [300, "V"]]],
	[160, [[50, "Absolute"], [100, "maximum"], [150, "VDD"], [250, "6.0"], [270, "V"]]],
	[180, [[50, "Minimum"], [100, "load"], [130, "impedance"], [250, "4"], [260, "ohm"]]],
])
const box = (y: number): [number, number, number, number] => [0.4, (y - 12) / H, 0.4, 20 / H]

test("a value whose claimed box is a line off is found at its own words, and the region becomes theirs", () => {
	const hit = locateValue({ value: 6, unit: "V", region: box(175) }, TABLE)
	assert.ok(hit)
	assert.ok(Math.abs(hit.region[0] - 250 / W) < 1e-9, "starts at the number's word")
	assert.ok(Math.abs(hit.region[1] - 152 / H) < 1e-9)
	assert.match(hit.text, /Absolute maximum VDD 6\.0 V/)
})

test("a range is found as its two ends in one row", () => {
	const hit = locateValue({ value: [2.5, 5.5], unit: "V", region: box(140) }, TABLE)
	assert.ok(hit)
	assert.ok(Math.abs(hit.region[0] - 250 / W) < 1e-9 && hit.region[0] + hit.region[2] >= 303 / W)
})

test("the nearest occurrence wins; one far from the claimed box doesn't count", () => {
	assert.equal(locateValue({ value: 4, unit: "Ω", region: box(500) }, TABLE), null)
	assert.equal(locateValue({ value: 7, unit: "V", region: box(160) }, TABLE), null)
})

// TI's absolute-maximum table: the label sits between its two condition rows, the value in the MAX column.
const ABS_MAX = rows([
	[150, [[300, "MIN"], [420, "MAX"], [500, "UNIT"]]],
	[165, [[170, "In"], [180, "active"], [210, "mode"], [300, "–0.3"], [420, "6"], [500, "V"]]],
	[172, [[30, "VDD"], [60, "Supply"], [90, "voltage"]]],
	[180, [[170, "In"], [180, "SHUTDOWN"], [230, "mode"], [300, "–0.3"], [420, "7"], [500, "V"]]],
	[200, [[30, "TA"], [60, "Operating"], [100, "temperature"], [300, "–40"], [420, "85"], [500, "°C"]]],
])

test("a value is found by its printed label, on the label's row or the next one, however far off the model's box is", () => {
	// The model's box sits in the MIN column and too low: 0.17 of the page away from the 6.
	const hit = locateValue({ value: 6, unit: "V", label: "Supply voltage", region: [0.3, 0.3, 0.05, 0.02] }, ABS_MAX)
	assert.ok(hit)
	assert.ok(Math.abs(hit.region[0] - 60 / W) < 1e-9, "the region runs from the label to the value")
	assert.match(hit.text, /Supply voltage/)
	assert.match(hit.text, /6/)
})

test("a value not on or next to its label's row isn't found by the label", () => {
	assert.equal(locateValue({ value: 85, unit: "V", label: "Supply voltage", region: [0.3, 0.3, 0.05, 0.02] }, ABS_MAX), null)
	assert.equal(locateValue({ value: 6, unit: "V", label: "Output current", region: [0.3, 0.3, 0.05, 0.02] }, ABS_MAX), null)
})

test("pins a pin table doesn't list are NC, a few at most", () => {
	assert.deepEqual(parsePinPairs("1 A, 2 B, 4 D"), [{ number: 1, name: "A" }, { number: 2, name: "B" }, { number: 3, name: "NC" }, { number: 4, name: "D" }])
	assert.equal(parsePinPairs("1 A, 9 D"), null, "most pins missing is no pin-out")
})

test("pins the table lists are confirmed while the ones it doesn't list stay NC", () => {
	const hit = locatePins("1 SHUTDOWN, 3 IN+, 4 IN-, 5 VO+, 6 VDD, 7 GND, 8 VO-", PIN_TABLE)
	assert.deepEqual(hit?.names, ["SHUTDOWN", "NC", "IN+", "IN-", "VO+", "VDD", "GND", "VO-"])
})

test("a pin the model itself calls NC needn't be printed: tables leave unconnected pins out", () => {
	assert.deepEqual(locatePins("1 SHUTDOWN, 2 NC, 3 IN+, 4 IN-, 5 VO+, 6 VDD, 7 GND, 8 VO-, 9 NC", PIN_TABLE)?.names.at(-1), "NC")
})

test("a drawing's dimension table: a one-letter symbol is a label, and the value is on its row", () => {
	const DIMS = rows([[300, [[400, "Dim"], [430, "Min"], [460, "Max"], [490, "Typ"]]], [315, [[400, "A"], [430, "0.55"], [460, "0.65"], [490, "0.60"]]], [330, [[400, "A1"], [430, "0"], [460, "0.05"], [490, "0.02"]]]])
	const hit = locateValue({ value: 0.65, unit: "mm", label: "A", region: [0.1, 0.1, 0.05, 0.02] }, DIMS)
	assert.match(hit?.text ?? "", /^A 0\.55 0\.65/)
	assert.equal(locateValue({ value: 0.05, unit: "mm", label: "A", region: [0.1, 0.1, 0.05, 0.02] }, DIMS), null, "A1's value is not A's")
})

test("unconnected pins written N.C. and a pad written PAD are understood", () => {
	assert.deepEqual(locatePins("1 SHUTDOWN, 2 N.C., 3 IN+, 4 IN-, 5 VO+, 6 VDD, 7 GND, 8 VO-, PAD GND", PIN_TABLE)?.names[1], "N.C.")
	assert.ok(claimsExposedPad("1 A, 2 B, PAD GND"))
})
