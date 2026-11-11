// Choosing the MCU on equal terms (docs/mcu.md): same tests and same score terms for every vendor's chip.
import { test } from "node:test"
import assert from "node:assert/strict"
import { rankMcus } from "../src/mcu/select.ts"
import type { Need } from "../src/mcu/solver.ts"

const sensor: Need[] = [
	{ signal: "I2C_SDA", kind: "i2c", role: "SDA", group: "I2C" },
	{ signal: "I2C_SCL", kind: "i2c", role: "SCL", group: "I2C" },
	{ signal: "STATUS_LED", kind: "gpio" },
]

test("a BLE design: only chips with BLE fit", () => {
	const r = rankMcus({ needs: sensor, radio: ["ble"] })
	const fit = r.filter((x) => x.fits).map((x) => x.id).sort()
	assert.deepEqual(fit, ["esp32-c3-mini-1", "nrf52840-mdbt50q", "stm32wb55cgu6"])
	// The one Bringup can build a board for today ranks first.
	assert.equal(r[0].id, "esp32-c3-mini-1")
	assert.ok(r.find((x) => x.id === "stm32g031k8t6")!.why.includes("radio: no ble"))
})

test("a wired sensor on a battery: an STM32 ranks above the ESP32-C3 on sleep current and price", () => {
	const r = rankMcus({ needs: sensor, battery: true })
	const at = (id: string) => r.findIndex((x) => x.id === id)
	assert.ok(at("stm32g031k8t6") < at("esp32-c3-mini-1"), r.map((x) => `${x.id} ${x.score}`).join(", "))
	assert.equal(r[0].id, "stm32g031k8t6")
	for (const x of r) for (const w of x.why.slice(1)) assert.match(w, /\d/, `${x.id}: ${w}`)
})

test("the ranking is stable and every chip is ranked, none dropped", () => {
	const a = rankMcus({ needs: sensor })
	const b = rankMcus({ needs: sensor })
	assert.deepEqual(a, b)
	assert.ok(a.length >= 7)
})
