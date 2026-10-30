import { test } from "node:test"
import assert from "node:assert/strict"
import { measureCycles, worthProposing } from "../src/bench/measure.ts"

// Synthetic INA226 stream: a floor, and a rectangular awake pulse every periodMs, sampled every dtMs.
function stream(o: { floorMa: number; awakeMa: number; awakeMs: number; periodMs: number; cycles: number; dtMs?: number; offsetMs?: number }) {
	const dt = o.dtMs ?? 17.6
	const out: { at: number; mA: number }[] = []
	const end = (o.offsetMs ?? 1000) + o.cycles * o.periodMs + 1000
	for (let at = 0; at < end; at += dt) {
		const t = at - (o.offsetMs ?? 1000)
		const inPulse = t >= 0 && t % o.periodMs < o.awakeMs && t < o.cycles * o.periodMs
		out.push({ at, mA: inPulse ? o.awakeMa : o.floorMa })
	}
	return out
}

test("charge per wake is the area above the floor, in µC (mA × ms), median over the cycles", () => {
	const m = measureCycles(stream({ floorMa: 6, awakeMa: 66, awakeMs: 180, periodMs: 3000, cycles: 8 }))
	assert.ok(m)
	assert.equal(m.cycles, 8)
	assert.ok(Math.abs(m.floorMa - 6) < 0.01, `floor ${m.floorMa}`)
	// 60 mA above the floor for 180 ms = 10 800 µC, within one sample period of quantisation.
	assert.ok(Math.abs(m.chargeUc - 10_800) < 60 * 17.6 + 1, `charge ${m.chargeUc}`)
	assert.ok(Math.abs(m.awakeMs - 180) <= 17.6 + 1, `awake ${m.awakeMs}`)
})

test("fewer than five complete cycles is no measurement", () => {
	assert.equal(measureCycles(stream({ floorMa: 6, awakeMa: 66, awakeMs: 180, periodMs: 3000, cycles: 4 })), null)
})

test("a pulse cut off at either end of the window is not counted", () => {
	// Starts mid-pulse: the first window touches the start of the buffer.
	const s = stream({ floorMa: 6, awakeMa: 66, awakeMs: 180, periodMs: 3000, cycles: 7, offsetMs: 0 })
	const m = measureCycles(s)
	assert.ok(m)
	assert.equal(m.cycles, 6)
})

test("a flat trace has no cycles", () => {
	assert.equal(measureCycles(stream({ floorMa: 6, awakeMa: 6, awakeMs: 180, periodMs: 3000, cycles: 8 })), null)
})

test("one noisy sample above the floor is not a wake", () => {
	const s = stream({ floorMa: 6, awakeMa: 66, awakeMs: 180, periodMs: 3000, cycles: 6 })
	s[3].mA = 40
	const m = measureCycles(s)
	assert.equal(m?.cycles, 6)
})

test("worth proposing: only a change over 10 %, and always when nothing was measured or estimated", () => {
	assert.equal(worthProposing(0.05, 0.0375), true)
	assert.equal(worthProposing(0.04, 0.0375), false)
	assert.equal(worthProposing(0.0375, 0.0375), false)
	assert.equal(worthProposing(0.03, 0.0375), true)
	assert.equal(worthProposing(0.03, undefined), true)
})

test("live-mode current before the duty cycle starts does not move the floor or the charge per wake", () => {
	// 30 s of live mode at ~48 mA (more samples than the duty cycle has), then the duty cycle: the window a replay (or a slow mode switch) hands the bench.
	const live = Array.from({ length: Math.round(30_000 / 17.6) }, (_, i) => ({ at: -30_000 + i * 17.6, mA: 48 + (i % 3) }))
	const m = measureCycles([...live, ...stream({ floorMa: 6, awakeMa: 66, awakeMs: 180, periodMs: 3000, cycles: 8 })])
	assert.ok(m)
	assert.ok(Math.abs(m.floorMa - 6) < 0.01, `floor ${m.floorMa}`)
	assert.ok(Math.abs(m.chargeUc - 10_800) < 60 * 17.6 + 1, `charge ${m.chargeUc}`)
})
