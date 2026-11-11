// The pin map as a Zephyr overlay (docs/mcu.md, Zephyr), read back by the adopt devicetree reader.
import { test } from "node:test"
import assert from "node:assert/strict"
import { dtsPins } from "../src/adopt/firmware.ts"
import { profileById } from "../src/mcu/profile.ts"
import { zephyrOverlay } from "../src/mcu/zephyr.ts"
import { fromAdoptPin } from "../src/mcu/pins.ts"

const stmPins = [
	{ signal: "I2C_SDA", gpio: 23, partRef: "U2", partPin: "SDA" },
	{ signal: "I2C_SCL", gpio: 22, partRef: "U2", partPin: "SCL" },
	{ signal: "STATUS_LED", gpio: 5, partRef: "D1", partPin: "A" },
]

test("STM32G031: I2C1 on PB6/PB7 through hal_stm32's pinctrl labels, the LED under zephyr,user", () => {
	const r = zephyrOverlay(profileById("stm32g031k8t6")!, stmPins)
	assert.ok("overlay" in r, "error" in r ? r.error : "")
	assert.match(r.overlay, /&i2c1 \{\n\tpinctrl-0 = <&i2c1_scl_pb6 &i2c1_sda_pb7>;/)
	assert.match(r.overlay, /status-led-gpios = <&gpioa 5 GPIO_ACTIVE_HIGH>;/)
	assert.equal(r.board, "nucleo_g031k8")
})

test("pins that aren't one instance's are an error, not a wrong overlay", () => {
	const r = zephyrOverlay(profileById("stm32g031k8t6")!, [{ ...stmPins[0], gpio: 5 }, stmPins[1]])
	assert.ok("error" in r)
	assert.match(r.error, /I2C_SDA on PA5 and I2C_SCL on PB6 are not one I2C instance's pins/)
})

test("nRF52840: NRF_PSEL pinctrl that the adopt reader reads back to the same pins", () => {
	const pins = [
		{ signal: "I2C_SDA", gpio: 26, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 27, partRef: "U2", partPin: "SCL" },
		{ signal: "STATUS_LED", gpio: 36, partRef: "D1", partPin: "A" },
	]
	const nrf = profileById("nrf52840-mdbt50q")!
	const r = zephyrOverlay(nrf, pins)
	assert.ok("overlay" in r, "error" in r ? r.error : "")
	const back = dtsPins(r.overlay, "app.overlay")
	// The adopt reader numbers pins globally (nRF: 4000 + index); the profile converts back.
	const at = (n: string) => fromAdoptPin(nrf, back.find((p) => p.name === n)?.gpio ?? -1)
	assert.equal(at("I2C0_SDA"), 26)
	assert.equal(at("I2C0_SCL"), 27)
	assert.equal(at("STATUS_LED"), 36)
})
