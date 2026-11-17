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
	assert.deepEqual(fit, ["esp32-c3-mini-1", "esp32-s3-mini-1", "esp32-wroom-32e", "nrf52840-mdbt50q", "stm32wb55cgu6"])
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

test("a CNC motion controller: only chips that run grblHAL or FluidNC fit, and a named firmware narrows it", () => {
	const steppers: Need[] = [
		...["X", "Y", "Z"].flatMap((a) => [{ signal: `${a}_STEP`, kind: "gpio" as const }, { signal: `${a}_DIR`, kind: "gpio" as const }]),
		{ signal: "LIMIT_X", kind: "gpio" },
	]
	const any = rankMcus({ needs: steppers, motion: true })
	const fit = any.filter((x) => x.fits).map((x) => x.id).sort()
	assert.deepEqual(fit, ["esp32-wroom-32e", "rp2350a", "stm32f411ceu6", "stm32f446ret6"])
	const c3 = any.find((x) => x.id === "esp32-c3-mini-1")!
	assert.equal(c3.fits, false)
	assert.ok(c3.why.some((w) => /^motion: no CNC motion firmware/.test(w)), c3.why.join("; "))
	assert.ok(any.find((x) => x.id === "stm32f411ceu6")!.why.includes("motion: runs grblhal (FPU)"))
	// FluidNC: the ESP32 and the RP2350 (its rp2350 env), not the STM32F4s.
	const fluid = rankMcus({ needs: steppers, motion: "fluidnc" }).filter((x) => x.fits).map((x) => x.id).sort()
	assert.deepEqual(fluid, ["esp32-wroom-32e", "rp2350a"])
	// Not asked: motion changes nothing.
	assert.deepEqual(rankMcus({ needs: steppers }).map((x) => x.fits), rankMcus({ needs: steppers, motion: false }).map((x) => x.fits))
})
