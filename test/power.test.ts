import { test } from "node:test"
import assert from "node:assert/strict"
import { DesignContract } from "../src/contract/contract.ts"
import { batteryLifeDays, capacityFromBrief, dutyCycleAverageMa, estimatePower, powerBudgetLines } from "../src/contract/power.ts"
import type { ContractValues } from "../src/contract/types.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

test("batteryLifeDays divides capacity by the average draw plus regulator Iq", () => {
	// 500 mAh / (0.045 mA + 0.055 mA) = 5000 h = 208.3 days
	assert.equal(Math.round(batteryLifeDays(500, 0.045, 55)! * 10) / 10, 208.3)
	assert.equal(batteryLifeDays(240, 10, 0), 1)
	assert.equal(batteryLifeDays(500, 0, 0), null, "no draw at all is not an estimate")
	assert.equal(batteryLifeDays(0, 1, 0), null)
	assert.equal(batteryLifeDays(500, Number.NaN, 0), null)
})

test("dutyCycleAverageMa weights the active current by the fraction of time awake", () => {
	// 30 ms of every 300 s at 25 mA = 2.5 µA, plus 10 µA asleep for the rest
	assert.equal(Math.round(dutyCycleAverageMa({ activeMs: 30, periodS: 300, sleepUa: 10 }, 25) * 1e6) / 1e6, 0.012499)
})

test("capacityFromBrief reads a stated mAh figure", () => {
	assert.equal(capacityFromBrief("a small single-cell pouch, around 500 mAh."), 500)
	assert.equal(capacityFromBrief("a 1,200mAh cell"), 1200)
	assert.equal(capacityFromBrief("no battery here"), null)
})

test("estimatePower prefers the brief's capacity and the battery-side rail's average", () => {
	const c = fixtureContract()
	c.values.requirements!.batteryMah = 400
	c.values.rails = [
		{ name: "VBUS", voltageV: 5, regulatorMaxMa: 500, loadMa: 500, averageMa: 400 },
		{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 500, loadMa: 120, averageMa: 0.045 },
	]
	const e = estimatePower(c, "Runs on a 500 mAh cell")
	assert.equal(e.capacityMah, 500)
	assert.equal(e.capacitySource, "brief")
	assert.deepEqual(e.rails.map((r) => r.name), ["3V3"], "VBUS is the charger input, not the battery draw")
	assert.equal(e.averageMa, 0.045)
	assert.equal(e.regulatorIqUa, 0, "the fixture has no LDO")
	assert.equal(e.targetDays, 180)
	assert.equal(Math.round(e.days!), 463)
	assert.equal(estimatePower(c, "no capacity stated").capacitySource, "requirements")
})

test("estimatePower adds the LDO's quiescent current and says when it cannot estimate", () => {
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	const e = estimatePower(s, "around 500 mAh")
	assert.equal(e.regulatorIqUa, 55)
	assert.ok(e.days! > 180, `logger estimate ${e.days} days`)
	delete s.values.rails![0].averageMa
	delete s.values.requirements!.dutyCycle
	assert.equal(estimatePower(s, "around 500 mAh").days, null)
	assert.match(powerBudgetLines(estimatePower(s, "around 500 mAh")).join("\n"), /no average current/i)
})

// Real run 6: VBAT's own loads and the 3V3 rail behind the LDO both draw from the cell. The LDO's input current is
// its output current, so the battery sees 0.02 + 0.106 mA plus the LDO's 55 µA: about 115 days, not 278.
const REAL_6_RAILS = [
	{ name: "VBAT", voltageV: 3.7, regulatorMaxMa: 500, loadMa: 350, averageMa: 0.02 },
	{ name: "VDD_3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 180, averageMa: 0.106 },
]

test("the battery current sums every battery-fed rail's own average, plus the LDO Iq (real run 6)", () => {
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	s.values.rails = structuredClone(REAL_6_RAILS)
	s.values.requirements!.dutyCycle = { activeMs: 120, periodS: 300, sleepUa: 20 }
	const e = estimatePower(s, "a small single-cell pouch, around 500 mAh")
	assert.deepEqual(e.rails.map((r) => [r.name, r.averageMa]), [["VBAT", 0.02], ["VDD_3V3", 0.106]])
	assert.equal(Math.round(e.averageMa! * 1000) / 1000, 0.126)
	assert.equal(e.regulatorIqUa, 55)
	assert.equal(Math.round(e.days!), 115)
	const text = powerBudgetLines(e).join("\n")
	assert.match(text, /Rail VBAT: peak 350 mA, average 0\.02 mA/)
	assert.match(text, /Rail VDD_3V3: peak 180 mA, average 0\.106 mA/)
	assert.match(text, /500 mAh \/ \(0\.02 mA \+ 0\.106 mA \+ 0\.055 mA\) \/ 24 h = 115 days vs target 180 days/)
})

test("a battery-fed rail with no average makes the estimate unknown instead of optimistic", () => {
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	s.values.rails = [REAL_6_RAILS[0], { ...REAL_6_RAILS[1], averageMa: undefined }]
	delete s.values.requirements!.dutyCycle
	const e = estimatePower(s, "500 mAh")
	assert.equal(e.days, null)
	assert.match(powerBudgetLines(e).join("\n"), /no average current for VDD_3V3/)
})

test("each LDO adds its own quiescent current", () => {
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	s.values.parts = [...s.values.parts!, { ...s.values.parts!.find((p) => p.role === "ldo")!, ref: "U4" }]
	assert.equal(estimatePower(s, "500 mAh").regulatorIqUa, 110)
})

test("powerBudgetLines shows peak, average and the arithmetic", () => {
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	const text = powerBudgetLines(estimatePower(s, "around 500 mAh")).join("\n")
	assert.match(text, /3V3: peak 120 mA, average 0\.0\d+ mA/)
	assert.match(text, /Battery: 500 mAh \(from the brief\)/)
	assert.match(text, /Regulator quiescent current: 55 µA/)
	assert.match(text, /Estimated battery life: 500 mAh \/ \(0\.\d+ mA \+ 0\.055 mA\) \/ 24 h = \d+ days vs target 180 days/)
})

const propose = (field: "requirements" | "rails", value: unknown) => new DesignContract().propose({ field, value, by: "architect", baseVersion: 0 } as never)
const req = { summary: "logger", peripherals: [], batteryLifeDays: 180 }
const rail = { name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 120 }

test("the contract accepts the optional power fields", () => {
	assert.equal(propose("requirements", { ...req, batteryMah: 500, dutyCycle: { activeMs: 30, periodS: 300, sleepUa: 10 } }).status, "applied")
	assert.equal(propose("requirements", req).status, "applied")
	assert.equal(propose("rails", [{ ...rail, averageMa: 0.04 }]).status, "applied")
	assert.equal(propose("rails", [rail]).status, "applied")
})

test("the contract rejects malformed power fields", () => {
	const bad = (field: "requirements" | "rails", value: unknown, why: RegExp) => {
		const r = propose(field, value)
		assert.equal(r.status, "invalid", JSON.stringify(value))
		assert.match((r as { reason: string }).reason, why)
	}
	bad("rails", [{ ...rail, averageMa: 150 }], /averageMa.*loadMa/)
	bad("rails", [{ ...rail, averageMa: -1 }], /averageMa/)
	bad("rails", [{ ...rail, averageMa: "low" }], /averageMa/)
	bad("requirements", { ...req, dutyCycle: { activeMs: 30, periodS: 300 } }, /dutyCycle/)
	bad("requirements", { ...req, dutyCycle: { activeMs: 400_000, periodS: 300, sleepUa: 10 } }, /dutyCycle/)
	bad("requirements", { ...req, batteryMah: 0 }, /batteryMah/)
})

const LOW_IQ = { ref: "U3", role: "ldo", mpn: "XC6206P332MR-G", lcsc: "C5446", footprint: "sot23", pins: ["GND", "VOUT", "VIN"] }

test("an LDO's quiescent current comes from the catalog's iqUa", () => {
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	s.values.parts = s.values.parts!.map((p) => (p.role === "ldo" ? LOW_IQ : p))
	const e = estimatePower(s, "around 500 mAh")
	assert.equal(e.regulatorIqUa, 1)
	assert.deepEqual(e.regulators, [{ ref: "U3", mpn: "XC6206P332MR-G", iqUa: 1, source: "catalog" }])
	const text = powerBudgetLines(e).join("\n")
	assert.match(text, /Regulator quiescent current: 1 µA \(U3 XC6206P332MR-G 1 µA, from the catalog\)/)
	assert.match(text, /\+ 0\.001 mA\) \/ 24 h/)
})

test("an LDO the catalog doesn't know is assumed to draw 55 uA", () => {
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	s.values.parts = s.values.parts!.map((p) => (p.role === "ldo" ? { ...p, mpn: "MYSTERY-LDO" } : p))
	const e = estimatePower(s, "500 mAh")
	assert.equal(e.regulatorIqUa, 55)
	assert.equal(e.regulators[0].source, "assumed")
	assert.match(powerBudgetLines(e).join("\n"), /U3 MYSTERY-LDO 55 µA, not in the catalog: assumed AP2112K-class/)
})

test("swapping the AP2112K for the low-Iq LDO buys battery life (500 mAh, real run 7's budget)", () => {
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	s.values.rails = [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 200, loadMa: 120, averageMa: 0.07 }]
	const ap = estimatePower(s, "500 mAh").days!
	s.values.parts = s.values.parts!.map((p) => (p.role === "ldo" ? LOW_IQ : p))
	const xc = estimatePower(s, "500 mAh").days!
	assert.ok(ap < 180 && xc > 180, `AP2112K ${Math.round(ap)} days, XC6206 ${Math.round(xc)} days`)
})

test("every catalog LDO records its quiescent current", async () => {
	const { loadCatalog } = await import("../src/tools/parts-search.ts")
	const ldos = loadCatalog(new URL("..", import.meta.url).pathname).filter((p) => p.role === "ldo")
	assert.ok(ldos.length >= 2)
	for (const l of ldos) assert.equal(typeof l.iqUa, "number", `${l.mpn} has no iqUa`)
	assert.ok(ldos.some((l) => l.iqUa! <= 5), "no ultra-low-Iq LDO in the catalog")
})

test("measuredAverageMa: charge per wake (µC) over the period, plus the sleep floor, in mA", async () => {
	const { measuredAverageMa } = await import("../src/contract/power.ts")
	// 183 ms awake at about 60 mA above the floor ≈ 11 000 µC per wake; one wake every 300 s; 5 µA asleep.
	assert.equal(measuredAverageMa({ chargeUc: 11_000, periodS: 300, sleepUa: 5 }), (11_000 / 300 + 5) / 1000)
	assert.ok(Math.abs(measuredAverageMa({ chargeUc: 11_000, periodS: 300, sleepUa: 5 }) - 0.04167) < 1e-4, "mA, not µA")
	assert.throws(() => measuredAverageMa({ chargeUc: 1, periodS: 0, sleepUa: 5 }), /periodS/)
})

test("a sleep current below the MCU's datasheet deep-sleep floor is raised to it", async () => {
	const { effectiveSleepUa } = await import("../src/contract/power.ts")
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	s.values.requirements = { ...s.values.requirements!, dutyCycle: { activeMs: 200, periodS: 300, sleepUa: 0 } }
	assert.deepEqual(effectiveSleepUa(s), { sleepUa: 5, raisedFrom: 0, floorFrom: "ESP32-C3-MINI-1" })
	s.values.requirements.dutyCycle!.sleepUa = 12
	assert.deepEqual(effectiveSleepUa(s), { sleepUa: 12, raisedFrom: null, floorFrom: "ESP32-C3-MINI-1" })
})

test("the duty-cycle estimate uses the raised sleep current and says so (real run 8 claimed 0 µA)", () => {
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	s.values.requirements = { ...s.values.requirements!, dutyCycle: { activeMs: 200, periodS: 300, sleepUa: 0 } }
	s.values.rails = [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 120 }]
	const e = estimatePower(s, "500 mAh")
	const awake = 200 / 300_000
	assert.ok(Math.abs(e.rails[0].averageMa! - (awake * 120 + (1 - awake) * 0.005)) < 1e-9)
	assert.match(powerBudgetLines(e).join("\n"), /0 µA asleep stated, raised to the ESP32-C3-MINI-1's 5 µA deep-sleep floor \(datasheet\)/)
})

test("a measured rail average is labelled with its bench revision", () => {
	const s = { revision: 1, versions: fixtureContract().versions, values: structuredClone(LOGGER_DESIGN) as Partial<ContractValues> }
	s.values.rails = [{ ...s.values.rails![0], averageMa: 0.0567, averageSource: "measured", measuredRevision: 14 }]
	const e = estimatePower(s, "500 mAh")
	assert.equal(e.rails[0].source, "measured")
	assert.match(powerBudgetLines(e).join("\n"), /Rail 3V3: peak 120 mA, average 0\.0567 mA \(measured on bench, rev 14\)/)
})

// Real runs 15 and 16: the reviewer re-derived battery life from the duty cycle by hand and blocked on the rails'
// stated averages. It now gets the duty-cycle estimate as a computed check, with every input, like DRC or SPICE.
test("dutyCycleCheckLines derives battery life from the duty cycle, independent of the stated averages", async () => {
	const { dutyCycleCheckLines } = await import("../src/contract/power.ts")
	const s = fixtureContract()
	s.values.requirements = { summary: "logger", peripherals: [], batteryLifeDays: 180, batteryMah: 500, dutyCycle: { activeMs: 100, periodS: 300, sleepUa: 5 } }
	s.values.rails = [
		{ name: "VBAT", voltageV: 3.7, regulatorMaxMa: 500, loadMa: 40, averageMa: 0.006 },
		{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 200, loadMa: 80, averageMa: 0.028 },
	]
	s.values.parts = [...s.values.parts!, { ref: "U3", role: "ldo", mpn: "XC6206P332MR-G", lcsc: "C5446", footprint: "sot23", pins: ["GND", "VOUT", "VIN"] }]
	const text = dutyCycleCheckLines(estimatePower(s, "")).join("\n")
	assert.match(text, /^Battery-life check \(computed in code from the duty cycle, not from the rails' stated averages\):$/m)
	assert.match(text, /^- Each reading: 100 ms awake at up to 80 mA \(the busiest battery-fed rail's peak\) = 8 mC$/m)
	assert.match(text, /^- The firmware's wake: the 30 ms reading, then 70 ms of BLE advertising \(BLE_ADVERTISE_MS, from activeMs\)\. A phone that connects keeps it awake up to 30 s, which this average leaves out\.$/m)
	assert.match(text, /^- Asleep the rest of the 300 s period: 5 µA \(MCU deep sleep\) \+ 1 µA \(LDO quiescent\)$/m)
	// 100/300000 × 80 mA + (1 − 1/3000) × 0.005 mA + 0.001 mA = 0.0327 mA; 500 mAh / 0.0327 mA / 24 h = 638 days
	assert.match(text, /^- Average 0\.0327 mA; 500 mAh \/ 0\.0327 mA \/ 24 h = 638 days vs target 180 days$/m)
	assert.match(text, /^- Assumes the firmware sleeps between readings as requirements\.dutyCycle says, and the peak current for the whole wake \(an upper bound on current\)\. So a result at or above the target shows the target is met; one below it does not by itself show it is missed: then judge the stated average against the parts\.$/m)
	const none = fixtureContract()
	assert.deepEqual(dutyCycleCheckLines(estimatePower(none, "")), ["Battery-life check: not computed (no requirements.dutyCycle)"])
	// A wake too short for the reading and the shortest advertising window: the check charges what the firmware does.
	s.values.requirements = { ...s.values.requirements!, dutyCycle: { activeMs: 40, periodS: 300, sleepUa: 5 } }
	const short = dutyCycleCheckLines(estimatePower(s, "")).join("\n")
	assert.match(short, /^- Each reading: 80 ms awake \(requirements\.dutyCycle\.activeMs says 40 ms\) at up to 80 mA \(the busiest battery-fed rail's peak\) = 6\.4 mC$/m)
})

// Real run 20: VBAT and VCC_3V3 both stated 0.0307 mA, i.e. VBAT's figure was the 3V3 loads again. Counted once.
test("a battery rail stating the same average as the rail behind its LDO is counted once, and the budget says so", () => {
	const c = fixtureContract()
	c.values.rails = [
		{ name: "VBAT", voltageV: 3.7, regulatorMaxMa: 500, loadMa: 300, averageMa: 0.0307 },
		{ name: "VCC_3V3", voltageV: 3.3, regulatorMaxMa: 500, loadMa: 250, averageMa: 0.0307 },
	]
	const e = estimatePower(c, "around 500 mAh")
	assert.equal(e.averageMa, 0.0307)
	assert.equal(e.rails[0].sameAs, "VCC_3V3")
	const text = powerBudgetLines(e).join("\n")
	assert.match(text, /Rail VBAT: .*the same as VCC_3V3's, so read as including VCC_3V3's loads and counted once/)
	assert.match(text, /500 mAh \/ \(0\.0307 mA\) \/ 24 h/)
	c.values.rails[0].averageMa = 0.002
	assert.equal(estimatePower(c, "around 500 mAh").averageMa, 0.0327, "different averages still add up")
})

// Charging the whole wake at the rail's peak (a regulator sizing figure) was our modelling error, and the reviewer
// trusted it. With the MCU's datasheet currents in the catalog, the check charges each phase at its own current.
test("dutyCycleCheckLines charges the reading at the CPU current and the advertising window at the radio current, and keeps the peak as a labelled worst case", async () => {
	const { dutyCycleCheckLines } = await import("../src/contract/power.ts")
	const s = fixtureContract()
	s.values.requirements = { summary: "beacon", peripherals: [], batteryLifeDays: 90, batteryMah: 500, dutyCycle: { activeMs: 80, periodS: 60, sleepUa: 5 } }
	s.values.rails = [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 200, loadMa: 200, averageMa: 0.12 }]
	s.values.parts = [...s.values.parts!, { ref: "U3", role: "ldo", mpn: "XC6206P332MR-G", lcsc: "C5446", footprint: "sot23", pins: ["GND", "VOUT", "VIN"] }]
	const text = dutyCycleCheckLines(estimatePower(s, ""), s).join("\n")
	assert.match(text, /^Battery-life check \(computed in code from the duty cycle and U1 ESP32-C3-MINI-1's datasheet currents, not from the rails' stated averages\):$/m)
	assert.match(text, /^- Reading: 30 ms at 28 mA \(CPU running, datasheet\) = 0\.84 mC$/m)
	assert.match(text, /^- Advertising: 50 ms at 84 mA \(radio receiving, datasheet; it gives no Bluetooth LE figure, so the receive current stands in for the whole window, which keeps the radio on while advertising transmits in short bursts\) = 4\.2 mC$/m)
	// (0.84 + 4.2) mC / 60 s + (1 − 80/60000) × 0.005 mA + 0.001 mA = 0.0900 mA; 500 / 0.09 / 24 = 231 days
	assert.match(text, /^- Average 0\.09 mA; 500 mAh \/ 0\.09 mA \/ 24 h = 231 days vs target 90 days$/m)
	assert.match(text, /^- Worst case, the busiest battery-fed rail's peak \(200 mA, a regulator sizing figure\) for the whole 80 ms wake:$/m)
	// 80/60000 × 200 + (1 − 80/60000) × 0.005 + 0.001 = 0.273 mA; 76 days
	assert.match(text, /^- {3}worst-case average 0\.273 mA; 500 mAh \/ 0\.273 mA \/ 24 h = 76 days vs target 90 days$/m)
})

// Real beacon run N: blocked on "the average leaves out connected time". The check now says what the target leaves for it.
test("the duty-cycle check says how many full-length connections a day the battery target leaves room for", async () => {
	const { dutyCycleCheckLines } = await import("../src/contract/power.ts")
	const s = fixtureContract()
	s.values.requirements = { summary: "beacon", peripherals: [], batteryLifeDays: 90, batteryMah: 500, dutyCycle: { activeMs: 80, periodS: 60, sleepUa: 5 } }
	s.values.rails = [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 200, loadMa: 200, averageMa: 0.12 }]
	s.values.parts = [...s.values.parts!, { ref: "U3", role: "ldo", mpn: "XC6206P332MR-G", lcsc: "C5446", footprint: "sot23", pins: ["GND", "VOUT", "VIN"] }]
	const text = dutyCycleCheckLines(estimatePower(s, ""), s).join("\n")
	// allowed 500 / (90 × 24) = 0.231 mA; spare 0.231 − 0.09 = 0.141 mA → 12200 mC a day / 2520 mC = 4 connections
	assert.match(text, /^- Connections: a phone that connects keeps it awake up to 30 s at about 84 mA \(2520 mC each\)\. The 90-day target allows 0\.231 mA on average; 0\.141 mA above this average, which pays for 4 full-length connections a day \(the brief does not say how often a phone connects\)\.$/m)
})
