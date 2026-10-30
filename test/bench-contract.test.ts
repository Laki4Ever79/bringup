import { test } from "node:test"
import assert from "node:assert/strict"
import { DesignContract } from "../src/contract/contract.ts"
import { behaviorHeader } from "../src/codegen/firmware.ts"
import { OWNERS } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const rails = [
	{ name: "VBUS", voltageV: 5, regulatorMaxMa: 500, loadMa: 150 },
	{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 120, averageMa: 0.0375 },
]

function withRails(): DesignContract {
	const c = new DesignContract()
	c.propose({ field: "rails", value: rails, by: "architect", baseVersion: 0 })
	return c
}

test("the firmware agent owns behavior", () => {
	assert.equal(OWNERS.behavior, "firmware")
	const c = new DesignContract()
	const r = c.propose({ field: "behavior", value: { blinkMs: 1000, tiltBlinkMs: 100, tiltDeg: 20 }, by: "firmware", baseVersion: 0 })
	assert.deepEqual(r, { status: "applied", version: 1, revision: 1 })
})

test("behavior must be positive blink periods and a tilt angle from 0 to 90 degrees", () => {
	const c = new DesignContract()
	for (const value of [{ blinkMs: 0, tiltBlinkMs: 100, tiltDeg: 20 }, { blinkMs: 1000, tiltBlinkMs: 100, tiltDeg: 120 }, { blinkMs: 1000 }]) {
		assert.equal(c.propose({ field: "behavior", value: value as never, by: "firmware", baseVersion: 0 }).status, "invalid", JSON.stringify(value))
	}
})

test("a rail may say its average was measured on the bench, and at which revision", () => {
	const c = withRails()
	const measured = [rails[0], { ...rails[1], averageMa: 0.052, averageSource: "measured" as const, measuredRevision: 14 }]
	assert.equal(c.propose({ field: "rails", value: measured, by: "architect", baseVersion: 1 }).status, "applied")
	const bad = [rails[0], { ...rails[1], averageSource: "guessed" }]
	assert.equal(c.propose({ field: "rails", value: bad as never, by: "architect", baseVersion: 2 }).status, "invalid")
})

test("an approved bench proposal may change only averageMa, averageSource and measuredRevision", () => {
	const c = withRails()
	const ok = [rails[0], { ...rails[1], averageMa: 0.052, averageSource: "measured" as const, measuredRevision: 14 }]
	assert.equal(c.propose({ field: "rails", value: ok, by: "bench", baseVersion: 1, approvedBy: "architect" }).status, "applied")
})

test("plain code refuses a bench proposal that touches anything else, even when approved", () => {
	const cases = [
		[rails[0], { ...rails[1], loadMa: 80, averageMa: 0.052, averageSource: "measured", measuredRevision: 14 }],
		[{ ...rails[0], averageMa: 1 }, { ...rails[1], averageMa: 0.052, averageSource: "measured", measuredRevision: 14 }],
		[rails[1]],
	]
	for (const value of cases) {
		const r = withRails().propose({ field: "rails", value: value as never, by: "bench", baseVersion: 1, approvedBy: "architect" })
		assert.equal(r.status, "invalid", JSON.stringify(value))
	}
	const r = withRails().propose({ field: "outline", value: { widthMm: 1, heightMm: 1, thicknessMm: 1 }, by: "bench", baseVersion: 0, approvedBy: "architect" })
	assert.equal(r.status, "invalid")
})

test("behavior.h has defaults without a behavior field, and the contract's values with one", () => {
	const s = fixtureContract()
	assert.match(behaviorHeader(s), /^#define BEHAVIOR_BLINK_MS 1000$/m)
	assert.match(behaviorHeader(s), /^#define BEHAVIOR_TILT_BLINK_MS 1000$/m)
	assert.match(behaviorHeader(s), /^#define BEHAVIOR_TILT_DEG 90$/m)
	s.values.behavior = { blinkMs: 500, tiltBlinkMs: 100, tiltDeg: 20 }
	assert.match(behaviorHeader(s), /^#define BEHAVIOR_TILT_BLINK_MS 100$/m)
	assert.match(behaviorHeader(s), /^#define BEHAVIOR_TILT_DEG 20$/m)
})

test("a behavior change rebuilds the firmware, and the stub writes pins.h and behavior.h for the bench", async () => {
	const { BringupState, emit, join, startRuntime } = await import("../src/runtime.ts")
	const { createStubBuilders } = await import("../src/tools/stubs.ts")
	const { makeEvent } = await import("../src/events.ts")
	const { recorder, tempDir, waitFor } = await import("./helpers.ts")
	const { existsSync, readFileSync } = await import("node:fs")
	const { join: path } = await import("node:path")
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const events = recorder()
	const { createChangeDesk } = await import("../src/change-control.ts")
	const desk = createChangeDesk()
	join(desk)
	for (const b of createStubBuilders()) join(b)
	const f = fixtureContract()
	const write = (field: "parts" | "pins" | "behavior", value: unknown, by: "parts" | "architect" | "firmware") => {
		const r = state.contract.propose({ field, value, by, baseVersion: state.contract.version(field) } as never)
		if (r.status !== "applied") throw new Error(`${field}: ${JSON.stringify(r)}`)
		emit(makeEvent("contract.changed", desk.getId(), { field, version: r.version, revision: r.revision, by }), desk.getId())
	}
	write("parts", f.values.parts, "parts")
	write("pins", f.values.pins, "architect")
	await waitFor(() => events.some((e) => e.type === "artifact.ready" && (e.payload as { kind: string }).kind === "firmware"))
	write("behavior", { blinkMs: 1000, tiltBlinkMs: 100, tiltDeg: 20 }, "firmware")
	await waitFor(() => state.artifacts.firmware?.revision === 3)
	const dir = path(state.outDir, "firmware", "rev-3")
	assert.match(readFileSync(path(dir, "include/behavior.h"), "utf8"), /BEHAVIOR_TILT_BLINK_MS 100/)
	assert.match(readFileSync(path(dir, "include/pins.h"), "utf8"), /BRINGUP_REVISION 3/)
	assert.ok(existsSync(path(dir, "STUB.md")))
})
