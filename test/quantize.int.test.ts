import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { main } from "../src/main.ts"
import { MIC_PART, MIC_PINS, WAKE_WORD_MODEL } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const mlPython = join(root, "tools/mlvenv/bin/python")
const pio = join(root, ".venv/bin/pio")
const skip = !existsSync(mlPython) ? "no tools/mlvenv (TensorFlow + tflite-micro; docs/edge-ai.md)" : !existsSync(pio) ? "pio not found" : false

// The real chain: TensorFlow's int8 converter on the MLPerf Tiny DS-CNN, TFLite Micro's own arena figure, then the
// converted model compiled into the firmware in place of the placeholder, measured by pio.
test("quantize → verify-model → firmware with the real model: the sizes reconcile", { skip, timeout: 900_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-q-"))
	const q = spawnSync(mlPython, ["py/quantize.py", "--out", join(dir, "model")], { cwd: root, encoding: "utf8", env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: "3" }, timeout: 600_000 })
	assert.equal(q.status, 0, q.stderr)
	const facts = JSON.parse(readFileSync(join(dir, "model/model.json"), "utf8"))
	assert.equal(facts.inputDtype, "int8")
	assert.deepEqual(facts.inputShape, [1, 49, 10, 1])
	assert.ok(facts.weightsBytes > 40_000 && facts.weightsBytes < 50_000, `weights ${facts.weightsBytes} B`)
	assert.ok(facts.arenaBytes > 16_000 && facts.arenaBytes < 40_000, `arena ${facts.arenaBytes} B`)
	const c = fixtureContract()
	c.values.model = { ...WAKE_WORD_MODEL }
	c.values.parts = [...c.values.parts!, MIC_PART]
	c.values.pins = [...c.values.pins!, ...MIC_PINS]
	writeFileSync(join(dir, "contract.json"), JSON.stringify(c))
	const code = await main(["verify-model", join(dir, "model"), join(dir, "contract.json"), "--firmware", join(dir, "fw")])
	assert.equal(code, 0)
	const v = JSON.parse(readFileSync(join(dir, "model/verify.json"), "utf8"))
	assert.equal(v.firmware.ok, true)
	assert.ok(existsSync(join(dir, "fw/src/model_data.cc")), "the real model was linked")
	// The arena reserved is the measured one, rounded up to whole KB.
	assert.equal(v.proposal.arenaKb, Math.ceil(facts.arenaBytes / 1024))
	assert.match(readFileSync(join(dir, "fw/include/model.h"), "utf8"), new RegExp(`MODEL_ARENA_BYTES ${v.proposal.arenaKb * 1024}`))
})
