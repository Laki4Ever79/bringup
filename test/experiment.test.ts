import { test } from "node:test"
import assert from "node:assert/strict"
import { BringupState, emit, join, startRuntime } from "../src/runtime.ts"
import { BuildLock, createBuilder } from "../src/agents/builders.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { makeEvent } from "../src/events.ts"
import { DesignContract } from "../src/contract/contract.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { stubBoard, stubEnclosure, stubFirmware } from "../src/tools/stubs.ts"
import { CHANGES, settledBase } from "../src/experiment/changes.ts"
import { renderMarkdown, shippedMismatches, type TrialResult } from "../src/experiment/score.ts"
import { runTrial } from "../src/experiment/harness.ts"
import { runExperiment } from "../src/experiment/run.ts"
import { readFileSync, writeFileSync } from "node:fs"
import { join as joinPath } from "node:path"
import { ROOT } from "../src/run.ts"
import { fixtureArtifacts } from "./fixture.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

test("builders sharing a BuildLock never build at the same time (arm C)", async () => {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const events = recorder()
	const desk = createChangeDesk()
	join(desk)
	const lock = new BuildLock()
	let running = 0
	let maxRunning = 0
	const slow = async () => {
		running++
		maxRunning = Math.max(maxRunning, running)
		await new Promise((r) => setTimeout(r, 30))
		running--
	}
	join(createBuilder({ kind: "enclosure", inputs: ["outline"], lock, build: async ({ revision }) => (await slow(), { ...fixtureArtifacts().enclosure!, revision }) }))
	join(createBuilder({ kind: "board", inputs: ["outline"], lock, build: async ({ revision }) => (await slow(), { ...fixtureArtifacts().board!, revision }) }))
	const r = state.contract.propose({ field: "outline", value: { widthMm: 50, heightMm: 30, thicknessMm: 1.6 }, by: "architect", baseVersion: 0 })
	if (r.status !== "applied") throw new Error(r.status)
	emit(makeEvent("contract.changed", desk.getId(), { field: "outline", version: r.version, revision: r.revision, by: "architect" }), desk.getId())
	await waitFor(() => events.filter((e) => e.type === "artifact.ready").length === 2)
	assert.equal(maxRunning, 1)
})

test("builders without a lock still build concurrently", async () => {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const events = recorder()
	const desk = createChangeDesk()
	join(desk)
	let running = 0
	let maxRunning = 0
	const slow = async () => {
		running++
		maxRunning = Math.max(maxRunning, running)
		await new Promise((r) => setTimeout(r, 30))
		running--
	}
	join(createBuilder({ kind: "enclosure", inputs: ["outline"], build: async ({ revision }) => (await slow(), { ...fixtureArtifacts().enclosure!, revision }) }))
	join(createBuilder({ kind: "board", inputs: ["outline"], build: async ({ revision }) => (await slow(), { ...fixtureArtifacts().board!, revision }) }))
	const r = state.contract.propose({ field: "outline", value: { widthMm: 50, heightMm: 30, thicknessMm: 1.6 }, by: "architect", baseVersion: 0 })
	if (r.status !== "applied") throw new Error(r.status)
	emit(makeEvent("contract.changed", desk.getId(), { field: "outline", version: r.version, revision: r.revision, by: "architect" }), desk.getId())
	await waitFor(() => events.filter((e) => e.type === "artifact.ready").length === 2)
	assert.equal(maxRunning, 2)
})

// Applies every proposal of a change to a contract holding the settled mock design; returns the contract.
function applied(id: string): DesignContract {
	const c = new DesignContract()
	c.setCatalog(loadCatalog(ROOT))
	for (const [field, value] of Object.entries(settledBase())) {
		const owner = field === "parts" ? "parts" : field === "behavior" ? "firmware" : "architect"
		const r = c.propose({ field: field as never, value: value as never, by: owner, baseVersion: 0 })
		assert.equal(r.status, "applied", `${field}: ${JSON.stringify(r)}`)
	}
	const change = CHANGES.find((x) => x.id === id)!
	for (const p of change.proposals(c.snapshot())) {
		const r = c.propose({ ...p, baseVersion: c.version(p.field) })
		assert.equal(r.status, "applied", `${id} ${p.field}: ${JSON.stringify(r)}`)
	}
	return c
}

test("every experiment change is a valid write by the fields' owners", () => {
	assert.ok(CHANGES.length >= 4 && CHANGES.length <= 6)
	for (const change of CHANGES) applied(change.id)
})

test("the button change crosses three domains: parts, pins and connectors", () => {
	const button = CHANGES.find((c) => c.id === "add-button")!
	assert.deepEqual(button.proposals(applied("add-button").snapshot()).map((p) => p.field).sort(), ["connectors", "parts", "pins"])
})

test("arm B: an I2C move only the firmware heard of ships a board routed to the old GPIOs", () => {
	const truth = applied("i2c-pins").snapshot()
	const baseSnap = { ...truth, values: { ...truth.values, pins: settledBase().pins } }
	const dir = tempDir()
	const baseArtifacts = { board: stubBoard(baseSnap, 1, dir), enclosure: stubEnclosure(baseSnap, 1, dir), firmware: stubFirmware(baseSnap, 1, dir) }
	const receiverArtifact = stubFirmware(truth, 2, dir)
	const shipped = shippedMismatches(truth, baseArtifacts, "firmware", receiverArtifact)
	assert.ok(shipped.length >= 2)
	assert.ok(shipped.every((v) => v.kind === "net-missing"))
	assert.ok(shipped.some((v) => /I2C_SDA.*GPIO4/.test(v.message)), JSON.stringify(shipped))
})

test("the experiment table names each change, arm A's numbers and arm B's shipped mismatches", () => {
	const r: TrialResult = {
		change: "i2c-pins",
		label: "Move the sensor's I2C pins",
		receiver: "firmware",
		armA: { ms: 41_200, woken: ["board-builder", "firmware-builder"], workers: 7, violations: [], settled: true },
		armB: { shipped: [{ kind: "net-missing", message: "net I2C_SDA does not connect U1.GPIO4", fields: ["pins"], affects: ["board"] }] },
		armC: { ms: 70_100, settled: true },
	}
	const md = renderMarkdown([r], { tools: "real", date: "2026-10-31" })
	assert.match(md, /\| Move the sensor's I2C pins \|/)
	assert.match(md, /41\.2 s/)
	assert.match(md, /2 of 7/)
	assert.match(md, /net I2C_SDA does not connect U1\.GPIO4/)
	assert.match(md, /70\.1 s/)
})

test("arm A with stub builders: the change settles again with 0 violations and wakes only what it touches", { timeout: 60_000 }, async () => {
	const r = await runTrial({ change: CHANGES.find((c) => c.id === "i2c-pins")!, arm: "A", outDir: tempDir(), noHardware: true })
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	assert.ok(r.woken.includes("board-builder") && r.woken.includes("firmware-builder"), r.woken.join())
	assert.ok(!r.woken.includes("enclosure-builder"), r.woken.join())
	assert.ok(r.ms > 0)
	assert.ok(r.baseArtifacts.board && r.finalArtifacts.firmware)
})

test("the write-up carries the honest method note", () => {
	const md = renderMarkdown([], { tools: "real", date: "2026-10-31" })
	assert.match(md, /scripted/i)
	assert.match(md, /simulated/i)
})

test("runExperiment writes results.json and the table, one trial per change and arm", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const docs = joinPath(tempDir(), "experiment.md")
	const results = await runExperiment({ outDir: out, docsPath: docs, noHardware: true, only: ["i2c-pins", "add-button"], armC: true })
	assert.deepEqual(results.map((r) => r.change), ["i2c-pins", "add-button"])
	const saved = JSON.parse(readFileSync(joinPath(out, "results.json"), "utf8"))
	assert.equal(saved.results.length, 2)
	assert.ok(results.every((r) => r.armA.settled && r.armA.violations.length === 0 && r.armC?.settled))
	const button = results[1]
	assert.ok(button.armB.shipped.some((v) => v.kind === "net-missing" && /BUTTON/.test(v.message)))
	assert.ok(button.armB.shipped.some((v) => v.kind === "cutout-missing" && /SW1/.test(v.message)))
	assert.match(readFileSync(docs, "utf8"), /Add a user button/)
})

test("arm B: an LDO swap only the firmware heard of ships a board with the old regulator, now that parts are checked", () => {
	const truth = applied("ldo-swap").snapshot()
	const baseSnap = { ...truth, values: { ...truth.values, parts: settledBase().parts } }
	const dir = tempDir()
	const base = { board: stubBoard(baseSnap, 1, dir), enclosure: stubEnclosure(baseSnap, 1, dir), firmware: stubFirmware(baseSnap, 1, dir) }
	const shipped = shippedMismatches(truth, base, "firmware", stubFirmware(truth, 2, dir))
	assert.deepEqual(shipped.map((v) => v.message), ["board places AP2112K-3.3TRG1 as U3, contract says XC6206P332MR-G"])
})

test("--only merges its trials into the saved results, keeping the change order and the other trials", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const resultsPath = joinPath(out, "experiment-results.json")
	const old = (change: string) => ({ change, label: change, receiver: "board", armA: { ms: 1, woken: [], workers: 7, violations: [], settled: true }, armB: { shipped: [] } })
	writeFileSync(resultsPath, JSON.stringify({ date: "2026-10-30", tools: "real", workers: [], results: [old("narrower"), old("i2c-pins")], runs: { narrower: { A: {} }, "i2c-pins": { A: {} } } }))
	await runExperiment({ outDir: out, docsPath: joinPath(out, "experiment.md"), resultsPath, noHardware: true, only: ["i2c-pins"] })
	const saved = JSON.parse(readFileSync(resultsPath, "utf8"))
	assert.deepEqual(saved.results.map((r: { change: string }) => r.change), ["narrower", "i2c-pins"])
	assert.equal(saved.results[0].armA.ms, 1, "the trial not rerun is kept as it was")
	assert.notEqual(saved.results[1].armA.ms, 1, "the rerun trial is replaced")
	assert.deepEqual(Object.keys(saved.runs).sort(), ["i2c-pins", "narrower"])
	assert.match(readFileSync(joinPath(out, "experiment.md"), "utf8"), /\| narrower \|/)
})
