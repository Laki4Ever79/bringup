import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { changeRipples, type TraceEvent } from "../src/runner/ripple.ts"
import { runDesign } from "../src/run.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { ROOT } from "../src/run.ts"
import { tempDir } from "./helpers.ts"

const T0 = Date.parse("2026-10-31T10:00:00.000Z")
let seq = 0
const ev = (ms: number, type: string, payload: unknown): TraceEvent => ({ seq: seq++, at: new Date(T0 + ms).toISOString(), type, producerId: "p", payload })
const turn = (ms: number, role: string) => ev(ms, "agent.activity", { role, phase: "turn", text: "" })
const checked = (ms: number, revision: number, n: number) => ev(ms, "consistency.checked", { revision, violations: Array.from({ length: n }, () => ({ kind: "x", message: "m", affects: [] })) })

// The shape of a mock run with "make the board 60 mm wide" (out/demo-20261030-133550, plus change.requested).
function sixtyMmTrace(): TraceEvent[] {
	return [
		ev(0, "run.started", {}),
		turn(1, "architect"),
		turn(2, "parts"),
		turn(3, "firmware"),
		ev(10, "contract.changed", { field: "outline", version: 1, revision: 3, by: "architect" }),
		ev(500, "artifact.ready", { kind: "board", revision: 7 }),
		ev(600, "artifact.ready", { kind: "enclosure", revision: 7 }),
		ev(700, "artifact.ready", { kind: "firmware", revision: 7 }),
		ev(800, "firmware.booted", { revision: 7, booted: true, bootRevision: 7, serialTail: "" }),
		checked(800, 7, 0),
		ev(17_000, "change.requested", { id: "req-1", text: "make the board 60 mm wide" }),
		turn(17_001, "architect"),
		ev(17_005, "contract.changed", { field: "outline", version: 2, revision: 8, by: "architect" }),
		// Right after the change nothing is rebuilt yet: zero violations here is not "consistent again".
		checked(17_005, 8, 0),
		ev(21_000, "artifact.ready", { kind: "enclosure", revision: 8 }),
		checked(21_000, 8, 2),
		ev(30_000, "artifact.ready", { kind: "board", revision: 8 }),
		checked(30_000, 8, 0),
		ev(31_500, "design.ready", { revision: 8, round: 1 }),
		turn(31_600, "reviewer"),
		ev(31_700, "design.settled", { revision: 8, settled: true }),
	]
}

test("the 60 mm request changes the outline, wakes board and enclosure, leaves firmware idle", () => {
	const [r] = changeRipples(sixtyMmTrace())
	assert.equal(r.id, "req-1")
	assert.equal(r.text, "make the board 60 mm wide")
	assert.equal(r.atMs, 17_000)
	assert.deepEqual(r.fieldsChanged, ["outline"])
	assert.deepEqual(r.woke, ["architect", "build:board", "build:enclosure", "consistency"])
	// The reviewer's turn comes after design.ready: the review, not the change itself.
	assert.deepEqual(r.checked, [])
	assert.deepEqual(r.stayedIdle, ["parts", "firmware", "reviewer", "build:firmware", "grounding"])
	assert.deepEqual(r.reviewFollowUps, { fieldsChanged: [], rounds: 0 })
	assert.equal(r.violationsPeak, 2)
	assert.equal(r.consistentAtMs, 30_000, "after the woken builders are done, not the 0 right after the change")
	assert.equal(r.durationMs, 13_000)
})

test("a request that changes nothing never becomes 'consistent again', and a second request has its own window", () => {
	const trace = [
		...sixtyMmTrace(),
		ev(40_000, "change.requested", { id: "req-2", text: "make it prettier" }),
		turn(40_001, "architect"),
		ev(45_000, "change.requested", { id: "req-3", text: "use a different sensor" }),
		ev(45_010, "contract.changed", { field: "parts", version: 3, revision: 9, by: "parts" }),
		ev(45_020, "contract.changed", { field: "pins", version: 3, revision: 10, by: "architect" }),
		checked(45_020, 10, 1),
		ev(46_000, "artifact.ready", { kind: "board", revision: 9 }),
		ev(46_500, "artifact.ready", { kind: "enclosure", revision: 9 }),
		ev(47_000, "artifact.ready", { kind: "firmware", revision: 10 }),
		// The board built revision 9, before the pins changed: not done yet.
		checked(47_000, 10, 0),
		ev(50_000, "artifact.failed", { kind: "board", revision: 10, error: "route" }),
		checked(50_000, 10, 0),
	]
	const [, prettier, sensor] = changeRipples(trace)
	assert.deepEqual(prettier.fieldsChanged, [])
	assert.deepEqual(prettier.woke, [], "nothing changed, so not even the consistency check had work")
	assert.deepEqual(prettier.checked, ["architect"])
	assert.equal(prettier.consistentAtMs, null)
	assert.equal(prettier.durationMs, null)
	assert.deepEqual(sensor.fieldsChanged, ["parts", "pins"])
	// The case depends on the parts too (a sensor gets a vent over it), so a parts change wakes the enclosure builder.
	assert.deepEqual(sensor.woke, ["architect", "parts", "build:board", "build:enclosure", "build:firmware", "grounding", "consistency"], "agents that changed a field woke, turn or not")
	assert.deepEqual(sensor.checked, [])
	assert.equal(sensor.violationsPeak, 1)
	assert.equal(sensor.consistentAtMs, 50_000)
	assert.equal(sensor.durationMs, 5_000)
})

test("a clean check before the builds finish counts once the last woken build is done (checks are only emitted on change)", () => {
	const trace = [
		ev(0, "run.started", {}),
		checked(1, 7, 0),
		ev(108_000, "change.requested", { id: "req-1", text: "make the board 60 mm wide" }),
		ev(108_010, "contract.changed", { field: "outline", version: 2, revision: 8, by: "architect" }),
		checked(109_000, 8, 0),
		ev(125_000, "artifact.ready", { kind: "board", revision: 8 }),
		ev(138_000, "artifact.ready", { kind: "enclosure", revision: 8 }),
	]
	const [r] = changeRipples(trace)
	assert.equal(r.consistentAtMs, 138_000)
	assert.equal(r.durationMs, 30_000)
})

test("violations after the builds are done undo 'consistent' until a clean check", () => {
	const trace = [
		ev(0, "run.started", {}),
		ev(1_000, "change.requested", { id: "req-1", text: "x" }),
		ev(1_010, "contract.changed", { field: "outline", version: 2, revision: 8, by: "architect" }),
		checked(1_010, 8, 0),
		ev(2_000, "artifact.ready", { kind: "enclosure", revision: 8 }),
		ev(3_000, "artifact.ready", { kind: "board", revision: 8 }),
		checked(3_000, 8, 1),
		checked(4_000, 8, 0),
	]
	assert.equal(changeRipples(trace)[0].consistentAtMs, 4_000)
})

test("a held proposal counts as woken; a participant outside the 9 lanes (the bench) is left out", () => {
	const trace = [
		ev(0, "run.started", {}),
		ev(1_000, "change.requested", { id: "req-1", text: "x" }),
		turn(1_001, "firmware"),
		ev(1_002, "change.proposed", { proposalId: "p1", field: "pins", by: "firmware", reason: "", needsEngineer: false }),
		ev(1_003, "contract.changed", { field: "rails", version: 2, revision: 9, by: "bench" }),
	]
	const [r] = changeRipples(trace)
	assert.deepEqual(r.woke, ["firmware", "consistency"])
	assert.equal(r.woke.length + r.checked.length + r.stayedIdle.length, 9)
})

// Real run 15: each re-settle re-arms the review, and its fix rounds changed requirements, rails and parts. Counted as
// the request's ripple, they turned a 49 s width change into "430 s, 4 fields".
test("a ripple ends at the first design.ready after its request; what the review rounds change after it is listed apart", () => {
	const trace = [
		ev(0, "run.started", {}),
		checked(1, 19, 0),
		ev(828_000, "change.requested", { id: "req-1", text: "make the board 40 mm wide" }),
		turn(828_001, "architect"),
		ev(831_000, "contract.changed", { field: "outline", version: 2, revision: 20, by: "architect" }),
		checked(831_000, 20, 1),
		ev(843_000, "artifact.ready", { kind: "enclosure", revision: 20 }),
		checked(843_000, 20, 3),
		ev(877_000, "artifact.ready", { kind: "board", revision: 20 }),
		checked(877_000, 20, 0),
		ev(879_000, "design.ready", { revision: 20, round: 1 }),
		turn(879_100, "reviewer"),
		ev(890_000, "review.completed", { revision: 20, verdict: "fail", findings: [] }),
		turn(890_100, "parts"),
		ev(899_000, "contract.changed", { field: "requirements", version: 3, revision: 21, by: "architect" }),
		ev(913_000, "contract.changed", { field: "parts", version: 4, revision: 22, by: "parts" }),
		checked(913_000, 22, 1),
		ev(1_178_000, "design.ready", { revision: 22, round: 2 }),
		ev(1_190_000, "review.completed", { revision: 22, verdict: "fail", findings: [] }),
		ev(1_200_000, "contract.changed", { field: "rails", version: 3, revision: 23, by: "parts" }),
		ev(1_250_000, "review.completed", { revision: 23, verdict: "fail", findings: [] }),
	]
	const [r] = changeRipples(trace)
	assert.deepEqual(r.fieldsChanged, ["outline"])
	assert.deepEqual(r.woke, ["architect", "build:board", "build:enclosure", "consistency"])
	assert.deepEqual(r.checked, [])
	assert.equal(r.violationsPeak, 3)
	assert.equal(r.consistentAtMs, 877_000)
	assert.equal(r.durationMs, 49_000)
	assert.deepEqual(r.reviewFollowUps, { fieldsChanged: ["requirements", "parts", "rails"], rounds: 3 })
})

test("no change.requested, no ripples", () => {
	assert.deepEqual(changeRipples(sixtyMmTrace().filter((e) => e.type !== "change.requested")), [])
})

test("a mock run with a mid-run 60 mm request writes ripples.json and a Change requests table", { timeout: 60_000 }, async () => {
	const out = tempDir()
	const env = await detectEnvironment(ROOT)
	const r = await runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, noHardware: true, outDir: out, env, timeoutMs: 50_000, changes: ["make the board 60 mm wide"] })
	assert.ok(r.settled)
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8")
	assert.ok(trace.indexOf('"design.settled"') < trace.indexOf('"change.requested"'), "the request goes out after the first settle")
	assert.match(readFileSync(join(out, "requests.jsonl"), "utf8"), /make the board 60 mm wide/)

	const file = JSON.parse(readFileSync(join(out, "ripples.json"), "utf8"))
	assert.equal(file.requests.length, 1)
	const ripple = file.requests[0]
	assert.equal(ripple.text, "make the board 60 mm wide")
	assert.ok(ripple.fieldsChanged.includes("outline"))
	assert.ok(ripple.woke.includes("build:board") && ripple.woke.includes("build:enclosure"), JSON.stringify(ripple))
	assert.ok(ripple.stayedIdle.includes("build:firmware"), JSON.stringify(ripple))
	assert.ok(ripple.checked.includes("firmware"), "the firmware agent reads every request, but changes nothing for a width")
	assert.equal(typeof ripple.durationMs, "number")
	assert.deepEqual(ripple.reviewFollowUps, { fieldsChanged: [], rounds: 1 }, "the mock reviewer passes the first review")
	assert.ok(ripple.durationMs > 0)

	const report = readFileSync(join(out, "report.md"), "utf8")
	assert.match(report, /## Change requests/)
	assert.match(report, /\| Request \| Fields changed \| Woken \| Consistent again \| After it \|/)
	assert.match(report, /\| make the board 60 mm wide \| outline \| .* \(\d+ of 9; \d+ more checked, no change: [a-z, ]+\) \| \d+(\.\d)? s \| then 1 review round changed nothing \|/)
})

test("each scripted change adds its own time to the run's default timeout", async () => {
	const { runTimeoutMs } = await import("../src/run.ts")
	assert.equal(runTimeoutMs({}), 30 * 60_000)
	assert.equal(runTimeoutMs({ changes: ["a", "b"] }), 70 * 60_000)
	assert.equal(runTimeoutMs({ timeoutMs: 5_000, changes: ["a"] }), 5_000, "an explicit timeout wins")
})

test("scripted changes start only after a first settle that reached a consistent design", async () => {
	const { changesMayStart } = await import("../src/run.ts")
	assert.equal(changesMayStart({ settled: true, revision: 7 }, 0), true, "settled (no review)")
	assert.equal(changesMayStart({ settled: false, revision: 9 }, 2), true, "reviewed and failed: still a whole design to change")
	assert.equal(changesMayStart({ settled: false, revision: 5 }, 0), false, "stuck before design.ready (real-11: no pins), nothing to ripple through")
})

test("a --mock --no-hardware run makes no network requests", { timeout: 60_000 }, async () => {
	const out = tempDir()
	const env = await detectEnvironment(ROOT)
	const real = globalThis.fetch
	const urls: string[] = []
	globalThis.fetch = (async (input: string | URL | Request) => {
		urls.push(String(input))
		throw new TypeError("no network in a mock run")
	}) as typeof fetch
	try {
		const r = await runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, noHardware: true, outDir: out, env })
		assert.ok(r.settled)
	} finally {
		globalThis.fetch = real
	}
	assert.deepEqual(urls, [])
	assert.match(readFileSync(join(out, "report.md"), "utf8"), /^- Sourcing: \d+\/\d+ at LCSC\/JLCPCB · stock not checked \(mock run\)$/m)
})

// Real run 16: the design already used the SHTC3, so "the SHT40 is out of stock" changed nothing, nothing re-armed the
// settled design, and the run sat idle for the full 20-minute change timeout.
test("a scripted request that changes nothing re-settles as soon as the agents are done, not after the timeout", { timeout: 60_000 }, async () => {
	const out = tempDir()
	const env = await detectEnvironment(ROOT)
	const started = Date.now()
	const r = await runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, noHardware: true, outDir: out, env, changes: ["make it prettier"], changeTimeoutMs: 40_000 })
	assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`)
	assert.ok(r.settled)
	const [row] = JSON.parse(readFileSync(join(out, "ripples.json"), "utf8")).requests
	assert.deepEqual(row.fieldsChanged, [])
	assert.deepEqual(row.checked.includes("architect"), true)
})

test("the live ripples.json picks up an agent's turn on a request that changes nothing", async () => {
	const { createRippleRecorder } = await import("../src/runner/ripple.ts")
	const { BringupState, emit, join: joinRt, startRuntime } = await import("../src/runtime.ts")
	const { makeEvent } = await import("../src/events.ts")
	const out = tempDir()
	startRuntime(new BringupState(out), undefined, null)
	const { createHuman } = await import("@mozaik-ai/core")
	const sender = createHuman({ name: "sender", capabilities: [], handlers: [] })
	joinRt(sender)
	joinRt(createRippleRecorder(out))
	const id = sender.getId()
	emit(makeEvent("run.started", id, { review: true, engineerApproval: false, noHardware: true, bench: false }), id)
	emit(makeEvent("change.requested", id, { id: "req-1", text: "x" }), id)
	emit(makeEvent("agent.activity", id, { agentId: "a", role: "architect", name: "architect", phase: "turn", text: "x", at: new Date().toISOString() }), id)
	const [row] = JSON.parse(readFileSync(join(out, "ripples.json"), "utf8")).requests
	assert.deepEqual(row.checked, ["architect"])
})
