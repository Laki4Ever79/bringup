import assert from "node:assert/strict"
import { test } from "node:test"
import { liveRipples, mergeRipples, resultLine, runStart, whatMoved } from "../src/dashboard/ripple.js"

const T0 = Date.parse("2026-10-31T12:00:00.000Z")
let seq = 0
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const ev = (s: number, type: string, payload: object) => ({ seq: seq++, at: at(s), type, producerId: "x", payload })
const changed = (s: number, field: string, version: number, revision: number, by: string) => ev(s, "contract.changed", { field, version, revision, by })
const checked = (s: number, revision: number, n: number) => ev(s, "consistency.checked", { revision, violations: Array.from({ length: n }, () => ({ kind: "fit", message: "x" })) })
const activity = (s: number, role: string, phase: string) => ev(s, "agent.activity", { agentId: `${role}-1`, role, phase, text: phase })

// The initial design, then "make it 60 mm wide" at 100 s: the architect widens the outline and moves a
// connector; board and case rebuild; parts, firmware, the reviewer, the firmware build and grounding stay idle.
const initial = [
	ev(0, "run.started", { review: true }),
	changed(1, "requirements", 1, 1, "architect"),
	changed(2, "parts", 1, 2, "parts"),
	changed(3, "pins", 1, 3, "architect"),
	changed(4, "outline", 1, 4, "architect"),
	changed(5, "connectors", 1, 5, "architect"),
	checked(6, 5, 0),
	ev(30, "artifact.ready", { kind: "board", revision: 5 }),
	ev(31, "artifact.ready", { kind: "enclosure", revision: 5 }),
	ev(32, "artifact.ready", { kind: "firmware", revision: 5 }),
	activity(33, "parts", "answer"),
	activity(33, "firmware", "answer"),
	activity(33, "architect", "answer"),
]
const request = { at: at(100), text: "make it 60 mm wide" }
const ripple = [
	activity(101, "architect", "turn"),
	activity(102, "architect", "tool"),
	changed(104, "outline", 2, 6, "architect"),
	checked(105, 6, 2),
	changed(108, "connectors", 2, 7, "architect"),
	checked(109, 7, 0),
	activity(110, "architect", "answer"),
	ev(125, "artifact.ready", { kind: "board", revision: 7, drc: { errors: 0, warnings: 1, unconnected: 0, rules: "jlcpcb" } }),
	ev(138, "artifact.ready", { kind: "enclosure", revision: 7 }),
]

test("ripple: the fields a request touched, who woke and who stayed idle", () => {
	const [r] = liveRipples([...initial, ...ripple], [request], T0 + 200_000)
	assert.equal(r.text, "make it 60 mm wide")
	assert.equal(r.atMs, T0 + 100_000)
	assert.deepEqual(r.fieldsChanged, ["outline", "connectors"])
	assert.deepEqual(r.woke, ["architect", "build:board", "build:enclosure", "consistency"])
	assert.deepEqual(r.checked, [])
	assert.deepEqual(r.reading, [])
	assert.deepEqual(r.stayedIdle, ["parts", "firmware", "reviewer", "build:firmware", "grounding"])
	assert.equal(r.violationsPeak, 2)
	assert.deepEqual(r.violations, [2, 0])
	assert.deepEqual(r.revisions, { from: 6, to: 7 })
})

test("ripple: consistent again once the contract is clean and every woken build has finished", () => {
	const [r] = liveRipples([...initial, ...ripple], [request], T0 + 200_000)
	assert.equal(r.state, "consistent")
	assert.equal(r.consistentAtMs, T0 + 138_000)
	assert.equal(r.durationMs, 38_000)
	assert.deepEqual(resultLine(r, T0 + 200_000), { headline: "Consistent again in 38 s", detail: "4 of 9 agents woke", text: "Consistent again in 38 s · 4 of 9 agents woke" })
})

test("ripple: in flight, red checks and agents still working", () => {
	const now = T0 + 112_000
	const events = [...initial, ...ripple.filter((e) => Date.parse(e.at) <= now)]
	const [r] = liveRipples(events, [request], now)
	assert.equal(r.state, "rippling")
	assert.equal(r.consistentAtMs, null)
	assert.equal(r.durationMs, null)
	assert.deepEqual(r.working, ["build:board", "build:enclosure"])
	const board = r.checks.find((c) => c.key === "build:board")
	assert.equal(board?.state, "running")
	assert.equal(resultLine(r, now).headline, "Rippling · 12 s")
	assert.equal(resultLine(r, now).detail, "4 of 9 agents woke · 2 still working")
})

test("ripple: checks go red then green, the board's DRC rides along", () => {
	const [r] = liveRipples([...initial, ...ripple], [request], T0 + 200_000)
	const byKey = Object.fromEntries(r.checks.map((c) => [c.key, c]))
	assert.deepEqual(byKey.consistency.seq, [2, 0])
	assert.equal(byKey.consistency.state, "ok")
	assert.equal(byKey["build:board"].state, "ok")
	assert.match(byKey["build:board"].detail, /DRC 0 errors/)
	assert.equal(byKey["build:enclosure"].state, "ok")
	assert.equal(byKey["build:firmware"], undefined)
})

test("ripple: a request nobody has picked up yet, and one that changed nothing", () => {
	const now = T0 + 100_500
	const [sent] = liveRipples(initial, [request], now)
	assert.deepEqual(sent.checked, [])
	assert.equal(sent.state, "sent")
	assert.deepEqual(sent.woke, [])
	assert.equal(resultLine(sent, now).headline, "Sent to the agents")
	const quiet = [...initial, activity(101, "architect", "turn"), activity(104, "architect", "answer"), ev(110, "design.settled", { settled: true, revision: 5 })]
	const [none] = liveRipples(quiet, [request], T0 + 120_000)
	assert.equal(none.state, "no-change")
	// Took a turn, changed nothing: checked, not woke.
	assert.deepEqual(none.woke, [])
	assert.deepEqual(none.checked, ["architect"])
	assert.equal(resultLine(none, T0 + 120_000).headline, "No change to the design")
})

test("ripple: each request owns the events until the next one", () => {
	const second = { at: at(150), text: "sensor out of stock" }
	const more = [activity(151, "parts", "turn"), changed(153, "parts", 2, 8, "parts"), checked(154, 8, 0), activity(155, "parts", "answer")]
	const rs = liveRipples([...initial, ...ripple.filter((e) => Date.parse(e.at) < T0 + 150_000), ...more], [request, second], T0 + 160_000)
	assert.equal(rs.length, 2)
	assert.deepEqual(rs[0].fieldsChanged, ["outline", "connectors"])
	assert.deepEqual(rs[1].fieldsChanged, ["parts"])
	assert.ok(rs[1].woke.includes("parts"))
	assert.ok(!rs[1].woke.includes("architect"))
})

test("ripple: woke = changed or proposed a field; checked = took a turn and changed nothing", () => {
	const events = [...initial, activity(101, "architect", "turn"), activity(101, "firmware", "turn"), activity(101, "reviewer", "turn"), ev(103, "change.proposed", { proposalId: "p1", by: "firmware", field: "pins", reason: "x" }), changed(104, "outline", 2, 6, "architect"), activity(105, "firmware", "answer"), activity(105, "reviewer", "answer")]
	const [r] = liveRipples(events, [request], T0 + 106_000)
	assert.deepEqual(r.woke, ["architect", "firmware", "build:board", "build:enclosure", "consistency"])
	assert.deepEqual(r.checked, ["reviewer"])
	assert.deepEqual(r.stayedIdle, ["parts", "build:firmware", "grounding"])
	assert.equal(resultLine(r, T0 + 106_000).detail, "5 of 9 agents woke · 1 checked, no change · 3 still working")
})

test("ripple: an agent that took a turn and is still at it is 'reading', not yet woke or checked", () => {
	const events = [...initial, activity(101, "architect", "turn"), activity(101, "firmware", "turn"), changed(104, "outline", 2, 6, "architect")]
	const [r] = liveRipples(events, [request], T0 + 105_000)
	assert.deepEqual(r.reading, ["firmware"])
	assert.ok(!r.checked.includes("firmware") && !r.woke.includes("firmware"))
	// It answers without touching the contract: checked.
	const [done] = liveRipples([...events, activity(108, "firmware", "answer")], [request], T0 + 109_000)
	assert.deepEqual(done.reading, [])
	assert.deepEqual(done.checked, ["firmware"])
	// The runner's file has no "reading": a live reader is kept as reading until the file says it woke.
	const file = { requests: [{ id: "req-1", text: request.text, atMs: 100_000, fieldsChanged: ["outline"], woke: ["architect", "build:board", "build:enclosure", "consistency"], checked: ["firmware"], stayedIdle: ["parts", "reviewer", "build:firmware", "grounding"], violationsPeak: 0, consistentAtMs: null, durationMs: null }] }
	const [m] = mergeRipples([r], file, T0)
	assert.deepEqual(m.reading, ["firmware"])
	assert.deepEqual(m.checked, [])
})

test("ripple: a design that ends unsettled says so", () => {
	const bad = [...initial, activity(101, "architect", "turn"), changed(104, "outline", 2, 6, "architect"), checked(105, 6, 3), ev(130, "design.settled", { settled: false, revision: 6 })]
	const [r] = liveRipples(bad, [request], T0 + 140_000)
	assert.equal(r.state, "unsettled")
	assert.equal(resultLine(r, T0 + 140_000).headline, "Not consistent: 3 violations left")
})

test("ripple: a clean contract carries in (checks only report changes), and a dirty check resets it", () => {
	// The change keeps the contract clean, so no new consistency.checked: clean carries in from before the request.
	const quiet = [...initial, activity(101, "architect", "turn"), changed(104, "outline", 2, 6, "architect"), ev(120, "artifact.ready", { kind: "board", revision: 6 }), ev(126, "artifact.ready", { kind: "enclosure", revision: 6 })]
	const [r] = liveRipples(quiet, [request], T0 + 130_000)
	assert.equal(r.state, "consistent")
	assert.equal(r.consistentAtMs, T0 + 126_000)
	// A dirty check after that point: not consistent until the next clean one.
	const dirty = [...quiet, checked(127, 6, 1)]
	assert.equal(liveRipples(dirty, [request], T0 + 130_000)[0].consistentAtMs, null)
	assert.equal(liveRipples([...dirty, checked(129, 6, 0)], [request], T0 + 130_000)[0].consistentAtMs, T0 + 129_000)
})

test("ripples.json from the runner wins where it has an answer; the live trace fills the rest", () => {
	// The runner's file: ids req-N (Nth line of requests.jsonl), times in ms from run.started.
	const live = liveRipples([...initial, ...ripple.slice(0, 4)], [request], T0 + 106_000)
	assert.equal(live[0].id, "req-1")
	const file = { requests: [{ id: "req-1", text: "make it 60 mm wide", atMs: 100_200, fieldsChanged: ["outline", "connectors"], woke: ["architect", "parts", "build:board", "build:enclosure", "consistency"], checked: ["firmware"], stayedIdle: ["reviewer", "build:firmware", "grounding"], violationsPeak: 2, consistentAtMs: 140_000, durationMs: 39_800 }] }
	const [m] = mergeRipples(live, file, runStart([...initial, ...ripple]) ?? 0)
	assert.equal(m.state, "consistent")
	assert.equal(m.atMs, T0 + 100_200)
	assert.equal(m.consistentAtMs, T0 + 140_000)
	assert.equal(m.durationMs, 39_800)
	assert.deepEqual(m.woke, ["architect", "parts", "build:board", "build:enclosure", "consistency"])
	assert.deepEqual(m.checked, ["firmware"])
	assert.deepEqual(m.stayedIdle, ["reviewer", "build:firmware", "grounding"])
	// Live details the file doesn't carry stay.
	assert.deepEqual(m.violations, live[0].violations)
	// Still in flight in the file: the live view stays.
	const pending = { requests: [{ ...file.requests[0], consistentAtMs: null, durationMs: null }] }
	assert.equal(mergeRipples(live, pending, T0)[0].state, "rippling")
	// No file entry for a request: live only.
	assert.equal(mergeRipples(live, { requests: [] }, T0)[0].state, "rippling")
	assert.equal(mergeRipples(live, null, T0)[0].state, "rippling")
})

test("the run's clock starts at run.started, else the first event", () => {
	assert.equal(runStart([ev(3, "contract.changed", {}), ev(5, "run.started", {})]), T0 + 5000)
	assert.equal(runStart([ev(3, "contract.changed", {})]), T0 + 3000)
	assert.equal(runStart([]), null)
})

test("ripple: the board's DRC errors inside one part's own footprint are amber and say so", () => {
	const own = { errors: 2, warnings: 1, unconnected: 0, rules: "jlcpcb", ownFootprint: { J1: 2 } }
	const events = [...initial, ...ripple.slice(0, 7), ev(125, "artifact.ready", { kind: "board", revision: 7, drc: own }), ev(138, "artifact.ready", { kind: "enclosure", revision: 7 })]
	const [r] = liveRipples(events, [request], T0 + 200_000)
	const board = r.checks.find((c) => c.key === "build:board")!
	assert.equal(board.state, "warn")
	assert.match(board.detail, /DRC: 2 inside J1's footprint/)
	const real = liveRipples([...initial, ...ripple.slice(0, 7), ev(125, "artifact.ready", { kind: "board", revision: 7, drc: { ...own, errors: 3 } })], [request], T0 + 200_000)[0].checks.find((c) => c.key === "build:board")!
	assert.equal(real.state, "error")
	assert.match(real.detail, /DRC 3 errors/)
})

test("what moved: outline, connectors, pins and parts, before → after", () => {
	const before = {
		outline: { widthMm: 50, heightMm: 30 },
		connectors: [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 15, widthMm: 9, heightMm: 3.2 }, { ref: "J2", kind: "header", edge: "top", offsetMm: 10, widthMm: 10, heightMm: 2.5 }],
		pins: [{ signal: "SDA", gpio: 4, partRef: "U2", partPin: "SDA" }, { signal: "STATUS_LED", gpio: 8, partRef: "D1", partPin: "A" }],
		parts: [{ ref: "U2", mpn: "SHT40" }, { ref: "D1", mpn: "LED" }],
	}
	const after = {
		outline: { widthMm: 60, heightMm: 30 },
		connectors: [{ ref: "J1", kind: "usb-c", edge: "bottom", offsetMm: 30, widthMm: 9, heightMm: 3.2 }, { ref: "J2", kind: "header", edge: "top", offsetMm: 10, widthMm: 10, heightMm: 2.5 }],
		pins: [{ signal: "SDA", gpio: 5, partRef: "U2", partPin: "SDA" }, { signal: "STATUS_LED", gpio: 8, partRef: "D1", partPin: "A" }, { signal: "BTN", gpio: 9, partRef: "SW1", partPin: "1" }],
		parts: [{ ref: "U2", mpn: "AHT20" }, { ref: "D1", mpn: "LED" }],
	}
	const m = whatMoved(before, after)
	assert.deepEqual(m.outline, { before: { w: 50, h: 30 }, after: { w: 60, h: 30 } })
	assert.deepEqual(m.connectors, [{ ref: "J1", kind: "usb-c", before: { edge: "left", offsetMm: 15, widthMm: 9 }, after: { edge: "bottom", offsetMm: 30, widthMm: 9 } }])
	assert.deepEqual(m.pins, [{ signal: "SDA", before: 4, after: 5 }, { signal: "BTN", before: null, after: 9 }])
	assert.deepEqual(m.parts, [{ ref: "U2", before: "SHT40", after: "AHT20" }])
	assert.equal(m.count, 5)
	assert.deepEqual(whatMoved(after, after), { outline: null, connectors: [], pins: [], parts: [], count: 0 })
	assert.equal(whatMoved(null, after).count, 0)
})
