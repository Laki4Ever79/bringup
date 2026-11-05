import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runDesign } from "../src/run.ts"
import { tempDir } from "./helpers.ts"

// The phase-2 demo: "add a wake word" asks only for a model, and the checks carry it through the design. The ml agent
// writes the model; no microphone wakes parts; its unwired I2S lines wake the architect; always-on listening breaks the
// battery target, which wakes the architect too. Each step is one owner changing its own field.
test("'add a wake word' ripples from the model through parts, pins and the battery target, each by its owner", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const brief = readFileSync("briefs/logger.md", "utf8")
	const r = await runDesign({ brief, mock: true, noHardware: true, review: false, outDir: out, changes: ["add a wake word"], changeTimeoutMs: 20_000 })
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const requestAt = trace.findIndex((e) => e.type === "change.requested")
	const changes = trace.slice(requestAt).filter((e) => e.type === "contract.changed").map((e) => [e.payload.field, e.payload.by])
	assert.deepEqual(changes, [
		["model", "ml"],
		["requirements", "architect"],
		["parts", "parts"],
		["pins", "architect"],
	])
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8")).values
	assert.equal(contract.model.listening, "always")
	assert.ok(contract.parts.some((p: { mpn: string }) => p.mpn === "ICS-43434"))
	assert.deepEqual(contract.pins.filter((p: { partRef: string }) => p.partRef === "U5").map((p: { partPin: string }) => p.partPin).sort(), ["SCK", "SD", "WS"])
	assert.equal(contract.requirements.batteryLifeDays, null)
	const report = readFileSync(join(out, "report.md"), "utf8")
	assert.match(report, /Violations: 0/)
	assert.match(report, /- Model: wake word \(microphone at 16000 Hz, 1000 ms window\), weights 53 KB, arena 23 KB, int8 tflite-micro, listening always/)
	// The change-request row credits the agents that acted.
	assert.match(report, /\| add a wake word \| model, requirements, parts, pins \| [^|]*\bml\b/)
})
