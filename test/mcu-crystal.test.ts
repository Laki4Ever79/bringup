// A bare chip's crystal on a Bringup board (profile clock.crystal): the STM32F103C8T6's 8 MHz HSE, its load capacitors,
// and the 1.5k D+ pull-up its USB needs.
import { test } from "node:test"
import assert from "node:assert/strict"
import { boardCrystal, boardParts, circuitFromContract, generatedNets, placeParts, supportParts } from "../src/codegen/circuit.ts"
import { chipCrystal, chipPartPins } from "../src/mcu/board.ts"
import { profileById } from "../src/mcu/profile.ts"
import { fixtureContract } from "./fixture.ts"

const f103 = profileById("stm32f103c8t6")!

// The fixture's logger on an STM32F103C8: SHT40 on I2C1 (PB7 SDA = 23, PB6 SCL = 22), LED on PA5, USB-C J1 (PA11/PA12
// left free, so the generator wires them).
function f103Contract() {
	const s = fixtureContract()
	s.values.parts = s.values.parts!.map((p) => (p.role === "mcu" ? { ...p, mpn: "STM32F103C8T6", lcsc: "C8734", footprint: "", pins: chipPartPins(f103) } : p))
	s.values.pins = [
		{ signal: "I2C_SDA", gpio: 23, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 22, partRef: "U2", partPin: "SCL" },
		{ signal: "STATUS_LED", gpio: 5, partRef: "D1", partPin: "A" },
	]
	return s
}

test("the F103 profile is buildable and names its crystal on PD0/PD1", () => {
	assert.equal(f103.board.supported, true)
	const x = chipCrystal(f103)!
	assert.equal(x.inPin, "PD0")
	assert.equal(x.outPin, "PD1")
	assert.equal(x.crystal.lcsc, "C400090")
	assert.equal(x.loadCap.lcsc, "C1548")
	// The RP2040 has its crystal data but stays unsupported (it also needs a QSPI flash).
	const rp = profileById("rp2040")!
	assert.equal(rp.board.supported, false)
	assert.equal(rp.clock?.crystal?.lcsc, "C133337")
})

test("the circuit has Y1 with the SMD3225-4P footprint, wired to OSC_IN and OSC_OUT", () => {
	const src = circuitFromContract(f103Contract())
	assert.match(src, /<chip name="Y1" manufacturerPartNumber="TAXM8M4RDBCCT2T"[^\n]*footprint=\{<footprint><smtpad portHints=\{\["pin1"\]\} pcbX="-1.1mm" pcbY="-0.85mm" width="1.4mm" height="1.2mm"/)
	assert.match(src, /from="\.Y1 > \.pin1" to="\.U1 > \.PD0"/)
	assert.match(src, /from="\.Y1 > \.pin3" to="\.U1 > \.PD1"/)
	const gnd = generatedNets(f103Contract()).get("GND") ?? []
	assert.ok(gnd.includes("Y1.pin2") && gnd.includes("Y1.pin4"), gnd.join(" "))
})

test("two 15 pF load capacitors from the crystal pins to GND", () => {
	const loads = supportParts(f103Contract()).filter((x) => /Y1 load capacitor/.test(x.job))
	assert.equal(loads.length, 2)
	assert.deepEqual(loads.map((x) => ("ref" in x.a ? x.a.pin : "")).sort(), ["pin1", "pin3"])
	for (const x of loads) {
		assert.equal(x.spec.value, "15pF")
		assert.equal(x.spec.lcsc, "C1548")
		assert.deepEqual(x.b, { net: "GND" })
	}
	const src = circuitFromContract(f103Contract())
	for (const x of loads) assert.match(src, new RegExp(`<capacitor name="${x.ref}" capacitance="15pF"`))
})

test("Y1 and its capacitors are in the BOM and placed next to the chip", () => {
	const s = f103Contract()
	const bom = boardParts(s)
	const y1 = bom.find((p) => p.ref === "Y1")
	assert.ok(y1)
	assert.equal(y1.lcsc, "C400090")
	assert.equal(y1.mpn, "TAXM8M4RDBCCT2T")
	assert.equal(bom.filter((p) => p.lcsc === "C1548").length, 2)
	const placed = placeParts(s)
	assert.ok(placed.length >= bom.length, "every BOM part has a spot")
	const u1 = placed.find((p) => p.ref === "U1")!, y = placed.find((p) => p.ref === "Y1")!
	assert.ok(Math.hypot(y.x - u1.x, y.y - u1.y) < 12, `Y1 at ${y.x},${y.y}, U1 at ${u1.x},${u1.y}`)
	assert.equal(boardCrystal(s)?.ref, "Y1")
})

test("the 1.5k D+ pull-up is there when USB-C is wired to PA11/PA12, not when the pins are taken", () => {
	const s = f103Contract()
	const pull = supportParts(s).find((x) => /USB D\+ pull-up/.test(x.job))
	assert.ok(pull)
	assert.equal(pull.spec.value, "1.5k")
	assert.deepEqual(pull.a, { ref: "U1", pin: "PA12" })
	assert.deepEqual(pull.b, { net: "V3V3" })
	assert.ok(generatedNets(s).get("USB_DP")?.includes("U1.PA12"))
	// PA12 used for something else: no USB, so no pull-up.
	s.values.pins = [...s.values.pins!, { signal: "STATUS_LED2", gpio: 12, partRef: "D1", partPin: "A" }]
	assert.ok(!supportParts(s).some((x) => /USB D\+ pull-up/.test(x.job)))
})

test("a chip without a crystal (STM32G031) gets no Y1", () => {
	const g0 = profileById("stm32g031k8t6")!
	const s = fixtureContract()
	s.values.parts = s.values.parts!.map((p) => (p.role === "mcu" ? { ...p, mpn: "STM32G031K8T6", lcsc: null, footprint: "", pins: chipPartPins(g0) } : p))
	s.values.pins = [{ signal: "STATUS_LED", gpio: 5, partRef: "D1", partPin: "A" }]
	assert.equal(boardCrystal(s), null)
	assert.doesNotMatch(circuitFromContract(s), /Y1/)
})
