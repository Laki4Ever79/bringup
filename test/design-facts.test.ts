import { test } from "node:test"
import assert from "node:assert/strict"
import { designFacts } from "../src/agents/design-facts.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { fixtureContract } from "./fixture.ts"

// One source of facts for the reviewer and the designers (information asymmetry was behind every real-run blocker).
test("designFacts gives the chosen parts' catalog facts, the field meanings and the live power budget and duty-cycle check", () => {
	const c = fixtureContract()
	c.values.behavior = { blinkMs: 1000, tiltBlinkMs: 250, tiltDeg: 30 }
	c.values.rails![0].averageMa = 0.05
	c.values.requirements!.dutyCycle = { activeMs: 100, periodS: 60, sleepUa: 5 }
	const text = designFacts(c, "around 500 mAh").join("\n")
	assert.match(text, /## Part facts \(from the catalog\)\n- U1 ESP32-C3-MINI-1: .*3\.0–3\.6 V supply/)
	assert.match(text, /- Firmware \(product build of templates\/fw\)/)
	assert.match(text, /The behavior field is the bench demo build's blink and tilt settings, not the product's status LED/)
	assert.match(text, /## Power budget \(computed in code/)
	assert.match(text, /Estimated battery life: 500 mAh \//)
	assert.match(text, /Battery-life check \(computed in code from the duty cycle/)
})

test("battery-short: a live violation for the architect when even the stated averages miss the battery target", () => {
	const c = fixtureContract()
	c.values.requirements!.batteryLifeDays = 90
	c.values.requirements!.dutyCycle = { activeMs: 100, periodS: 60, sleepUa: 5 }
	c.values.rails = [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 500, loadMa: 120, averageMa: 0.5 }]
	const short = checkConsistency(c, {}, "around 500 mAh").filter((v) => v.kind === "battery-short")
	assert.equal(short.length, 1)
	assert.deepEqual([short[0].fields, short[0].affects], [["requirements", "rails", "parts"], ["architect"]])
	assert.match(short[0].message, /^the stated rail averages give 42 days of battery life, short of the 90-day target; the duty-cycle check/)
	c.values.rails[0].averageMa = 0.05
	assert.equal(checkConsistency(c, {}, "around 500 mAh").filter((v) => v.kind === "battery-short").length, 0, "met by the stated averages: not flagged")
})
