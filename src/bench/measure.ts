// The bench's measurement math, pure so it runs the same on the real meter, the fake bridge and a replay.

export interface MeterSample {
	at: number
	mA: number
}

export interface CycleMeasurement {
	cycles: number
	// Median awake window (ms), boot from deep sleep included.
	awakeMs: number
	// Median charge per wake above the floor, in µC (mA × ms).
	chargeUc: number
	// Median current over the whole window: the dev board's sleep floor (LED, LDO, USB bridge), not the design's.
	floorMa: number
}

export const MIN_CYCLES = 5

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b)
	const mid = Math.floor(s.length / 2)
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// Duty-cycle mode: the board is asleep most of the time, so the median sample is the floor. A wake is a run of at
// least two samples well above it, widened to where the current falls back near the floor; one that touches either
// end of the window is cut off and not counted. Null with fewer than MIN_CYCLES complete wakes.
export function measureCycles(samples: MeterSample[]): CycleMeasurement | null {
	if (samples.length < 3) return null
	const floorMa = median(samples.map((s) => s.mA))
	const span = Math.max(...samples.map((s) => s.mA)) - floorMa
	if (span < 1) return null
	const threshold = floorMa + 0.3 * span
	const edge = floorMa + Math.max(0.2, 0.05 * span)
	const dt = (i: number) => (i + 1 < samples.length ? samples[i + 1].at - samples[i].at : samples[i].at - samples[i - 1].at)
	const charges: number[] = []
	const awake: number[] = []
	let i = 0
	while (i < samples.length) {
		if (samples[i].mA <= threshold) {
			i++
			continue
		}
		let end = i
		while (end + 1 < samples.length && samples[end + 1].mA > threshold) end++
		if (end === i) {
			i++
			continue
		}
		let start = i
		while (start > 0 && samples[start - 1].mA > edge) start--
		while (end + 1 < samples.length && samples[end + 1].mA > edge) end++
		if (start > 0 && end < samples.length - 1) {
			let q = 0
			for (let k = start; k <= end; k++) q += (samples[k].mA - floorMa) * dt(k)
			charges.push(q)
			awake.push(samples[end].at - samples[start].at + dt(end))
		}
		i = end + 1
	}
	if (charges.length < MIN_CYCLES) return null
	return { cycles: charges.length, awakeMs: median(awake), chargeUc: median(charges), floorMa }
}

// The bench proposes a measured average only when it differs from the contract's by more than 10 %.
export function worthProposing(measuredMa: number, contractMa: number | undefined): boolean {
	if (contractMa === undefined || contractMa === 0) return true
	return Math.abs(measuredMa - contractMa) / contractMa > 0.1
}
