// Finding a value the model claims among the page's own words (src/learn/locate.ts): the model's box only says roughly
// where to look; the fact's region is the words' own box.
import { test } from "node:test"
import assert from "node:assert/strict"
import { locatePins, locateValue, parsePinPairs, type Word } from "../src/learn/locate.ts"

// Words laid out like pdftotext -bbox gives them, on a 612 × 792 pt page: one row per entry, each word at its x (pt).
const W = 612
const H = 792
function rows(lines: [number, [number, string][]][]): Word[] {
	return lines.flatMap(([y, words]) => words.map(([x, text]) => ({ text, region: [x / W, (y - 8) / H, (text.length * 5) / W, 9 / H] as [number, number, number, number] })))
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
	assert.equal(parsePinPairs("1 SD, 3 GAIN"), null, "pin 2 missing")
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
	assert.ok(Math.abs(hit.region[0] - 250 / W) < 1e-9 && hit.region[0] + hit.region[2] >= 305 / W)
})

test("the nearest occurrence wins; one far from the claimed box doesn't count", () => {
	assert.equal(locateValue({ value: 4, unit: "Ω", region: box(500) }, TABLE), null)
	assert.equal(locateValue({ value: 7, unit: "V", region: box(160) }, TABLE), null)
})
