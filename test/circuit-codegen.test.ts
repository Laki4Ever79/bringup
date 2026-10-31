import assert from "node:assert/strict"
import { test } from "node:test"
import { boardParts, circuitFromContract, MOUNTING_HOLE, mountingHoles, placeParts, type Placed } from "../src/codegen/circuit.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
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

test("LED uses the contract's 1k resistor when there is one", () => {
	const s = fixtureContract()
	s.values.parts!.push({ ref: "R7", role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: ["pin1", "pin2"] })
	const src = circuitFromContract(s)
	assert.doesNotMatch(src, /resistance="1k"/)
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

// The mock run's design: charger, battery connector and every support passive are in the contract.
function loggerContract(widthMm = LOGGER_DESIGN.outline.widthMm) {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN), outline: { ...LOGGER_DESIGN.outline, widthMm } }
	s.values.pins!.push({ signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" })
	return s
}

// The resistor or capacitor whose first pin traces to `from`, e.g. ".J1 > .pin8".
function partAt(src: string, from: string): string {
	const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const m = new RegExp(`from="${esc}" to="\\.([A-Z]+\\d+) > \\.pin1"`).exec(src) ?? new RegExp(`from="\\.([A-Z]+\\d+) > \\.pin1" to="${esc}"`).exec(src)
	assert.ok(m, `nothing traces to ${from}`)
	return m![1]
}

const onNet = (src: string, end: string, net: string) => assert.match(src, new RegExp(`from="${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" to="net\\.${net}"`), `${end} is not on ${net}`)

test("USB-C CC1 and CC2 each go to GND through a 5.1k", () => {
	const src = circuitFromContract(fixtureContract())
	for (const pad of ["pin8", "pin14"]) {
		const r = partAt(src, `.J1 > .${pad}`)
		assert.match(src, new RegExp(`<resistor name="${r}" resistance="5.1k"`))
		onNet(src, `.${r} > .pin2`, "GND")
	}
})

test("USB D+ and D- reach GPIO19 and GPIO18 when the MCU lists them", () => {
	const src = circuitFromContract(loggerContract())
	for (const end of [".J1 > .pin10", ".J1 > .pin12", ".U1 > .GPIO19"]) onNet(src, end, "USB_DP")
	for (const end of [".J1 > .pin9", ".J1 > .pin11", ".U1 > .GPIO18"]) onNet(src, end, "USB_DN")
	assert.doesNotMatch(circuitFromContract(fixtureContract()), /USB_D/, "fixture MCU does not list GPIO18/19")
})

test("USB D+/D- are skipped when the contract uses GPIO18 or GPIO19 for something else", () => {
	const s = loggerContract()
	s.values.pins!.push({ signal: "EXTRA", gpio: 19, partRef: "D1", partPin: "A" })
	assert.doesNotMatch(circuitFromContract(s), /USB_D/)
})

// Real run 12: the agents assigned USB_DN → J1.DN and USB_DP → J1.DP themselves. The USB-C footprint has no port
// called DN or DP, only pads, so every board build failed until the agents gave up.
test("contract pins on the USB-C connector go to its pads (D- pin9+pin11, D+ pin10+pin12), not to a DN/DP port", () => {
	const s = loggerContract()
	s.values.pins!.push({ signal: "USB_DN", gpio: 18, partRef: "J1", partPin: "DN" }, { signal: "USB_DP", gpio: 19, partRef: "J1", partPin: "DP" })
	const src = circuitFromContract(s)
	assert.doesNotMatch(src, /\.J1 > \.D[NP]"/)
	for (const end of [".J1 > .pin10", ".J1 > .pin12", ".U1 > .GPIO19"]) onNet(src, end, "USB_DP")
	for (const end of [".J1 > .pin9", ".J1 > .pin11", ".U1 > .GPIO18"]) onNet(src, end, "USB_DN")
	assert.equal(src.match(/<net name="USB_DP" \/>/g)?.length, 1, "one USB_DP net, from the contract")
})

test("charger: VBUS in, VBAT out to the battery and the LDO, PROG to GND through 4.7k", () => {
	const src = circuitFromContract(loggerContract())
	for (const end of [".J1 > .pin6", ".J1 > .pin15", ".U4 > .VCC"]) onNet(src, end, "VBUS")
	for (const end of [".U4 > .BAT", ".J2 > .VBAT", ".U3 > .VIN", ".U3 > .EN"]) onNet(src, end, "VBAT")
	for (const end of [".U4 > .GND", ".J2 > .GND"]) onNet(src, end, "GND")
	const prog = partAt(src, ".U4 > .PROG")
	assert.equal(LOGGER_DESIGN.parts.find((p) => p.ref === prog)?.lcsc, "C25900", "PROG resistor is the contract's 4.7k")
	onNet(src, `.${prog} > .pin2`, "GND")
	assert.doesNotMatch(src, /from="\.U3 > \.VIN" to="net\.VBUS"/, "LDO must run from the battery, not VBUS")
})

test("module EN is tied to 3V3", () => {
	onNet(circuitFromContract(loggerContract()), ".U1 > .EN", "V3V3")
})

test("I2C lines get 10k pull-ups to 3V3", () => {
	const src = circuitFromContract(loggerContract())
	for (const signal of ["I2C_SDA", "I2C_SCL"]) {
		const r = partAt(src, `net.${signal}`)
		assert.equal(LOGGER_DESIGN.parts.find((p) => p.ref === r)?.lcsc, "C25744")
		onNet(src, `.${r} > .pin2`, "V3V3")
	}
})

test("bypass caps: 1uF on VBUS and VBAT, 10uF on 3V3", () => {
	const src = circuitFromContract(loggerContract())
	const lcsc = (net: string) => LOGGER_DESIGN.parts.find((p) => p.ref === partAt(src, `net.${net}`) && p.role === "capacitor")?.lcsc
	assert.equal(lcsc("VBUS"), "C52923")
	assert.equal(lcsc("VBAT"), "C52923")
	assert.equal(lcsc("V3V3"), "C19702")
})

test("the mock logger needs no added parts, and boardParts lists every part with its LCSC number", () => {
	const s = loggerContract()
	assert.doesNotMatch(circuitFromContract(s), /<(resistor|capacitor) /, "codegen added a part the contract lacks")
	const parts = boardParts(s)
	assert.deepEqual(parts.map((p) => p.ref).sort(), LOGGER_DESIGN.parts.map((p) => p.ref).sort())
	for (const p of parts) assert.ok(p.lcsc, `${p.ref} has no LCSC number`)
})

test("boardParts includes the parts codegen adds, with their LCSC numbers", () => {
	const added = boardParts(fixtureContract()).filter((p) => p.added)
	assert.deepEqual(added.map((p) => p.lcsc).sort(), ["C11702", "C25744", "C25744", "C25905", "C25905"])
})

test("button: A on its GPIO, B to GND, on opposite sides of the switch (pads 1 and 3)", () => {
	const s = fixtureContract()
	s.values.parts!.push({ ref: "SW1", role: "button", mpn: "TS-1187A-B-A-B", lcsc: "C318884", footprint: "pushbutton", pins: ["A", "B"] })
	s.values.pins!.push({ signal: "BUTTON", gpio: 3, partRef: "SW1", partPin: "A" })
	const src = circuitFromContract(s)
	assert.match(src, /name="SW1" pinLabels=\{\{ pin1: "A", pin3: "B" \}\}/)
	onNet(src, ".SW1 > .A", "BUTTON")
	onNet(src, ".SW1 > .B", "GND")
})

test("a USB-C part is never given sequential pin labels", () => {
	const src = circuitFromContract(loggerContract())
	assert.doesNotMatch(src, /name="J1"[^>]*pinLabels/)
})

test("placement: the complete logger fits with a 1.5 mm gap at every swept width", () => {
	for (const w of [45, 50, 55, 60, 65, 70]) {
		const s = loggerContract(w)
		const boxes = placeParts(s)
		for (const p of s.values.parts!) assert.ok(boxes.some((b) => b.ref === p.ref), `${p.ref} not placed at ${w} mm`)
		assertSpaced(boxes, w, s.values.outline!.heightMm)
	}
})

test("a 3-pin LDO without EN: VIN on the battery, VOUT on 3V3, GND on GND", () => {
	const s = loggerContract()
	s.values.parts = s.values.parts!.map((p) => (p.role === "ldo" ? { ref: "U3", role: "ldo", mpn: "XC6206P332MR-G", lcsc: "C5446", footprint: "sot23", pins: ["GND", "VOUT", "VIN"] } : p))
	const src = circuitFromContract(s)
	assert.match(src, /name="U3" pinLabels=\{\{ pin1: "GND", pin2: "VOUT", pin3: "VIN" \}\}[^>]*footprint="sot23"/)
	onNet(src, ".U3 > .VIN", "VBAT")
	onNet(src, ".U3 > .VOUT", "V3V3")
	onNet(src, ".U3 > .GND", "GND")
	assert.doesNotMatch(src, /\.U3 > \.EN/)
	const boxes = placeParts(s)
	assertSpaced(boxes, s.values.outline!.widthMm, s.values.outline!.heightMm)
})

test("generatedNets lists the power and USB nets the generator wires, as REF.pin ends", async () => {
	const { generatedNets } = await import("../src/codegen/circuit.ts")
	const nets = generatedNets(loggerContract())
	assert.deepEqual(nets.get("USB_DP")?.sort(), ["J1.pin10", "J1.pin12", "U1.GPIO19"])
	assert.deepEqual(nets.get("USB_DN")?.sort(), ["J1.pin11", "J1.pin9", "U1.GPIO18"])
	assert.ok(nets.get("VBAT")!.includes("U4.BAT") && nets.get("VBAT")!.includes("U3.VIN"))
	assert.ok(nets.get("GND")!.includes("R2.pin2"), "CC1 resistor's GND end")
	assert.ok(!nets.has("VBUS") || nets.get("VBUS")!.includes("U4.VCC"))
	// The generator emits exactly these nets.
	const src = circuitFromContract(loggerContract())
	for (const [net, ends] of nets) for (const end of ends) onNet(src, `.${end.replace(".", " > .")}`, net)
})

test("charge LED: anode on VBUS, cathode through a 1k to the charger's CHRG, so it lights while charging", () => {
	const s = loggerContract()
	const led = s.values.parts!.find((p) => p.role === "charge-led")
	assert.ok(led, "the mock logger has a charge LED")
	const src = circuitFromContract(s)
	onNet(src, `.${led!.ref} > .A`, "VBUS")
	const r = partAt(src, `.${led!.ref} > .K`)
	assert.equal(s.values.parts!.find((p) => p.ref === r)?.lcsc, "C11702", "a 1k series resistor")
	assert.match(src, new RegExp(`from="\\.U4 > \\.CHRG" to="\\.${r} > \\.pin2"`))
	assert.notEqual(r, partAt(src, ".D1 > .K"), "the status LED keeps its own resistor")
})

test("a charge LED with no charger to drive it is left unwired", () => {
	const s = fixtureContract()
	s.values.parts!.push({ ref: "D2", role: "charge-led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: ["A", "K"] })
	const src = circuitFromContract(s)
	assert.doesNotMatch(src, /\.D2 > \./)
})

test("mounting holes: four M2 holes, 3 mm in from each corner", () => {
	const holes = mountingHoles(fixtureContract())
	assert.deepEqual(holes.map((h) => [h.ref, h.x, h.y, h.diameterMm]), [
		["H1", -22, -12, 2.2],
		["H2", 22, -12, 2.2],
		["H3", -22, 12, 2.2],
		["H4", 22, 12, 2.2],
	])
})

test("mounting holes are drilled on the board and no part sits on their keep-out", () => {
	for (const s of [fixtureContract(), withLdo(), busyContract()]) {
		const src = circuitFromContract(s)
		const holes = mountingHoles(s)
		for (const h of holes) assert.ok(src.includes(`<hole pcbX={${h.x}} pcbY={${h.y}} diameter="2.2mm" />`), `${h.ref} not in the board source`)
		for (const b of placeParts(s)) {
			for (const h of holes) {
				const gap = Math.max(Math.abs(b.x - h.x) - (b.w + MOUNTING_HOLE.keepoutMm) / 2, Math.abs(b.y - h.y) - (b.h + MOUNTING_HOLE.keepoutMm) / 2)
				assert.ok(gap >= 0, `${b.ref} overlaps ${h.ref}'s keep-out by ${-gap} mm`)
			}
		}
	}
})

test("a connector in a corner drops that corner's hole instead of overlapping it", () => {
	const s = fixtureContract()
	s.values.connectors = [{ ref: "J1", kind: "usb-c", edge: "bottom", offsetMm: 6, widthMm: 9, heightMm: 3.5 }]
	assert.deepEqual(mountingHoles(s).map((h) => h.ref), ["H2", "H3", "H4"])
})

test("every contract part carries its MPN onto the board, so a check can compare what was placed", () => {
	const s = fixtureContract()
	const src = circuitFromContract(s)
	for (const p of s.values.parts!) assert.match(src, new RegExp(`name="${p.ref}"[^\\n]*manufacturerPartNumber="${p.mpn.replace(/[()]/g, "\\$&")}"`), p.ref)
})
