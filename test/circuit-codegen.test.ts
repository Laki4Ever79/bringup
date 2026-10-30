import assert from "node:assert/strict"
import { test } from "node:test"
import { circuitFromContract } from "../src/codegen/circuit.ts"
import { fixtureContract } from "./fixture.ts"

test("codegen emits board size and nets", () => {
	const s = fixtureContract()
	const src = circuitFromContract(s)
	assert.match(src, /width="50mm"/)
	assert.match(src, /height="30mm"/)
	assert.match(src, /name="I2C_SDA"/)
	assert.equal(src.match(/<net /g)?.length, s.values.pins!.length)
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
