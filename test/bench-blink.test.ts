import { test } from "node:test"
import assert from "node:assert/strict"
import { blinkVerdict, measureBlink } from "../src/bench/blink.ts"
import { liveLines } from "./bench-fake.ts"

const swing = (ms: number) => Math.abs(35 * Math.sin((2 * Math.PI * ms) / 8000))

test("measures the plain and the tilted blink period from the LED toggles in the telemetry", () => {
	const m = measureBlink(liveLines({ blinkMs: 1000, tiltBlinkMs: 250, tiltDeg: 20, seconds: 16, tilt: swing }), 20)
	assert.ok(m.blinkMs !== null && Math.abs(m.blinkMs - 1000) <= 50, `blinkMs ${m.blinkMs}`)
	assert.ok(m.tiltBlinkMs !== null && Math.abs(m.tiltBlinkMs - 250) <= 50, `tiltBlinkMs ${m.tiltBlinkMs}`)
	assert.ok(m.toggles.plain >= 3 && m.toggles.tilted >= 3)
})

test("uses the board's own clock (ms), not the laptop's arrival time", () => {
	// Lines that arrive in bursts: every `at` the same.
	const lines = liveLines({ blinkMs: 400, tiltBlinkMs: 400, tiltDeg: 90, seconds: 4, tilt: () => 0 }).map((l) => ({ ...l, at: 5 }))
	const m = measureBlink(lines, 90)
	assert.ok(m.blinkMs !== null && Math.abs(m.blinkMs - 400) <= 50, `blinkMs ${m.blinkMs}`)
})

test("a board never tilted past the threshold has no tilted period", () => {
	const m = measureBlink(liveLines({ blinkMs: 1000, tiltBlinkMs: 250, tiltDeg: 20, seconds: 6, tilt: () => 5 }), 20)
	assert.equal(m.tiltBlinkMs, null)
	assert.ok(m.blinkMs !== null)
})

test("shaking (the fast red blink) is left out of both periods", () => {
	const m = measureBlink(liveLines({ blinkMs: 1000, tiltBlinkMs: 1000, tiltDeg: 90, seconds: 8, tilt: () => 0, shake: (ms) => ms > 3000 && ms < 6000 }), 90)
	assert.ok(m.blinkMs !== null && Math.abs(m.blinkMs - 1000) <= 50, `blinkMs ${m.blinkMs}`)
})

test("a reboot mid-stream (ms starts again) does not make a negative interval", () => {
	const a = liveLines({ blinkMs: 600, tiltBlinkMs: 600, tiltDeg: 90, seconds: 3, tilt: () => 0 })
	const m = measureBlink([...a, ...a], 90)
	assert.ok(m.blinkMs !== null && Math.abs(m.blinkMs - 600) <= 50, `blinkMs ${m.blinkMs}`)
})

test("the verdict compares the measured periods with the contract's behavior", () => {
	const expected = { blinkMs: 1000, tiltBlinkMs: 250, tiltDeg: 20 }
	const ok = blinkVerdict({ blinkMs: 990, tiltBlinkMs: 260, toggles: { plain: 6, tilted: 9 } }, expected)
	assert.equal(ok.pass, true)
	assert.match(ok.detail, /tilted 260 ms/)
	assert.match(ok.detail, /measured/)
	const wrong = blinkVerdict({ blinkMs: 1000, tiltBlinkMs: 1000, toggles: { plain: 6, tilted: 9 } }, expected)
	assert.equal(wrong.pass, false)
	assert.match(wrong.detail, /contract 250 ms/)
	// Nobody tilted it: the plain period passes on its own, and the detail says the tilt was not measured.
	const untilted = blinkVerdict({ blinkMs: 1000, tiltBlinkMs: null, toggles: { plain: 6, tilted: 0 } }, expected)
	assert.equal(untilted.pass, true)
	assert.match(untilted.detail, /not tilted/)
	// No toggles at all: nothing measured, neutral.
	const none = blinkVerdict({ blinkMs: null, tiltBlinkMs: null, toggles: { plain: 0, tilted: 0 } }, expected)
	assert.equal(none.skipped, true)
})
