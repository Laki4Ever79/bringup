import { test } from "node:test"
import assert from "node:assert/strict"
import { parsePinsHeader, pinsHeader } from "../src/codegen/firmware.ts"
import { fixtureContract } from "./fixture.ts"

test("pins header defines one PIN_ per assignment and the revision", () => {
	const h = pinsHeader(fixtureContract())
	assert.match(h, /^#define PIN_I2C_SDA 8$/m)
	assert.match(h, /^#define PIN_I2C_SCL 9$/m)
	assert.match(h, /^#define BRINGUP_REVISION 6$/m)
})

test("signal names are upper-cased and non-alphanumerics become _", () => {
	const c = fixtureContract()
	c.values.pins = [{ signal: "led-1.k", gpio: 10, partRef: "D1", partPin: "K" }]
	assert.match(pinsHeader(c), /^#define PIN_LED_1_K 10$/m)
})

test("parsePinsHeader round-trips the fixture", () => {
	assert.deepEqual(parsePinsHeader(pinsHeader(fixtureContract())), { I2C_SDA: 8, I2C_SCL: 9 })
})

// The product firmware deep-sleeps between readings for the contract's period (requirements.dutyCycle.periodS).
test("pins.h carries the duty-cycle period from the contract, and leaves it to the template's default without one", () => {
	const c = fixtureContract()
	c.values.requirements = { ...c.values.requirements!, dutyCycle: { activeMs: 100, periodS: 300, sleepUa: 5 } }
	assert.match(pinsHeader(c), /^#define DUTY_PERIOD_S 300$/m)
	c.values.requirements = { ...c.values.requirements!, dutyCycle: { activeMs: 100, periodS: 120.4, sleepUa: 5 } }
	assert.match(pinsHeader(c), /^#define DUTY_PERIOD_S 120$/m, "whole seconds")
	assert.doesNotMatch(pinsHeader(fixtureContract()), /DUTY_PERIOD_S/)
})
