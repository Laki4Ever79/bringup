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
	assert.equal(e.rail, "3V3", "VBUS is the charger input, not the battery draw")
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
