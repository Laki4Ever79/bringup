import assert from "node:assert/strict"
import { test } from "node:test"
import { circuitFromContract } from "../src/codegen/circuit.ts"
import { fixtureContract } from "./fixture.ts"

test("codegen emits board size and nets", () => {
	const s = fixtureContract()
	const src = circuitFromContract(s)
	assert.match(src, /width="50mm"/)
	assert.match(src, /height="30mm"/)
	for (const pin of s.values.pins!) assert.match(src, new RegExp(`<net name="${pin.signal}" />`))
	// The fixture's signals plus GND and the 3V3 rail; no VBUS because there is no regulator.
	assert.equal(src.match(/<net /g)?.length, s.values.pins!.length + 2)
})

test("codegen joins the MCU GPIO and the part pin on each signal", () => {
	const src = circuitFromContract(fixtureContract())
	assert.match(src, /from="\.U1 > \.GPIO8" to="net\.I2C_SDA"/)
	assert.match(src, /from="\.U2 > \.SDA" to="net\.I2C_SDA"/)
})

test("every trace is named", () => {
	const traces = circuitFromContract(fixtureContract()).match(/<trace [^>]*>/g) ?? []
	assert.ok(traces.length > 0)
	for (const t of traces) assert.match(t, / name="[^"]+"/)
})

test("one chip per part with pin labels from part.pins", () => {
	const src = circuitFromContract(fixtureContract())
	assert.equal(src.match(/<chip /g)?.length, 3)
	assert.match(src, /name="U2"[^>]*pinLabels=\{\{ pin1: "SDA", pin2: "SCL", pin3: "VDD", pin4: "VSS" \}\}/)
})

test("catalog footprint replaces a placeholder for a vetted mpn", () => {
	// The fixture gives the module footprint as "module", which tscircuit rejects.
	const src = circuitFromContract(fixtureContract())
	assert.match(src, /name="U1" footprint="qfn32"/)
	assert.match(src, /name="D1" footprint="0603"/)
})

test("connector sits on its edge at offsetMm", () => {
	// J1: left edge, 15 mm up from the bottom-left corner of a 50×30 board centred on the origin.
	const src = circuitFromContract(fixtureContract())
	assert.match(src, /<connector name="J1" footprint="usbcmidmount" pcbX=\{-19\} pcbY=\{0\} pcbRotation=\{-90\}/)
})

test("connector on the bottom edge offsets along x", () => {
	const s = fixtureContract()
	s.values.connectors = [{ ref: "J1", kind: "usb-c", edge: "bottom", offsetMm: 10, widthMm: 9, heightMm: 3.5 }]
	assert.match(circuitFromContract(s), /name="J1" footprint="usbcmidmount" pcbX=\{-15\} pcbY=\{-9\} pcbRotation=\{0\}/)
})

function withLdo() {
	const s = fixtureContract()
	s.values.parts!.push({ ref: "U3", role: "ldo", mpn: "AP2112K-3.3TRG1", lcsc: "C51118", footprint: "sot23_5", pins: ["VIN", "GND", "EN", "NC", "VOUT"] })
	return s
}

test("GND net joins every GND and VSS pin", () => {
	const src = circuitFromContract(fixtureContract())
	assert.match(src, /<net name="GND" \/>/)
	assert.match(src, /from="\.U1 > \.GND" to="net\.GND"/)
	assert.match(src, /from="\.U2 > \.VSS" to="net\.GND"/)
})

test("the 3V3 rail becomes net V3V3 (tscircuit net names can't start with a digit)", () => {
	const src = circuitFromContract(fixtureContract())
	assert.match(src, /<net name="V3V3" \/>/)
	assert.match(src, /from="\.U1 > \.3V3" to="net\.V3V3"/)
	assert.match(src, /from="\.U2 > \.VDD" to="net\.V3V3"/)
})

test("no supply net without a 3V3 rail", () => {
	const s = fixtureContract()
	s.values.rails = []
	assert.doesNotMatch(circuitFromContract(s), /V3V3/)
})

test("LED cathode goes to GND through an added 1k resistor when the contract has none", () => {
	const src = circuitFromContract(fixtureContract())
	assert.match(src, /<resistor name="R1" resistance="1k" footprint="0402" \/>/)
	assert.match(src, /from="\.D1 > \.K" to="\.R1 > \.pin1"/)
	assert.match(src, /from="\.R1 > \.pin2" to="net\.GND"/)
})

test("LED uses the contract's resistor when there is one", () => {
	const s = fixtureContract()
	s.values.parts!.push({ ref: "R7", role: "resistor", mpn: "0402WGF1002TCE", lcsc: "C25744", footprint: "0402", pins: ["pin1", "pin2"] })
	const src = circuitFromContract(s)
	assert.doesNotMatch(src, /<resistor /)
	assert.match(src, /from="\.D1 > \.K" to="\.R7 > \.pin1"/)
	assert.match(src, /from="\.R7 > \.pin2" to="net\.GND"/)
})

test("USB-C power pads: GND pads always, VBUS to the regulator's VIN and EN", () => {
	const src = circuitFromContract(withLdo())
	assert.match(src, /from="\.J1 > \.pin5" to="net\.GND"/)
	assert.match(src, /from="\.J1 > \.pin16" to="net\.GND"/)
	for (const end of ["\\.J1 > \\.pin6", "\\.J1 > \\.pin15", "\\.U3 > \\.VIN", "\\.U3 > \\.EN"]) {
		assert.match(src, new RegExp(`from="${end}" to="net\\.VBUS"`))
	}
	assert.match(src, /from="\.U3 > \.VOUT" to="net\.V3V3"/)
	assert.match(src, /from="\.U3 > \.GND" to="net\.GND"/)
})

test("no VBUS net without a regulator to feed", () => {
	assert.doesNotMatch(circuitFromContract(fixtureContract()), /VBUS/)
})
