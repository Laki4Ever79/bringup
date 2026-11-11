// One pin identity across vendors (docs/mcu.md, Pin index): the contract stores an index, the profile spells it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { profileById } from "../src/mcu/profile.ts"
import { mcuPinError, pinIndex, pinName } from "../src/mcu/pins.ts"

const stm = profileById("stm32g031k8t6")!
const esp = profileById("esp32-c3-mini-1")!

test("a pin index is spelled the chip's way", () => {
	assert.equal(pinName(stm, 5), "PA5")
	assert.equal(pinName(stm, 19), "PB3")
	assert.equal(pinName(stm, 82), "PF2")
	assert.equal(pinName(esp, 4), "GPIO4")
	// No profile (a contract from before profiles, or an unknown part): the ESP32 spelling it always had.
	assert.equal(pinName(null, 4), "GPIO4")
})

test("a pin name in any vendor's spelling reads back as its index", () => {
	assert.equal(pinIndex(stm, "PB3"), 19)
	assert.equal(pinIndex(stm, "pa5"), 5)
	assert.equal(pinIndex(esp, "GPIO9"), 9)
	assert.equal(pinIndex(esp, "IO9"), 9)
	assert.equal(pinIndex(null, "GPIO7"), 7)
	assert.equal(pinIndex(null, "P1.04"), 36)
	assert.equal(pinIndex(null, "GP4"), 4)
	assert.equal(pinIndex(stm, "PZ9"), null)
})

test("a pin the chip doesn't have is a named error", () => {
	assert.match(mcuPinError(stm, 200) ?? "", /STM32G031K8T6 has no pin with index 200/)
	assert.equal(mcuPinError(stm, 5), null)
	assert.match(mcuPinError(stm, 13) ?? "", /PA13 is reserved \(swd\)/)
	assert.equal(mcuPinError(null, 4), null)
})
