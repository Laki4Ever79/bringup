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
