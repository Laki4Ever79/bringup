import { test } from "node:test"
import assert from "node:assert/strict"
import { BringupState, emit, join, startRuntime } from "../src/runtime.ts"
import { createBuilder } from "../src/agents/builders.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { makeEvent } from "../src/events.ts"
import { fixtureArtifacts } from "./fixture.ts"
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
