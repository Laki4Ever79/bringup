import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { matchTrial, proofSummary, vividMismatch } from "../src/dashboard/proof.js"

const results = JSON.parse(readFileSync("docs/experiment-results.json", "utf8"))

test("the proof line: changes, arm A's violations and time range, arm B's shipped mismatches", () => {
	const p = proofSummary(results)!
	assert.equal(p.changes, 6)
	assert.equal(p.violations, 0)
	assert.deepEqual(p.rangeS, [31, 72])
	assert.equal(p.shipped, 16)
	assert.equal(p.headline, "6 real changes · with the shared contract: 0 violations, consistent again in 31–72 s · each team on its own copy: 16 mismatches would ship")
	assert.equal(p.rows.length, 6)
	assert.deepEqual(p.rows[2], { id: "usb-edge", label: "Move the USB-C port to the bottom edge", seconds: 52, woken: 2, workers: 7, shipped: 1, vivid: "cutout for J1 is left@15 mm 10×4.5, connector is bottom@25 mm 9×3.5" })
	assert.equal(proofSummary(null), null)
	assert.equal(proofSummary({ results: [] }), null)
})

test("the most vivid mismatch: a misplaced cutout, then a wrong outline, then a missing net, then a standoff", () => {
	const m = (kind: string, message: string) => ({ kind, message })
	assert.equal(vividMismatch([m("standoff-mismatch", "a"), m("outline-mismatch", "board is 50×30 mm, contract says 50×36 mm")]), "board is 50×30 mm, contract says 50×36 mm")
	assert.equal(vividMismatch([m("net-missing", "n"), m("cutout-misaligned", "c")]), "c")
	assert.equal(vividMismatch([m("something-new", "x")]), "x")
	// A wrong part on the board (af's part-mismatch) is as tangible as a wrong outline, and beats a missing net.
	assert.equal(vividMismatch([m("net-missing", "n"), m("part-mismatch", "board places AP2112K-3.3TRG1 as U3, contract says XC6206P332MR-G")]), "board places AP2112K-3.3TRG1 as U3, contract says XC6206P332MR-G")
	assert.equal(vividMismatch([m("part-mismatch", "p"), m("outline-mismatch", "o")]), "o")
	assert.equal(vividMismatch([]), null)
})

const logger = {
	outline: { widthMm: 50, heightMm: 30 },
	connectors: [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 15, widthMm: 9, heightMm: 3.2 }],
	pins: [{ signal: "I2C_SDA", gpio: 6, partRef: "U1", partPin: "x" }, { signal: "I2C_SCL", gpio: 7, partRef: "U1", partPin: "y" }],
	parts: [{ ref: "U1", mpn: "ESP32-C3-MINI-1" }],
}

test("a run's change cites a trial only when it is the same change on the same starting design", () => {
	const narrower = { ...logger, outline: { widthMm: 40, heightMm: 30 } }
	assert.equal(matchTrial({ brief: "pocket climate logger", before: logger, after: narrower }, results)?.id, "narrower")
	assert.equal(matchTrial({ brief: "pocket climate logger", before: logger, after: { ...logger, outline: { widthMm: 50, heightMm: 36 } } }, results)?.id, "taller")
	assert.equal(matchTrial({ brief: "pocket climate logger", before: logger, after: { ...logger, connectors: [{ ...logger.connectors[0], edge: "bottom", offsetMm: 25 }] } }, results)?.id, "usb-edge")
	assert.equal(matchTrial({ brief: "pocket climate logger", before: logger, after: { ...logger, pins: [{ ...logger.pins[0], gpio: 4 }, { ...logger.pins[1], gpio: 5 }] } }, results)?.id, "i2c-pins")
	// Not the same change: 60 mm wide, or narrower by a different amount, or narrower plus something else.
	assert.equal(matchTrial({ brief: "pocket climate logger", before: logger, after: { ...logger, outline: { widthMm: 60, heightMm: 30 } } }, results), null)
	assert.equal(matchTrial({ brief: "pocket climate logger", before: logger, after: { ...logger, outline: { widthMm: 45, heightMm: 30 } } }, results), null)
	assert.equal(matchTrial({ brief: "pocket climate logger", before: logger, after: { ...narrower, pins: [{ ...logger.pins[0], gpio: 4 }, logger.pins[1]] } }, results), null)
	// Not the same starting design: another brief, or the logger already resized.
	assert.equal(matchTrial({ brief: "tiny blinky", before: logger, after: narrower }, results), null)
	assert.equal(matchTrial({ brief: "pocket climate logger", before: narrower, after: { ...logger, outline: { widthMm: 30, heightMm: 30 } } }, results), null)
	assert.equal(matchTrial({ brief: "pocket climate logger", before: null, after: narrower }, results), null)
	assert.equal(matchTrial({ brief: "pocket climate logger", before: logger, after: narrower }, null), null)
})

test("the regulator swap and the added button match their trials exactly; anything extra matches nothing", () => {
	const base = {
		...logger,
		parts: [{ ref: "U1", role: "mcu", mpn: "ESP32-C3-MINI-1" }, { ref: "U3", role: "ldo", mpn: "AP2112K-3.3TRG1", lcsc: "C51118", footprint: "sot23_5", pins: ["VIN", "GND", "EN", "NC", "VOUT"] }],
		rails: [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 120 }],
	}
	const swapped = { ...base, parts: [base.parts[0], { ref: "U3", role: "ldo", mpn: "XC6206P332MR-G", lcsc: "C5446", footprint: "sot23", pins: ["GND", "VOUT", "VIN"] }] }
	assert.equal(matchTrial({ brief: "pocket climate logger", before: base, after: swapped }, results)?.id, "ldo-swap")
	assert.equal(matchTrial({ brief: "pocket climate logger", before: base, after: { ...swapped, rails: [{ ...base.rails[0], regulatorMaxMa: 200 }] } }, results), null, "rails changed too: not the trial")
	const button = {
		...base,
		parts: [...base.parts, { ref: "SW1", role: "button", mpn: "TS-1187A-B-A-B", lcsc: "C318884", footprint: "pushbutton", pins: ["A", "B"] }],
		pins: [...base.pins, { signal: "BUTTON", gpio: 3, partRef: "SW1", partPin: "A" }],
		connectors: [...base.connectors, { ref: "SW1", kind: "button", edge: "top", offsetMm: 25, widthMm: 4, heightMm: 3 }],
	}
	assert.equal(matchTrial({ brief: "pocket climate logger", before: base, after: button }, results)?.id, "add-button")
	assert.equal(matchTrial({ brief: "pocket climate logger", before: base, after: { ...button, pins: [...base.pins, { signal: "BUTTON", gpio: 4, partRef: "SW1", partPin: "A" }] } }, results), null, "another GPIO: not the trial")
	// The existing trials are strict the same way: narrower plus a rails change is no trial.
	assert.equal(matchTrial({ brief: "pocket climate logger", before: base, after: { ...base, outline: { widthMm: 40, heightMm: 30 }, rails: [{ ...base.rails[0], loadMa: 90 }] } }, results), null)
})
