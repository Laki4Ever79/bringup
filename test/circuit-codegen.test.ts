import assert from "node:assert/strict"
import { test } from "node:test"
import { circuitFromContract, placeParts, type Placed } from "../src/codegen/circuit.ts"
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
	assert.match(src, /name="U1"[^>]*footprint=\{<footprint>/)
	assert.match(src, /name="D1"[^>]*footprint="0603"/)
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
	assert.match(src, /<resistor name="R1" resistance="1k" pcbX=[^>]*footprint="0402" \/>/)
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

// The shape of a real mock run: USB-C on the bottom, a button on top, and 14 passives.
function busyContract() {
	const s = withLdo()
	s.values.connectors = [
		{ ref: "J1", kind: "usb-c", edge: "bottom", offsetMm: 25, widthMm: 9, heightMm: 7 },
		{ ref: "SW1", kind: "button", edge: "top", offsetMm: 25, widthMm: 4, heightMm: 3 },
	]
	s.values.pins!.push({ signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" })
	for (let i = 1; i <= 7; i++) {
		s.values.parts!.push({ ref: `R${i}`, role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: ["pin1", "pin2"] })
		s.values.parts!.push({ ref: `C${i}`, role: "capacitor", mpn: "CL05B104KO5NNNC", lcsc: "C1525", footprint: "0402", pins: ["pin1", "pin2"] })
	}
	return s
}

const GAP_MM = 1.5

function assertSpaced(boxes: Placed[], w: number, h: number) {
	for (const b of boxes) {
		assert.ok(Math.abs(b.x) + b.w / 2 <= w / 2 && Math.abs(b.y) + b.h / 2 <= h / 2, `${b.ref} is outside the board`)
	}
	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const [a, b] = [boxes[i], boxes[j]]
			const gapX = Math.abs(a.x - b.x) - (a.w + b.w) / 2
			const gapY = Math.abs(a.y - b.y) - (a.h + b.h) / 2
			assert.ok(Math.max(gapX, gapY) >= GAP_MM - 1e-9, `${a.ref} and ${b.ref} are closer than ${GAP_MM} mm`)
		}
	}
}

test("placement: every part and connector is inside the board with a 1.5 mm gap", () => {
	for (const s of [fixtureContract(), withLdo(), busyContract()]) {
		const boxes = placeParts(s)
		const refs = [...s.values.parts!.map((p) => p.ref), ...s.values.connectors!.map((c) => c.ref)]
		for (const ref of refs) assert.ok(boxes.some((b) => b.ref === ref), `${ref} not placed`)
		assertSpaced(boxes, s.values.outline!.widthMm, s.values.outline!.heightMm)
	}
})

test("placement is deterministic", () => {
	assert.deepEqual(placeParts(busyContract()), placeParts(busyContract()))
})

test("placement follows the roles: LDO between USB-C and MCU, sensor on the far side, LED by an edge", () => {
	for (const s of [withLdo(), busyContract()]) {
		const at = (ref: string) => placeParts(s).find((b) => b.ref === ref)!
		const usb = at("J1"), mcu = at("U1"), ldo = at("U3"), sensor = at("U2"), led = at("D1")
		const dist = (a: Placed, b: Placed) => Math.hypot(a.x - b.x, a.y - b.y)
		assert.ok(dist(ldo, usb) < dist(mcu, usb), "LDO is not nearer the USB-C than the MCU is")
		assert.ok(dist(sensor, usb) > dist(mcu, usb), "sensor is not on the far side of the MCU from USB-C")
		assert.ok(dist(sensor, mcu) >= 15 && dist(sensor, ldo) >= 15, "sensor is within 15 mm of a heat source")
		const { widthMm: w, heightMm: h } = s.values.outline!
		const edgeGap = Math.min(w / 2 - Math.abs(led.x) - led.w / 2, h / 2 - Math.abs(led.y) - led.h / 2)
		assert.ok(edgeGap <= 3, `LED is ${edgeGap} mm from the nearest edge`)
	}
})

test("MCU sits near the board centre and reserves the whole 13.2 x 16.6 mm module", () => {
	const mcu = placeParts(fixtureContract()).find((b) => b.ref === "U1")!
	assert.deepEqual([mcu.w, mcu.h].sort(), [13.2, 16.6])
	assert.ok(Math.hypot(mcu.x, mcu.y) <= 8, `MCU is ${Math.hypot(mcu.x, mcu.y)} mm from the centre`)
})

test("every chip and the added resistor get a fixed position", () => {
	const src = circuitFromContract(busyContract())
	for (const tag of src.match(/<(chip|resistor) [^>]*?(?=footprint)/g) ?? []) assert.match(tag, /pcbX=\{-?[\d.]+\} pcbY=\{-?[\d.]+\} pcbRotation=\{-?\d+\}/, tag)
})

test("ESP32-C3-MINI-1 gets the module land pattern with datasheet pin numbers", () => {
	const src = circuitFromContract(fixtureContract())
	assert.equal(src.match(/<smtpad /g)?.length, 53)
	assert.match(src, /name="U1"[^>]*pinLabels=\{\{[^}]*pin22: "GPIO8"/)
	assert.match(src, /pin23: "GPIO9"/)
	assert.match(src, /pin16: "GPIO10"/)
	assert.match(src, /pin3: "3V3"/)
	assert.match(src, /pin1: "GND"/)
})
