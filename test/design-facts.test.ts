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
	assert.match(text, /## Part facts \(from the catalog\)\n- U1 ESP32-C3-MINI-1: .*3.0–3.6 V supply.*CPU running at 160 MHz with the radio off 23–28 mA \(Table 5-8\); radio receiving 84 mA.*The datasheet gives no Bluetooth LE current figure/)
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

// Real beacon run K: a second LED with role "led" (not charge-led) and two capacitors the generator never used sat on
// the parts list connected to nothing; only the final review noticed. Now a live violation for the architect.
test("part-unconnected: a part no pin uses and the board generator doesn't wire is a live violation", () => {
	const c = fixtureContract()
	assert.deepEqual(checkConsistency(c, {}).filter((v) => v.kind === "part-unconnected"), [], "the fixture's parts are all connected")
	c.values.parts = [
		...c.values.parts!,
		{ ref: "D2", role: "led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: ["A", "K"] },
		{ ref: "C9", role: "capacitor", mpn: "CL10A106KP8NNNC", lcsc: "C19702", footprint: "0603", pins: ["pin1", "pin2"] },
	]
	const found = checkConsistency(c, {}).filter((v) => v.kind === "part-unconnected")
	assert.deepEqual(found.map((v) => [v.message.split(" ")[0], v.fields, v.affects]), [["D2", ["parts", "pins"], ["architect"]], ["C9", ["parts", "pins"], ["architect"]]])
	assert.match(found[0].message, /a charging-state LED needs role charge-led$/)
	assert.match(found[1].message, /reuses a contract part only with the same LCSC number: .*1k C11702/)
})
