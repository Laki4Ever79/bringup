// The four engineer decisions from real run 3 (7 Nov 2026), agreed 8 Nov: phone use and the charger's drain count in
// the battery budget, a deep-sleeping board gets a recovery BOOT button, and the reviewer sees its earlier findings.
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkConsistency } from "../src/contract/consistency.ts"
import { dutyCycleCheckLines, estimatePower, PHONE_CONNECTIONS_PER_DAY, powerBudgetLines } from "../src/contract/power.ts"
import { circuitFromContract, recoveryBootNet, recoveryBootPin, recoveryPads, supportParts } from "../src/codegen/circuit.ts"
import { recoveryFactLines } from "../src/agents/design-facts.ts"
import { earlierReviewLines } from "../src/agents/reviewer.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

test("phone use is counted in the battery life, as a stated assumption", () => {
	const s = logger()
	const e = estimatePower(s, "500 mAh")
	assert.ok(e.phone, "the logger reports over GATT, so a phone reads it")
	// 1 connection × 30 s × 86 mA (module BLE receive) = 2580 mC a day
	assert.equal(PHONE_CONNECTIONS_PER_DAY, 1)
	assert.ok(Math.abs(e.phone.averageMa - 2580 / 86400) < 1e-9)
	assert.match(e.phone.how, /an assumption/)
	assert.ok(powerBudgetLines(e).some((l) => /^- Phone use: .*counted in the battery life/.test(l)))
	const check = dutyCycleCheckLines(e, s)
	assert.ok(check.some((l) => l.startsWith("- Phone use:")))
	assert.ok(!check.some((l) => /which this average leaves out/.test(l)))
	const wifi = logger()
	wifi.values.connectivity = { radio: "wifi", report: ["mqtt"], uploadPeriodS: 28800, updates: "none" }
	assert.equal(estimatePower(wifi, "500 mAh").phone, null, "no GATT on Wi-Fi")
})

test("the charger's draw on the cell with USB unplugged is counted, like the regulator's", () => {
	const s = logger()
	const e = estimatePower(s, "500 mAh")
	assert.equal(e.chargerDrainUa, 6)
	assert.equal(e.chargers[0].maxUa, 10)
	const without = estimatePower({ ...s, values: { ...s.values, parts: s.values.parts!.filter((p) => p.role !== "charger") } }, "500 mAh")
	assert.ok(e.days! < without.days!)
	assert.ok(powerBudgetLines(e).some((l) => /Charger's draw .* 6 µA/.test(l)))
	assert.ok(dutyCycleCheckLines(e, s).some((l) => /6 µA \(charger's draw with USB unplugged/.test(l)))
})

test("a deep-sleeping ESP32-C3 board gets BOOT and GND pads on the bottom, and says how to use them", () => {
	const s = logger()
	assert.equal(recoveryBootPin(s)?.pin, "GPIO9")
	// The logger's I2C_SCL shares GPIO9: pulled up, it reads high at reset, so the BOOT pad joins that net.
	assert.equal(recoveryBootNet(s), "I2C_SCL")
	const { placed, unplaced } = recoveryPads(s)
	assert.deepEqual(unplaced, [])
	assert.deepEqual(placed.map((p) => [p.ref, p.net]), [["TPR1", "I2C_SCL"], ["TPR2", "GND"]])
	assert.ok(Math.hypot(placed[0].x - placed[1].x, placed[0].y - placed[1].y) < 6, "side by side, for tweezers")
	assert.ok(!supportParts(s).some((sp) => sp.added && !["resistor", "capacitor"].includes(sp.spec.kind)), "no part added")
	const tsx = circuitFromContract(s)
	assert.match(tsx, /<testpoint name="TPR1" [^>]*layer="bottom"/)
	assert.match(tsx, /from="\.TPR1 > \.pin1" to="net\.I2C_SCL"/)
	assert.match(recoveryFactLines(s)[0], /ROM downloader/)
	assert.ok(!checkConsistency(s, {}).some((v) => v.kind === "boot-pin-taken"))
	// Without a signal on the pin, the pad gets its own BOOT net from the module's GPIO9.
	const free = logger()
	free.values.pins = free.values.pins!.map((p) => (p.gpio === 9 ? { ...p, gpio: 4 } : p))
	assert.equal(recoveryBootNet(free), "BOOT")
	assert.match(circuitFromContract(free), /from="\.U1 > \.GPIO9" to="net\.BOOT"/)
	const awake = logger()
	delete awake.values.requirements!.dutyCycle
	assert.equal(recoveryBootPin(awake), null, "no deep sleep, no pads")
	assert.deepEqual(recoveryPads(awake).placed, [])
})

test("a signal on the boot pin is a violation, and the pads are left off", () => {
	const s = logger()
	s.values.pins = [...s.values.pins!.filter((p) => p.gpio !== 9), { signal: "LED_OUT", gpio: 9, partRef: "D1", partPin: "A" }]
	assert.equal(recoveryBootNet(s), null)
	assert.deepEqual(recoveryPads(s).placed, [])
	const v = checkConsistency(s, {}).filter((x) => x.kind === "boot-pin-taken")
	assert.equal(v.length, 1)
	assert.deepEqual(v[0].affects, ["architect"])
	assert.match(v[0].message, /GPIO9 is the boot strapping pin/)
})

test("the reviewer sees its earlier findings and is told to re-check them first", () => {
	assert.deepEqual(earlierReviewLines([]), [])
	const lines = earlierReviewLines([{ revision: 12, verdict: "fail", findings: [{ severity: "major", fields: ["requirements"], issue: "phone use left out", suggestion: "count it" }] }])
	assert.equal(lines[0], "## Your earlier reviews of this design")
	assert.match(lines[1], /re-check each earlier finding/)
	assert.ok(lines.includes("Revision 12: fail"))
	assert.ok(lines.includes("- major [requirements]: phone use left out"))
})
