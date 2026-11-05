import { test } from "node:test"
import assert from "node:assert/strict"
import { verifyConverted, type ConvertedModel } from "../src/contract/verify-model.ts"
import { pathHash, sensorPath } from "../src/contract/sensor-path.ts"
import { MIC_PART, MIC_PINS, WAKE_WORD_MODEL } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

function wakeWord() {
	const c = fixtureContract()
	c.values.model = { ...WAKE_WORD_MODEL }
	c.values.parts = [...c.values.parts!, MIC_PART]
	c.values.pins = [...c.values.pins!, ...MIC_PINS]
	return c
}

// What py/quantize.py measured for the MLPerf Tiny DS-CNN (TF 2.21, batch 1, tflite-micro host build), 5 Nov 2026.
const DS_CNN: ConvertedModel = { model: "MLPerf Tiny DS-CNN", trained: true, quantization: "int8", weightsBytes: 42664, arenaBytes: 24208, inputShape: [1, 49, 10, 1], inputDtype: "int8", calibration: "200 clips", dataset: null }

test("the DS-CNN fits the ESP32-C3, and the host-measured arena shows the 23 KB plan is 656 B short", () => {
	const v = verifyConverted(DS_CNN, wakeWord())
	assert.equal(v.fits, true)
	assert.ok(v.verdicts.some((x) => x.level === "warn" && /short by 656 B/.test(x.text)), JSON.stringify(v.verdicts))
	assert.deepEqual([v.proposal?.weightsKb, v.proposal?.arenaKb], [42, 24], "the measured sizes replace the plan")
})

test("a model too big for the flash the firmware leaves doesn't fit", () => {
	const v = verifyConverted({ ...DS_CNN, weightsBytes: 600_000 }, wakeWord())
	assert.equal(v.fits, false)
	assert.ok(v.verdicts.some((x) => x.level === "fail" && /don't fit/.test(x.text)))
})

test("a float32 model against an int8 plan fails", () => {
	assert.equal(verifyConverted({ ...DS_CNN, quantization: "float32", inputDtype: "float32" }, wakeWord()).fits, false)
})

test("a dataset recorded on another sensor path fails; one on the design's path passes", () => {
	const c = wakeWord()
	const now = pathHash(sensorPath(c)!)
	const other = verifyConverted({ ...DS_CNN, dataset: { pathHash: "000000000000", revision: 3, clips: 40 } }, c)
	assert.equal(other.fits, false)
	assert.ok(other.verdicts.some((x) => x.level === "fail" && x.text.includes(now)))
	const same = verifyConverted({ ...DS_CNN, dataset: { pathHash: now, revision: 6, clips: 40 } }, c)
	assert.equal(same.fits, true)
})

test("an untrained reference model and noise calibration are said out loud, not hidden", () => {
	const v = verifyConverted({ ...DS_CNN, trained: false, calibration: "noise (no dataset given)" }, wakeWord())
	assert.ok(v.verdicts.some((x) => /answers are not/.test(x.text)))
	assert.ok(v.verdicts.some((x) => /calibration: noise/.test(x.text)))
})

test("a dataset with no sensor path in the design to compare is a warning, not a pass", () => {
	const c = wakeWord()
	c.values.parts = c.values.parts!.filter((p) => p.role !== "microphone")
	const v = verifyConverted({ ...DS_CNN, dataset: { pathHash: "80722b24d856", revision: 6, clips: 40 } }, c)
	assert.ok(v.verdicts.some((x) => x.level === "warn" && /no sensor path to compare/.test(x.text)), JSON.stringify(v.verdicts))
	assert.ok(!v.verdicts.some((x) => x.level === "ok" && /recorded on the design's sensor path/.test(x.text)))
})

test("the device's own arena figure settles the plan: 22,684 B on the ESP32-C3 fits the 23 KB the host overstated", () => {
	const v = verifyConverted(DS_CNN, wakeWord(), { arenaUsedBytes: 22684 })
	assert.ok(v.verdicts.some((x) => x.level === "ok" && /used 22684 B of arena against the planned 23552 B$/.test(x.text)), JSON.stringify(v.verdicts))
	assert.ok(!v.verdicts.some((x) => /short by/.test(x.text)), "no shortfall once the device has spoken")
	assert.deepEqual([v.proposal?.weightsKb, v.proposal?.arenaKb], [42, 23], "weights from the .tflite, the arena from the device")
})
