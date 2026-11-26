// The input TVS for a DC brick, picked by rule (lead-2, 26 Nov 2026): the smallest stand-off (VRWM) at or over the
// brick's maximum output, nominal × (1 + tolerance), so it never conducts in normal use. A leaf module: circuit.ts and
// the hot-plug check (inrush.ts) both read it.
export interface Tvs {
	mpn: string
	lcsc: string
	vrwmV: number
	vbrMaxV: number
	vcV: number
	ippA: number
	source: { url: string; where: string }
}
// SMBJ (600 W, DO-214AA) rows, unidirectional, from their makers' tables.
export const INPUT_TVS_SERIES: Tvs[] = [
	{ mpn: "SMBJ20A", lcsc: "C364296", vrwmV: 20.0, vbrMaxV: 24.5, vcV: 32.4, ippA: 18.6, source: { url: "https://datasheet.lcsc.com/datasheet/pdf/2fdb55289569ebfc0bc21eab3853afe6.pdf", where: "MDD SMBJ series datasheet, electrical characteristics: SMBJ20A VRWM 20.0 V, VBR 22.20-24.50 V at IT 1 mA, VC 32.4 V at IPP 18.6 A, IR 1 uA" } },
	{ mpn: "SMBJ22A", lcsc: "C224015", vrwmV: 22.0, vbrMaxV: 26.9, vcV: 35.5, ippA: 16.9, source: { url: "https://www.lcsc.com/product-detail/C224015.html", where: "Littelfuse SMBJ series datasheet, SMBJ22A: VRWM 22 V, VBR 24.4-26.9 V at IT 1 mA, VC 35.5 V at IPP 16.9 A (Diodes Inc. and onsemi list the same row)" } },
]
// The brick's output tolerance when its catalog entry gives none: ±5 %, an ESTIMATE (Mean Well's GST120A and a 19.5 V
// laptop brick are both specified ±5 %).
export const DEFAULT_BRICK_TOLERANCE_PCT = 5
export const brickMaxV = (volts: number, tolerancePct = DEFAULT_BRICK_TOLERANCE_PCT) => Math.round(volts * (1 + tolerancePct / 100) * 100) / 100
// The smallest stand-off over the brick's maximum, or null when no row covers it.
export const pickInputTvs = (maxV: number): Tvs | null => INPUT_TVS_SERIES.filter((t) => t.vrwmV >= maxV).sort((a, b) => a.vrwmV - b.vrwmV)[0] ?? null
// The TVS's clamp at a current: straight between its breakdown (at 1 mA, about 0 A) and its clamp at IPP, a linear model.
export const tvsClampAt = (t: Tvs, a: number) => t.vbrMaxV + ((t.vcV - t.vbrMaxV) * a) / t.ippA
// The arm's brick at its maximum, and the TVS for it.
export const armBrickMaxV = (input: { volts: number; tolerancePct?: number }) => brickMaxV(input.volts, input.tolerancePct ?? DEFAULT_BRICK_TOLERANCE_PCT)
export const armInputTvs = (input: { volts: number; tolerancePct?: number }) => pickInputTvs(armBrickMaxV(input))

// A hot plug (inrush.ts): an undamped LC stepped to V peaks at 2V, an ESTIMATE from the physics (AN88's text unread);
// the TVS takes about 5 A while it clamps, an ESTIMATE (the cable's inductance, unmeasured).
export const HOTPLUG_RING_FACTOR = 2
export const HOTPLUG_SURGE_A = 5
// What every chip on the input must take on a hot plug: the ring, held to the TVS's clamp at the estimated surge.
export function armInputPeakV(input: { volts: number; tolerancePct?: number }): number {
	const maxV = armBrickMaxV(input)
	const t = armInputTvs(input)
	return Math.round(Math.min(maxV * HOTPLUG_RING_FACTOR, t ? tvsClampAt(t, HOTPLUG_SURGE_A) : Infinity) * 100) / 100
}
// What a rail chip on the input must be rated for, with margin (lead-2, 26 Nov 2026: "≥ 36 V absolute maximum ... so a
// plain TVS fits with margin"): the TVS's rated clamp at its full pulse current, which holds whatever the surge (the
// hot-plug check's 5 A is an estimate); the ring itself when no TVS covers the brick.
export function armInputRatingV(input: { volts: number; tolerancePct?: number }): number {
	const t = armInputTvs(input)
	return t ? t.vcV : armBrickMaxV(input) * HOTPLUG_RING_FACTOR
}
