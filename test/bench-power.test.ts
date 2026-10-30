import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { reviewMessage } from "../src/agents/reviewer.ts"
import { batteryLifeSummary, effectiveSleepUa, estimatePower, measuredAverageMa, powerBudgetLines } from "../src/contract/power.ts"
import { CORE_FIELDS, OWNERS, type ContractValues } from "../src/contract/types.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { BringupState, startRuntime } from "../src/runtime.ts"
import { tempDir } from "./helpers.ts"

const BRIEF = "Pocket climate logger. Runs on one Li-ion cell for at least 6 months; assume around 500 mAh."

// A fake bench measurement, end to end: bench numbers → measuredAverageMa → a bench rails proposal the architect
// approved → power.ts → the reviewer's message. Every number is recomputed here from its definition.
test("a bench measurement flows into the contract, the power budget and the reviewer's view", async () => {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	writeFileSync(join(state.outDir, "brief.md"), BRIEF)
	for (const field of CORE_FIELDS) {
		const r = state.contract.propose({ field, value: structuredClone(LOGGER_DESIGN[field as keyof typeof LOGGER_DESIGN]) as ContractValues[typeof field], by: OWNERS[field], baseVersion: 0 } as never)
		assert.equal(r.status, "applied", `${field}: ${JSON.stringify(r)}`)
	}
	const before = state.contract.snapshot()
	const estimated = estimatePower(before, BRIEF)

	// The bench: 14 000 µC above the dev board's floor per wake, rescaled to the contract's 300 s period.
	const d = before.values.requirements!.dutyCycle!
	const sleep = effectiveSleepUa(before)!
	assert.equal(sleep.sleepUa, 10, "the logger's 10 µA is above the ESP32-C3's 5 µA floor, so it stands")
	const averageMa = measuredAverageMa({ chargeUc: 14_000, periodS: d.periodS, sleepUa: sleep.sleepUa })
	assert.ok(Math.abs(averageMa - (14_000 / 300 + 10) / 1000) < 1e-12)

	// The bench proposes rails with only the measured fields changed; the architect approved it.
	const rails = before.values.rails!.map((r) => (r.name === "3V3" ? { ...r, averageMa, averageSource: "measured" as const, measuredRevision: before.revision } : r))
	const applied = state.contract.propose({ field: "rails", value: rails, by: "bench", approvedBy: "architect", baseVersion: before.versions.rails } as never)
	assert.equal(applied.status, "applied", JSON.stringify(applied))

	const after = state.contract.snapshot()
	const measured = estimatePower(after, BRIEF)
	const iqMa = measured.regulatorIqUa / 1000
	assert.ok(Math.abs(measured.days! - 500 / (averageMa + iqMa) / 24) < 1e-9, "days = capacity / (measured average + LDO Iq) / 24 h")
	assert.ok(measured.days! < estimated.days!, `the measurement (${measured.days} days) is worse than the estimate (${estimated.days} days)`)

	const budget = powerBudgetLines(measured).join("\n")
	assert.match(budget, new RegExp(`Rail 3V3: peak 120 mA, average ${Number(averageMa.toPrecision(3))} mA \\(measured on bench, rev ${before.revision}\\)`))

	// The battery-life line (report.md and the budget) says the figure rests on a measurement.
	assert.equal(batteryLifeSummary(measured), `${Math.round(measured.days!)} days vs target 180 days (3V3 measured on bench, rev ${before.revision})`)
	assert.doesNotMatch(batteryLifeSummary(estimated), /measured/)

	const message = await reviewMessage(undefined, after.revision, 1)
	assert.ok(message.includes(`(measured on bench, rev ${before.revision})`), "the reviewer sees that the average was measured")
	assert.ok(message.includes(`= ${Math.round(measured.days!)} days vs target 180 days`), "the reviewer sees the measured battery life")
})
