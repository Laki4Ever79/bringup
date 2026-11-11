// The pin solver (docs/mcu.md, Pins): what a design needs → pins and peripheral instances, from the profile alone.
import { test } from "node:test"
import assert from "node:assert/strict"
import { profileById } from "../src/mcu/profile.ts"
import { freeGpios, peripheralsFree, solvePins, type Need } from "../src/mcu/solver.ts"

const stm = profileById("stm32g031k8t6")!
const esp = profileById("esp32-c3-mini-1")!
const i2c = (group: string): Need[] => [
	{ signal: `${group}_SDA`, kind: "i2c", role: "SDA", group },
	{ signal: `${group}_SCL`, kind: "i2c", role: "SCL", group },
]

test("an I2C bus lands on one instance's SDA and SCL pins", () => {
	const r = solvePins(stm, i2c("I2C"))
	assert.ok(r.ok, r.ok ? "" : r.reason)
	const [sda, scl] = r.pins
	assert.equal(sda.instance, scl.instance)
	assert.ok(stm.pins.find((p) => p.index === sda.index)!.signals.includes(`${sda.instance}_SDA`))
	assert.ok(stm.pins.find((p) => p.index === scl.index)!.signals.includes(`${scl.instance}_SCL`))
})

test("asking for more buses than the chip has says which and how many", () => {
	const r = solvePins(stm, [...i2c("A"), ...i2c("B"), ...i2c("C")])
	assert.equal(r.ok, false)
	assert.match(r.ok ? "" : r.reason, /needs 3 I2C, the STM32G031K8T6 has 2 \(I2C1, I2C2\)/)
})

const uart = (group: string): Need[] => [
	{ signal: `${group}_TX`, kind: "uart", role: "TX", group },
	{ signal: `${group}_RX`, kind: "uart", role: "RX", group },
]

test("the console UART is not offered to a design, nor an instance whose only pins are the console's", () => {
	const r = solvePins(stm, uart("L1"))
	assert.ok(r.ok, r.ok ? "" : r.reason)
	assert.ok(r.pins.every((p) => p.instance === "USART1"), JSON.stringify(r.pins))
	assert.ok(r.pins.every((p) => p.index !== 2 && p.index !== 3))
	// LPUART1 comes out only on PA2/PA3 in LQFP32 (ST pin data), the console's pins: one UART left, not two.
	const two = solvePins(stm, [...uart("L1"), ...uart("L2")])
	assert.equal(two.ok, false)
	assert.match(two.ok ? "" : two.reason, /needs 2 UART, the STM32G031K8T6 has 1 \(USART1\); LPUART1 has no free pins, USART2 is the console/)
})

test("reserved pins (SWD, reset) are never assigned, even when every pin is asked for", () => {
	const needs: Need[] = Array.from({ length: 40 }, (_, i) => ({ signal: `G${i}`, kind: "gpio" }))
	const r = solvePins(stm, needs)
	assert.equal(r.ok, false)
	assert.match(r.ok ? "" : r.reason, /needs 40 GPIOs, the STM32G031K8T6 has \d+ free/)
	const some = solvePins(stm, needs.slice(0, 20))
	assert.ok(some.ok, some.ok ? "" : some.reason)
	for (const p of some.pins) assert.ok(![13, 14, 82].includes(p.index), `${p.pin} is reserved`)
})

test("taken pins stay taken; an ADC need gets an analog pin; a wake need a wake pin", () => {
	const r = solvePins(stm, [{ signal: "VSENSE", kind: "adc" }, { signal: "BUTTON", kind: "wake" }], [0, 1])
	assert.ok(r.ok, r.ok ? "" : r.reason)
	const adc = r.pins.find((p) => p.signal === "VSENSE")!
	assert.ok(adc.index !== 0 && adc.index !== 1)
	assert.ok(stm.pins.find((p) => p.index === adc.index)!.signals.some((s) => /^ADC\d*_IN\d+$/.test(s)))
	const espWake = solvePins(esp, [{ signal: "BUTTON", kind: "wake" }])
	assert.ok(espWake.ok && espWake.pins[0].index <= 5)
})

test("the ESP32-C3's GPIO matrix: any free pin carries any peripheral; its budget is as before", () => {
	const r = solvePins(esp, i2c("I2C"))
	assert.ok(r.ok, r.ok ? "" : r.reason)
	assert.deepEqual(freeGpios(esp), [4, 5, 6, 7, 3, 1, 0])
	assert.deepEqual(peripheralsFree(esp), { uart: 1, i2c: 1, spi: 1, i2s: 1, radio: 1 })
	assert.equal(peripheralsFree(stm).radio, 0)
	assert.equal(peripheralsFree(stm).i2c, 2)
	assert.equal(peripheralsFree(stm).uart, 1)
})
