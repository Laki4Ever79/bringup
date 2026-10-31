// What the LED actually does, measured from live-mode telemetry, so the bench can say "tilt blink 250 ms (measured)"
// instead of trusting behavior.h. Pure, like measure.ts: the same on the real board, the fake bridge and a replay.
import type { Behavior } from "../contract/types.ts"
import type { BenchCheck } from "../events.ts"
import type { BridgeLine } from "../tools/bench-bridge.ts"

export interface BlinkMeasurement {
	// Full on+off periods in ms, null when there weren't enough clean toggles.
	blinkMs: number | null
	tiltBlinkMs: number | null
	// Half-period intervals each figure is built from.
	toggles: { plain: number; tilted: number }
}

// Intervals needed before a period counts as measured.
export const MIN_INTERVALS = 3

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b)
	const mid = Math.floor(s.length / 2)
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// The firmware toggles the LED every half period, picking the period at each toggle from the last sampled tilt (or the
// shake blink). Samples come every 50 ms, so one interval is off by up to a sample; the mean of the intervals near
// the median cancels that out. Times are the board's own ms (USB delivers lines in bursts), falling back to `at`.
export function measureBlink(lines: BridgeLine[], tiltDeg: number): BlinkMeasurement {
	const toggles: { t: number; tilted: boolean; shake: boolean; segment: number }[] = []
	let prev: { t: number; led: number; tilt: number; shake: boolean } | null = null
	let segment = 0
	for (const l of lines) {
		if (l.k !== "s" || typeof l.led !== "number") continue
		const t = typeof l.ms === "number" ? l.ms : l.at
		const cur = { t, led: l.led, tilt: typeof l.tilt === "number" ? l.tilt : 0, shake: l.shake === 1 }
		// The board's clock went back: it rebooted, so earlier toggles can't pair with later ones.
		if (prev && t < prev.t) segment++
		else if (prev && cur.led !== prev.led) toggles.push({ t, tilted: prev.tilt > tiltDeg, shake: prev.shake || cur.shake, segment })
		prev = cur
	}
	const intervals = { plain: [] as number[], tilted: [] as number[] }
	for (let i = 1; i < toggles.length; i++) {
		const [a, b] = [toggles[i - 1], toggles[i]]
		// Same boot, no shaking, and the same tilt class at both ends (an interval across the threshold is neither).
		if (a.segment !== b.segment || a.shake || b.shake || a.tilted !== b.tilted) continue
		intervals[a.tilted ? "tilted" : "plain"].push(b.t - a.t)
	}
	const period = (xs: number[]) => {
		if (xs.length < MIN_INTERVALS) return null
		const m = median(xs)
		const near = xs.filter((x) => x >= 0.5 * m && x <= 1.5 * m)
		return Math.round((2 * near.reduce((s, x) => s + x, 0)) / near.length)
	}
	return { blinkMs: period(intervals.plain), tiltBlinkMs: period(intervals.tilted), toggles: { plain: intervals.plain.length, tilted: intervals.tilted.length } }
}

// A sample (50 ms) either side, or 20 % of the period, whichever is more forgiving.
const close = (measured: number, expected: number) => Math.abs(measured - expected) <= Math.max(50, 0.2 * expected)

// The bench's "blink" check: the measured periods against the contract's behavior (the firmware defaults without one).
export function blinkVerdict(m: BlinkMeasurement, expected: Behavior): BenchCheck {
	const tilts = expected.tiltDeg < 90 && expected.tiltBlinkMs !== expected.blinkMs
	if (m.blinkMs === null && m.tiltBlinkMs === null) return { name: "blink", pass: true, skipped: true, detail: "not measured: too few LED toggles in the telemetry" }
	const parts: string[] = []
	let pass = true
	if (m.blinkMs !== null) {
		const ok = close(m.blinkMs, expected.blinkMs)
		pass &&= ok
		parts.push(`blink ${m.blinkMs} ms${ok ? "" : ` (contract ${expected.blinkMs} ms)`}`)
	}
	if (tilts) {
		if (m.tiltBlinkMs === null) parts.push(`tilted not measured: the board was not tilted past ${expected.tiltDeg}°`)
		else {
			const ok = close(m.tiltBlinkMs, expected.tiltBlinkMs)
			pass &&= ok
			parts.push(`tilted ${m.tiltBlinkMs} ms${ok ? "" : ` (contract ${expected.tiltBlinkMs} ms)`} past ${expected.tiltDeg}°`)
		}
	}
	return { name: "blink", pass, detail: `${parts.join(", ")} (measured from ${m.toggles.plain + m.toggles.tilted} LED toggles)` }
}
