// A bare chip on a Bringup board (docs/mcu.md, Board): footprint, pad labels, power and support parts from its profile.
import { test } from "node:test"
import assert from "node:assert/strict"
import { circuitFromContract, generatedNets, supportParts } from "../src/codegen/circuit.ts"
import { chipPartPins, chipPinLabels } from "../src/mcu/board.ts"
import { profileById } from "../src/mcu/profile.ts"
import { fixtureContract } from "./fixture.ts"

const stm = profileById("stm32g031k8t6")!

// The fixture's logger on an STM32G031K8: SHT40 on I2C1 (PB7 SDA = 23, PB6 SCL = 22), LED on PA5.
function stmContract() {
	const s = fixtureContract()
	s.values.parts = s.values.parts!.map((p) => (p.role === "mcu" ? { ...p, mpn: "STM32G031K8T6", lcsc: null, footprint: "", pins: chipPartPins(stm) } : p))
	s.values.pins = [
		{ signal: "I2C_SDA", gpio: 23, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 22, partRef: "U2", partPin: "SCL" },
		{ signal: "STATUS_LED", gpio: 5, partRef: "D1", partPin: "A" },
	]
	return s
}

test("pad labels follow ST's LQFP32 pinout, one per pad", () => {
	const labels = chipPinLabels(stm)
	assert.equal(labels.pin1, "PB9")
	assert.equal(labels.pin4, "VDD")
	assert.equal(labels.pin5, "VSS")
	assert.equal(labels.pin6, "PF2")
	assert.equal(labels.pin12, "PA5")
	assert.equal(Object.keys(labels).length, 32) // the NC entries at pads 19 and 21 are remap variants of PA9/PA10
})

test("the STM32 board uses the package footprint, its labels and the chip's pin names", () => {
	const src = circuitFromContract(stmContract())
	assert.match(src, /<chip name="U1" pinLabels=\{\{"pin1":"PB9"[^}]*\}\}[^>]*footprint="lqfp32_w7\.05mm_h7\.05mm_p0\.8mm_pl1\.475mm_pw0\.55mm"/)
	assert.match(src, /from="\.U1 > \.PB7" to="net\.I2C_SDA"/)
	assert.match(src, /from="\.U1 > \.PA5" to="net\.STATUS_LED"/)
	assert.doesNotMatch(src, /GPIO/)
})

test("its supply and ground pads reach the rails, with the profile's decoupling", () => {
	const s = stmContract()
	const nets = generatedNets(s)
	assert.ok(nets.get("GND")?.includes("U1.VSS"))
	assert.ok(nets.get("V3V3")?.includes("U1.VDD"))
	const jobs = supportParts(s).map((x) => x.job)
	assert.ok(jobs.some((j) => /U1 VDD\/VDDA decoupling/.test(j)), jobs.join("\n"))
	assert.ok(jobs.some((j) => /U1 NRST \(PF2\)/.test(j)), jobs.join("\n"))
	// No ESP32 strap pull-up or recovery pads: the STM32 is flashed over SWD.
	assert.ok(!jobs.some((j) => /download boot/.test(j)), jobs.join("\n"))
})
