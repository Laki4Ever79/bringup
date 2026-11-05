import { test } from "node:test"
import assert from "node:assert/strict"
import { DesignContract } from "../src/contract/contract.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { FIRMWARE_BUDGET, modelBudget, modelChecks, modelCurrentMa, modelFactLines } from "../src/contract/model.ts"
import { estimatePower } from "../src/contract/power.ts"
import { FIELDS, type ContractSnapshot, type ContractValues, type ModelSpec } from "../src/contract/types.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"

const KWS: ModelSpec = { task: "wake word", sensor: "microphone", sampleRateHz: 16000, windowMs: 1000, channels: 1, weightsKb: 52, arenaKb: 30, runtime: "tflite-micro", quantization: "int8", listening: "on-wake" }
const MIC = { ref: "U5", role: "microphone", mpn: "ICS-43434", lcsc: "C5656610", footprint: "ics43434", pins: ["WS", "LR", "GND", "SCK", "VDD", "SD"] }
const MIC_PINS = [
	{ signal: "MIC_SCK", gpio: 4, partRef: "U5", partPin: "SCK" },
	{ signal: "MIC_WS", gpio: 5, partRef: "U5", partPin: "WS" },
	{ signal: "MIC_SD", gpio: 6, partRef: "U5", partPin: "SD" },
]

function snapshot(values: Partial<ContractValues>): ContractSnapshot {
	return { revision: 1, values, versions: Object.fromEntries(FIELDS.map((f) => [f, 1])) as ContractSnapshot["versions"] }
}
const withModel = (model: ModelSpec, opts: { mic?: boolean; pins?: boolean } = {}) =>
	snapshot({
		...LOGGER_DESIGN,
		parts: [...LOGGER_DESIGN.parts, ...(opts.mic === false ? [] : [MIC])],
		pins: [...LOGGER_DESIGN.pins, ...(opts.pins === false ? [] : MIC_PINS)],
		model,
	})

test("the model field: the contract accepts a model spec, and refuses a malformed one", () => {
	const c = new DesignContract()
	assert.equal(c.propose({ field: "model", value: KWS, by: "ml", baseVersion: 0 }).status, "applied")
	assert.equal(c.propose({ field: "model", value: { ...KWS, listening: "sometimes" } as unknown as ModelSpec, by: "ml", baseVersion: 1 }).status, "invalid")
	assert.equal(c.propose({ field: "model", value: { ...KWS, weightsKb: 60 }, by: "architect", baseVersion: 1 }).status, "not-owner")
})

test("a model that fits, reading a wired microphone at a rate it supports, raises nothing", () => {
	assert.deepEqual(modelChecks(withModel(KWS)), [])
	// The budget is the firmware's measured leftovers: about 459 KB flash and 295 KB static RAM.
	const b = modelBudget(KWS)
	assert.equal(Math.round(b.flashFreeKb), Math.round((FIRMWARE_BUDGET.appFlashBytes - FIRMWARE_BUDGET.firmwareFlashBytes) / 1024))
	assert.ok(b.flashFreeKb > 450 && b.flashFreeKb < 470)
})

test("each mismatch is a violation for the agent who can fix it", () => {
	const kinds = (s: ContractSnapshot) => modelChecks(s).map((v) => [v.kind, v.affects.join()])
	assert.deepEqual(kinds(withModel(KWS, { mic: false, pins: false })), [["model-sensor-missing", "parts"]])
	assert.deepEqual(kinds(withModel(KWS, { pins: false })), [["model-sensor-unwired", "architect"]])
	// 22.05 kHz falls between the ICS-43434's low-power (≤ 18.75 kHz) and high-performance (≥ 23 kHz) ranges.
	assert.deepEqual(kinds(withModel({ ...KWS, sampleRateHz: 22050 })), [["model-rate", "ml"]])
	assert.deepEqual(kinds(withModel({ ...KWS, weightsKb: 600, quantization: "float32" })), [["model-flash", "ml"]])
	assert.deepEqual(kinds(withModel({ ...KWS, arenaKb: 400 })), [["model-ram", "ml"]])
	// The consistency check carries them too.
	assert.ok(checkConsistency(withModel({ ...KWS, arenaKb: 400 }), {}).some((v) => v.kind === "model-ram"))
})

test("listening counts in the battery budget: always-on keeps the MCU awake; on-wake costs one window per wake", () => {
	const always = modelCurrentMa(withModel({ ...KWS, listening: "always" }))!
	// ESP32-C3 CPU 28 mA (catalog) plus the mic's low-power 230 µA at 16 kHz.
	assert.equal(always.averageMa, 28.23)
	const onWake = modelCurrentMa(withModel(KWS))!
	// 1 s of 28.23 mA every 300 s, plus the mic's 12 µA sleep the rest of the time.
	assert.ok(Math.abs(onWake.averageMa - (28.23 / 300 + 0.012 * (299 / 300))) < 1e-9)
	const brief = "a 500 mAh cell"
	const base = estimatePower(snapshot({ ...LOGGER_DESIGN }), brief).days!
	const listening = estimatePower(withModel({ ...KWS, listening: "always" }), brief).days!
	assert.ok(listening < 1, `always listening on 500 mAh lasts under a day, got ${listening}`)
	assert.ok(base > 100)
	// The battery target then fails, which wakes the architect.
	assert.ok(checkConsistency(withModel({ ...KWS, listening: "always" }), {}, brief).some((v) => v.kind === "battery-short"))
})

test("the design facts every agent sees state the model, its fit and its power", () => {
	const lines = modelFactLines(withModel(KWS)).join("\n")
	assert.match(lines, /weights 11% of the 45\d KB flash and arena 10% of the 29\d KB static RAM/)
	assert.match(lines, /Listening adds 0.106 mA on average/)
})
