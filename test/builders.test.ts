import { test } from "node:test"
import assert from "node:assert/strict"
import { BringupState, emit, join, startRuntime } from "../src/runtime.ts"
import { createBuilder } from "../src/agents/builders.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { stubBoard, stubEnclosure } from "../src/tools/stubs.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { makeEvent } from "../src/events.ts"
import { fixtureArtifacts, fixtureContract } from "./fixture.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

function setup(build: (revision: number) => Promise<unknown>) {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const events = recorder()
	const desk = createChangeDesk()
	join(desk)
	const builds: number[] = []
	join(
		createBuilder({
			kind: "enclosure",
			inputs: ["outline", "connectors"],
			build: async ({ revision }) => {
				builds.push(revision)
				return (await build(revision)) as never
			},
		}),
	)
	// Applies a real change to the contract, then announces it the way the contract tools do.
	const change = (field: "outline" | "pins") => {
		const value = field === "outline" ? { widthMm: 50, heightMm: 30, thicknessMm: 1.6 } : []
		const r = state.contract.propose({ field, value, by: "architect", baseVersion: state.contract.version(field) } as never)
		if (r.status !== "applied") throw new Error(r.status)
		emit(makeEvent("contract.changed", desk.getId(), { field, version: r.version, revision: r.revision, by: "architect" }), desk.getId())
	}
	return { state, events, builds, change }
}

test("builder rebuilds when one of its inputs changes", async () => {
	const t = setup(async (revision) => ({ ...fixtureArtifacts().enclosure!, revision }))
	t.change("outline")
	await waitFor(() => t.events.some((e) => e.type === "artifact.ready"))
	assert.deepEqual(t.builds, [1])
	assert.equal(t.state.artifacts.enclosure?.revision, 1)
	assert.deepEqual(t.events.find((e) => e.type === "artifact.ready")!.payload, { kind: "enclosure", revision: 1 })
})

test("builder ignores fields it does not depend on", async () => {
	const t = setup(async (revision) => ({ ...fixtureArtifacts().enclosure!, revision }))
	t.change("pins")
	await new Promise((r) => setTimeout(r, 50))
	assert.deepEqual(t.builds, [])
})

test("a failed build is reported, not thrown", async () => {
	const t = setup(async () => {
		throw new Error("tool exploded")
	})
	t.change("outline")
	await waitFor(() => t.events.some((e) => e.type === "artifact.failed"))
	const failed = t.events.find((e) => e.type === "artifact.failed")!.payload as { error: string; revision: number }
	assert.equal(failed.revision, 1)
	assert.match(failed.error, /tool exploded/)
	assert.equal(t.state.artifacts.enclosure, undefined)
})

test("a build that reports failure is stored and announced as failed", async () => {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const events = recorder()
	const desk = createChangeDesk()
	join(desk)
	join(
		createBuilder({
			kind: "firmware",
			inputs: ["pins"],
			build: async ({ revision }) => ({ revision, ok: false, pins: {}, log: "static assertion failed" }),
			failure: (a) => (a.ok ? null : a.log),
		}),
	)
	const r = state.contract.propose({ field: "pins", value: [], by: "architect", baseVersion: 0 })
	if (r.status !== "applied") throw new Error(r.status)
	emit(makeEvent("contract.changed", desk.getId(), { field: "pins", version: 1, revision: r.revision, by: "architect" }), desk.getId())
	await waitFor(() => events.some((e) => e.type === "artifact.failed"))
	assert.equal(state.artifacts.firmware?.ok, false)
	assert.match((events.find((e) => e.type === "artifact.failed")!.payload as { error: string }).error, /static assertion/)
})

test("artifacts record the input versions they were built from", async () => {
	const t = setup(async (revision) => ({ ...fixtureArtifacts().enclosure!, revision }))
	t.change("outline")
	await waitFor(() => t.events.some((e) => e.type === "artifact.ready"))
	assert.deepEqual(t.state.artifactInputs.enclosure, { outline: 1, connectors: 0 })
})

test("a build that fails before it starts is reported as failed", async () => {
	const { writeFileSync } = await import("node:fs")
	const { join: joinPath } = await import("node:path")
	const root = tempDir()
	const outFile = joinPath(root, "not-a-dir")
	writeFileSync(outFile, "")
	const state = new BringupState(outFile)
	startRuntime(state, undefined, null)
	const events = recorder()
	const desk = createChangeDesk()
	join(desk)
	join(createBuilder({ kind: "enclosure", inputs: ["outline"], build: async ({ revision }) => ({ ...fixtureArtifacts().enclosure!, revision }) }))
	const r = state.contract.propose({ field: "outline", value: { widthMm: 50, heightMm: 30, thicknessMm: 1.6 }, by: "architect", baseVersion: 0 })
	if (r.status !== "applied") throw new Error(r.status)
	emit(makeEvent("contract.changed", desk.getId(), { field: "outline", version: 1, revision: r.revision, by: "architect" }), desk.getId())
	await waitFor(() => events.some((e) => e.type === "artifact.failed"))
	assert.ok(state.artifactInputs.enclosure, "inputs recorded so settling can proceed")
})

test("a builder with required inputs skips silently until they all exist", async () => {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const events = recorder()
	const desk = createChangeDesk()
	join(desk)
	const builds: number[] = []
	join(
		createBuilder({
			kind: "board",
			inputs: ["parts", "pins", "outline", "connectors"],
			requires: ["outline", "parts", "pins"],
			build: async ({ revision }) => {
				builds.push(revision)
				return { ...fixtureArtifacts().board!, revision }
			},
		}),
	)
	const v = fixtureContract().values
	const write = (field: "parts" | "pins" | "outline") => {
		const r = state.contract.propose({ field, value: v[field]!, by: field === "parts" ? "parts" : "architect", baseVersion: state.contract.version(field) } as never)
		if (r.status !== "applied") throw new Error(r.status)
		emit(makeEvent("contract.changed", desk.getId(), { field, version: r.version, revision: r.revision, by: "architect" }), desk.getId())
	}
	write("parts")
	write("pins")
	await new Promise((r) => setTimeout(r, 100))
	assert.deepEqual(builds, [])
	assert.ok(!events.some((e) => e.type === "artifact.failed" || e.type === "artifact.ready"))
	assert.equal(state.artifactInputs.board, undefined, "a skip records no inputs, so the board is not current")
	write("outline")
	await waitFor(() => events.some((e) => e.type === "artifact.ready"))
	assert.deepEqual(builds, [3])
})

test("stubs report the board's mounting holes and the case's standoffs from the same contract", () => {
	const s = fixtureContract()
	const dir = tempDir()
	const board = stubBoard(s, 1, dir)
	const enclosure = stubEnclosure(s, 1, dir)
	assert.equal(board.holes!.length, 4)
	assert.deepEqual(enclosure.standoffs!.map((p) => [p.xMm, p.yMm]), board.holes!.map((h) => [h.xMm, h.yMm]))
	assert.deepEqual(checkConsistency(s, { board, enclosure }).filter((v) => v.kind === "standoff-mismatch"), [])
})
