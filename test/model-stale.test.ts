import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runDesign } from "../src/run.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { pathDiff, pathHash, sensorPath } from "../src/contract/sensor-path.ts"
import { modelHeader } from "../src/codegen/firmware.ts"
import { MIC_PART, MIC_PINS, WAKE_WORD_MODEL } from "../src/inference/scripts.ts"
import { fixtureArtifacts, fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

// The fixture logger with the wake-word model, its microphone and the mic's I2S pins.
function wakeWord() {
	const c = fixtureContract()
	c.values.model = { ...WAKE_WORD_MODEL }
	c.values.parts = [...c.values.parts!, MIC_PART]
	c.values.pins = [...c.values.pins!, ...MIC_PINS]
	return c
}
const recordedOn = (c: ReturnType<typeof wakeWord>, status: "recorded" | "needed" = "recorded") => {
	const path = sensorPath(c)!
	c.values.model = { ...c.values.model!, data: { status, revision: c.revision, pathHash: pathHash(path), path } }
}
const stale = (c: ReturnType<typeof wakeWord>) => checkConsistency(c, fixtureArtifacts()).filter((v) => v.kind === "model-stale")

test("the sensor path names the part, where the board puts it, the case opening, the rate and the capture gain", () => {
	const path = sensorPath(wakeWord())!
	assert.equal(path.mpn, "ICS-43434")
	assert.deepEqual(path.opening, { diameterMm: 2, floorMm: 2 })
	assert.deepEqual([path.sampleRateHz, path.channels, path.capture?.shift], [16000, 1, 16])
	assert.ok(Number.isFinite(path.xMm) && Number.isFinite(path.yMm), JSON.stringify(path))
	assert.equal(sensorPath(fixtureContract()), null, "no model, no path")
	assert.match(pathHash(path), /^[0-9a-f]{12}$/)
})

test("data recorded on today's path is not stale", () => {
	const c = wakeWord()
	recordedOn(c)
	assert.deepEqual(stale(c), [])
})

test("model-stale: a narrower board moves the microphone under recorded data, and the ml agent is told what moved", () => {
	const c = wakeWord()
	recordedOn(c)
	c.values.outline = { ...c.values.outline!, widthMm: 40 }
	const [v] = stale(c)
	assert.ok(v, "a stale model is reported")
	assert.deepEqual(v.affects, ["ml"])
	assert.match(v.message, /recorded on rev 6's sensor path .*xMm 25 → 20.*mark the data needed/)
})

test("model-stale: another microphone part, or another sample rate, touches the model's input too", () => {
	for (const change of [(c: ReturnType<typeof wakeWord>) => (c.values.parts = c.values.parts!.map((p) => (p.ref === "U5" ? { ...p, mpn: "OTHER-MIC" } : p))), (c: ReturnType<typeof wakeWord>) => (c.values.model = { ...c.values.model!, sampleRateHz: 8000 })]) {
		const c = wakeWord()
		recordedOn(c)
		change(c)
		assert.equal(stale(c).length, 1)
	}
})

test("an unplaced microphone has no sensor path, rather than one with NaN coordinates", () => {
	const c = wakeWord()
	delete c.values.outline
	assert.equal(sensorPath(c), null)
})

test("pathDiff lists only what changed", () => {
	const a = sensorPath(wakeWord())!
	assert.deepEqual(pathDiff(a, { ...a, rotation: 90 }), ["rotation 0 → 90"])
	assert.deepEqual(pathDiff(a, a), [])
})

test("model.h stamps the sensor path's hash and the microphone capture settings", () => {
	const c = wakeWord()
	const h = modelHeader(c)
	assert.match(h, new RegExp(`^#define MODEL_PATH_HASH "${pathHash(sensorPath(c)!)}"$`, "m"))
	assert.match(h, /^#define MIC_SHIFT 16$/m)
	assert.match(h, /^#define MIC_SLOT_BITS 32$/m)
})

// The demo: data recorded on the wake-word design, then "make it 40 mm wide". The board narrows, the microphone moves,
// and the ml agent marks the data needed on the new path instead of keeping a model trained for the old board.
test("'make it 40 mm wide' after the data is recorded leaves the model's data marked needed on the new path", { timeout: 180_000 }, async () => {
	const out = tempDir()
	const brief = readFileSync("briefs/logger.md", "utf8")
	const r = await runDesign({ brief, mock: true, noHardware: true, review: false, outDir: out, changes: ["add a wake word", "the wake-word data is recorded", "make it 40 mm wide"], changeTimeoutMs: 20_000 })
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const staleAt = trace.filter((e) => e.type === "consistency.checked" && e.payload.violations.some((v: { kind: string }) => v.kind === "model-stale"))
	assert.ok(staleAt.length > 0, "the 40 mm change made the model's data stale")
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	assert.equal(contract.values.outline.widthMm, 40)
	const data = contract.values.model.data
	assert.equal(data.status, "needed")
	assert.equal(data.pathHash, pathHash(sensorPath(contract)!), "needed on the path the design has now")
})
