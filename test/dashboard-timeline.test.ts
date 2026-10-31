import assert from "node:assert/strict"
import { test } from "node:test"
import { rippleTimeline } from "../src/dashboard/changelog.js"

// The timeline beside 03 Agents: how the change travelled, step by step, with times from the request.
const T0 = Date.parse("2026-10-31T12:00:00.000Z")
let seq = 0
const ev = (s: number, type: string, payload: object) => ({ seq: seq++, at: new Date(T0 + s * 1000).toISOString(), type, producerId: "x", payload })
const outline = (w: number) => ({ widthMm: w, heightMm: 30, thicknessMm: 1.6 })

const events = [
	ev(0, "change.requested", { id: "req-1", text: "make it 40 mm wide" }),
	ev(0.5, "agent.activity", { role: "architect", phase: "turn", text: "reading" }),
	ev(2.1, "contract.changed", { field: "outline", version: 2, revision: 8, by: "architect", before: outline(50), after: outline(40) }),
	ev(2.3, "consistency.checked", { revision: 8, violations: [{ kind: "outline-mismatch" }, { kind: "standoff-mismatch" }] }),
	ev(14, "artifact.ready", { kind: "board", revision: 8, drc: { errors: 0 } }),
	ev(18, "artifact.ready", { kind: "enclosure", revision: 8 }),
	ev(19.6, "consistency.checked", { revision: 8, violations: [] }),
]

test("a change's timeline: asked, who changed what, mismatches, rebuilds, consistent, with times from the request", () => {
	const steps = rippleTimeline(events, { fromMs: T0, consistentAtMs: T0 + 19_600 })
	assert.deepEqual(steps.map((s) => `${s.t}  ${s.text}`), [
		"+0.0 s  you asked “make it 40 mm wide”",
		"+2.1 s  architect: outline 50×30 → 40×30 mm",
		"+2.3 s  2 mismatches: board and case outlines differ",
		"+14 s  board rebuilt · rev 8",
		"+18 s  case rebuilt · rev 8",
		"+20 s  consistent: board, case and firmware agree",
	])
	assert.ok(steps.every((s) => typeof s.key === "string"), "a stable key per step, so only new steps animate in")
})

test("a file edit starts with the file; the window ends at toMs; a long first design keeps its latest steps", () => {
	const fileReq = ev(0, "change.requested", { id: "req-2", text: "edited pins.h: I2C_SDA GPIO8 → GPIO4", source: { kind: "file", path: "firmware/rev-7/include/pins.h", revision: 7, items: ["I2C_SDA GPIO8 → GPIO4"] } })
	assert.equal(rippleTimeline([fileReq], { fromMs: T0 })[0].text, "you edited pins.h: I2C_SDA GPIO8 → GPIO4")
	assert.equal(rippleTimeline(events, { fromMs: T0, toMs: T0 + 10_000 }).length, 3)
	// The first design: many writes; the list keeps the newest, and says how many came before.
	const many = Array.from({ length: 12 }, (_, i) => ev(i, "contract.changed", { field: `f${i}`, version: 1, revision: i + 1, by: "architect" }))
	const steps = rippleTimeline(many, { fromMs: T0, max: 6, start: "the brief: pocket climate logger" })
	assert.equal(steps.length, 6)
	assert.equal(steps[0].text, "… 8 earlier steps")
	assert.equal(steps.at(-1)?.text, "architect set f11")
})

test("the bench and QEMU steps, and a failed build", () => {
	const more = [
		ev(1, "change.requested", { id: "req-3", text: "blink faster when tilted" }),
		ev(5, "artifact.failed", { kind: "firmware", revision: 9, error: "x" }),
		ev(9, "firmware.booted", { revision: 9, booted: true, bootRevision: 9 }),
		ev(20, "bench.flashed", { revision: 9, ok: true, ms: 8000 }),
		ev(40, "bench.blink", { revision: 9, pass: true, tiltBlinkMs: 250, blinkMs: 1000 }),
	]
	assert.deepEqual(rippleTimeline(more, { fromMs: T0 + 1000 }).map((s) => s.text), ["you asked “blink faster when tilted”", "firmware build failed · rev 9", "firmware boots in QEMU · rev 9", "flashed the real board · rev 9", "measured on the board: tilted 250 ms ✓"])
})

test("steps are in time order (the consistent step lands where it happened), and diffs read without their +/~ marks", () => {
	const evs = [
		ev(0, "change.requested", { id: "req-4", text: "blink faster when tilted" }),
		ev(3, "contract.changed", { field: "behavior", version: 2, revision: 9, by: "firmware", before: { blinkMs: 1000, tiltBlinkMs: 1000, tiltDeg: 90 }, after: { blinkMs: 1000, tiltBlinkMs: 250, tiltDeg: 20 } }),
		ev(28, "bench.flashed", { revision: 9, ok: true, ms: 8000 }),
	]
	const steps = rippleTimeline(evs, { fromMs: T0, consistentAtMs: T0 + 18_000 })
	assert.deepEqual(steps.map((s) => s.t), ["+0.0 s", "+3.0 s", "+18 s", "+28 s"])
	assert.equal(steps[1].text, "firmware agent: tiltBlinkMs 1000 → 250")
})
