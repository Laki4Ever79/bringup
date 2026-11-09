// Download boot on the ESP32-C3 needs GPIO8 high at reset as well as GPIO9 low (TRM v1.4, Table 7.2-1), and GPIO8
// floats with no pull-up on the module: the generator fits one, and a signal that holds it low is a violation (9 Nov).
import { test } from "node:test"
import assert from "node:assert/strict"
import { downloadStrap, supportParts } from "../src/codegen/circuit.ts"
import { downloadPinLow } from "../src/contract/consistency.ts"
import { addedForYou } from "../src/contract/added.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}
const strapPullups = (s: ReturnType<typeof logger>) => supportParts(s).filter((sp) => sp.job.startsWith("U1.GPIO8 pull-up"))

test("the logger's I2C pull-up already holds GPIO8 high: no extra part, and the report says so", () => {
	const s = logger()
	assert.deepEqual(downloadStrap(s) && { pin: downloadStrap(s)!.pin, gpio: downloadStrap(s)!.gpio }, { pin: "GPIO8", gpio: 8 })
	assert.equal(strapPullups(s).length, 0)
	assert.match(addedForYou(s).find((i) => i.id === "recovery-pads")!.cost, /already pulled up by the I2C bus/)
})

test("an unused GPIO8 gets a 10k pull-up straight to the module's pin (the beacon in system run 5)", () => {
	const s = logger()
	s.values.pins = s.values.pins!.map((p) => (p.gpio === 8 ? { ...p, gpio: 6 } : p))
	const [pu] = strapPullups(s)
	assert.ok(pu, "a pull-up on GPIO8")
	assert.equal(pu.spec.value, "10k")
	assert.deepEqual(pu.a, { ref: "U1", pin: "GPIO8" })
	assert.ok("net" in pu.b && pu.b.net !== "GND", "to the 3V3 supply")
	assert.match(addedForYou(s).find((i) => i.id === "recovery-pads")!.cost, /10k pull-up on U1\.GPIO8/)
	assert.deepEqual(downloadPinLow(s), [])
})

test("a button on GPIO8 keeps its pull-up on its net; an LED there is a violation and gets none", () => {
	const s = logger()
	s.values.pins = s.values.pins!.map((p) => (p.gpio === 8 ? { ...p, gpio: 6 } : p))
	s.values.pins.push({ signal: "BUTTON", gpio: 8, partRef: "SW1", partPin: "A" })
	assert.deepEqual(strapPullups(s)[0]?.a, { net: "BUTTON" })
	assert.deepEqual(downloadPinLow(s), [])
	s.values.pins = s.values.pins.filter((p) => p.signal !== "BUTTON" && p.signal !== "LED")
	s.values.pins.push({ signal: "LED", gpio: 8, partRef: "D1", partPin: "A" })
	assert.equal(strapPullups(s).length, 0, "no pull-up through the LED")
	const v = downloadPinLow(s)
	assert.equal(v.length, 1)
	assert.match(v[0].message, /U1 GPIO8 must read high at reset.*assigned to LED \(D1\.A\), an LED/)
	assert.deepEqual(v[0].affects, ["architect"])
})

test("a board that never deep-sleeps has no recovery pads, so nothing is added for GPIO8", () => {
	const s = logger()
	delete s.values.requirements!.dutyCycle
	s.values.pins = s.values.pins!.map((p) => (p.gpio === 8 ? { ...p, gpio: 6 } : p))
	assert.equal(downloadStrap(s), null)
	assert.equal(strapPullups(s).length, 0)
})
