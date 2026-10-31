import assert from "node:assert/strict"
import { test } from "node:test"
import { statusLine } from "../src/dashboard/ripple.js"

// The 04 Result banner as a live status line: what is happening now, in plain words, then how the change ended.
const T0 = Date.parse("2026-10-31T12:00:00.000Z")
const ripple = (o: object): any => ({ id: "req-1", text: "make it 40 mm wide", file: null, atMs: T0, fieldsChanged: ["outline"], woke: ["architect", "build:board", "build:enclosure", "consistency"], checked: [], reading: [], stayedIdle: ["parts", "firmware", "reviewer", "build:firmware", "grounding"], working: [], violations: [], violationsPeak: 0, consistentAtMs: null, durationMs: null, checks: [], state: "rippling", ...o })
const at = (s: number) => T0 + s * 1000

test("before any change: designing from the brief, then the first design, and what to do next", () => {
	assert.deepEqual(statusLine({ ripple: null, firstAtMs: null, now: at(0) }), { state: "initial", headline: "Starting up", detail: "" })
	assert.deepEqual(statusLine({ ripple: null, firstAtMs: at(0), now: at(19), revision: 7, workingCount: 2 }), { state: "rippling", headline: "Designing from the brief", detail: "2 agents working · rev 7 · 19 s" })
	assert.deepEqual(statusLine({ ripple: null, firstAtMs: at(0), endAtMs: at(106), now: at(200), revision: 7, settled: { settled: true, revision: 7 }, open: true }), { state: "consistent", headline: "First design consistent at rev 7", detail: "1 min 46 s from the brief · now change one thing ↑" })
	assert.equal(statusLine({ ripple: null, firstAtMs: at(0), endAtMs: at(106), now: at(200), revision: 7, settled: { settled: true, revision: 7 }, open: false }).detail, "1 min 46 s from the brief · this run has ended")
	assert.deepEqual(statusLine({ ripple: null, firstAtMs: at(0), endAtMs: at(300), now: at(300), revision: 12, settled: { settled: false, revision: 12 }, violations: [{ kind: "cutout-misaligned" }] }), { state: "unsettled", headline: "Stopped: not consistent at rev 12", detail: "the case's cutouts don't line up with the board" })
})

test("a change in flight says who is rebuilding for what, and what isn't affected", () => {
	const s = statusLine({ ripple: ripple({ working: ["build:board", "build:enclosure"] }), now: at(12) })
	assert.deepEqual(s, { state: "rippling", headline: "Board and case rebuilding for 40 mm wide", detail: "outline changed · 5 agents not affected · 12 s" })
	assert.equal(statusLine({ ripple: ripple({ working: ["architect"] }), now: at(3) }).headline, "Architect working on 40 mm wide")
	assert.equal(statusLine({ ripple: ripple({ working: ["build:firmware"], text: "blink faster when tilted", fieldsChanged: ["behavior"] }), now: at(3) }).headline, "Firmware rebuilding for “blink faster when tilted”")
	assert.deepEqual(statusLine({ ripple: ripple({ state: "sent", woke: [], fieldsChanged: [] }), now: at(1) }), { state: "sent", headline: "Agents reading 40 mm wide", detail: "deciding which fields it touches" })
})

test("a problem mid-way names it in words, not a count", () => {
	const s = statusLine({ ripple: ripple({ violations: [2], working: ["build:enclosure"] }), violations: [{ kind: "cutout-misaligned" }, { kind: "standoff-mismatch" }], now: at(9) })
	assert.deepEqual(s, { state: "rippling", headline: "The case's cutouts don't line up with the board", detail: "40 mm wide · 2 mismatches · the agents are fixing it · 9 s" })
	assert.equal(statusLine({ ripple: ripple({ violations: [1] }), violations: [{ kind: "outline-mismatch" }], now: at(9) }).headline, "Board and case outlines differ")
	assert.equal(statusLine({ ripple: ripple({ violations: [1] }), violations: [{ kind: "rail-overload" }], now: at(9) }).headline, "1 mismatch to fix")
})

test("done: the change, everything agreeing, how long, how many agents had to act", () => {
	const s = statusLine({ ripple: ripple({ state: "consistent", durationMs: 32_000 }), now: at(40) })
	assert.deepEqual(s, { state: "consistent", headline: "40 mm wide: board, case and firmware agree", detail: "in 32 s · 4 of 9 agents had to act" })
	assert.equal(statusLine({ ripple: ripple({ state: "consistent", durationMs: 300 }), now: at(40), stubbed: true }).detail, "in under 1 s · hardware stubbed · 4 of 9 agents had to act")
	assert.deepEqual(statusLine({ ripple: ripple({ state: "no-change", woke: [], checked: ["architect", "firmware"], fieldsChanged: [], text: "paint it blue" }), now: at(40) }), { state: "no-change", headline: "Nothing to change for “paint it blue”", detail: "2 agents checked it · no field moved" })
	assert.deepEqual(statusLine({ ripple: ripple({ state: "unsettled", violations: [3] }), violations: [{ kind: "pin-mismatch" }], now: at(40) }), { state: "unsettled", headline: "Stopped: 3 mismatches left after 40 mm wide", detail: "the firmware's pins don't match the board" })
})

test("a file edit is named by what it changed", () => {
	const file = { name: "pins.h", path: "firmware/rev-7/include/pins.h", revision: 7, items: ["I2C_SDA GPIO8 → GPIO4"] }
	assert.equal(statusLine({ ripple: ripple({ file, text: "edited pins.h: I2C_SDA GPIO8 → GPIO4", state: "consistent", durationMs: 20_000 }), now: at(40) }).headline, "pins.h edit (I2C_SDA GPIO8 → GPIO4): board, case and firmware agree")
})

test("on a bench, the line follows the change onto the board, and waits for the person when it must", () => {
	const bench = (state: string, short: string, detail = "") => ripple({ state: "consistent", durationMs: 18_000, text: "blink faster when tilted", fieldsChanged: ["behavior"], checks: [{ key: "bench", label: "Real board", state, short, detail }] })
	assert.deepEqual(statusLine({ ripple: bench("running", "flashing 40 %"), now: at(30) }), { state: "rippling", headline: "Flashing the real board · 40 %", detail: "“blink faster when tilted” · consistent in 18 s · now on the real board" })
	assert.equal(statusLine({ ripple: bench("running", "waiting to flash"), now: at(30) }).headline, "Flashing the real board next")
	assert.equal(statusLine({ ripple: bench("running", "running · measuring"), now: at(30) }).headline, "Measuring the blink on the real board")
	assert.equal(statusLine({ ripple: bench("running", "running · measuring"), now: at(30), benchAsk: "tilt" }).headline, "Your turn: tilt the board")
	assert.deepEqual(statusLine({ ripple: bench("ok", "tilted 250 ms ✓", "rev 9 running · tilted 250 ms measured"), now: at(30) }), { state: "consistent", headline: "Measured on the real board: tilted 250 ms ✓", detail: "“blink faster when tilted” · consistent in 18 s · rev 9 running" })
	assert.deepEqual(statusLine({ ripple: bench("error", "tilted 1000 ms ✗", "rev 9 · tilted 1000 ms, expected 250 ms"), now: at(30) }), { state: "unsettled", headline: "Real board: tilted 1000 ms, expected 250 ms", detail: "“blink faster when tilted” · the design is consistent, the board disagrees" })
})
