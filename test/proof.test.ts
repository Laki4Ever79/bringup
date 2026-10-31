import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { matchTrial, proofSummary, vividMismatch } from "../src/dashboard/proof.js"

const results = JSON.parse(readFileSync("docs/experiment-results.json", "utf8"))

test("the proof line: changes, arm A's violations and time range, arm B's shipped mismatches", () => {
	const p = proofSummary(results)!
	assert.equal(p.changes, 5)
	assert.equal(p.violations, 0)
	assert.deepEqual(p.rangeS, [31, 84])
	assert.equal(p.shipped, 14)
	assert.equal(p.headline, "5 real changes · with the shared contract: 0 violations, consistent again in 31–84 s · each team on its own copy: 14 mismatches would ship")
	assert.equal(p.rows.length, 5)
	assert.deepEqual(p.rows[2], { id: "usb-edge", label: "Move the USB-C port to the bottom edge", seconds: 52, woken: 2, workers: 7, shipped: 1, vivid: "cutout for J1 is left@15 mm 10×4.5, connector is bottom@25 mm 9×3.5" })
	assert.equal(proofSummary(null), null)
	assert.equal(proofSummary({ results: [] }), null)
})

test("the most vivid mismatch: a misplaced cutout, then a wrong outline, then a missing net, then a standoff", () => {
	const m = (kind: string, message: string) => ({ kind, message })
	assert.equal(vividMismatch([m("standoff-mismatch", "a"), m("outline-mismatch", "board is 50×30 mm, contract says 50×36 mm")]), "board is 50×30 mm, contract says 50×36 mm")
	assert.equal(vividMismatch([m("net-missing", "n"), m("cutout-misaligned", "c")]), "c")
	assert.equal(vividMismatch([m("something-new", "x")]), "x")
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
