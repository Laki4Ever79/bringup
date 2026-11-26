// The arm's brick input on a hot plug (arm task 6, lead decision 25 Nov 2026). Plugging a live brick into a board whose
// input is ceramic capacitors rings: the cable's inductance and the capacitors form an LC circuit, and an undamped LC stepped
// to V peaks at 2V (its step response, 1 - cos). Linear Technology's AN88 ("Ceramic Input Capacitors Can Cause Overvoltage
// Transients", Perica) reports peaks of about that order; its full text could not be fetched here (25 Nov 2026), so the
// factor is an ESTIMATE from the physics, not a cited measurement. The board's input holds it down two ways (circuit.ts
// SUPPORT.tvs and SUPPORT.bulkElec): a bulk electrolytic whose ESR damps the ring, and a TVS across the input that clamps
// what is left. The check: the TVS must not conduct at the brick's voltage (its stand-off at or over it), and the peak (the
// ring, held to the TVS's clamp at an estimated surge current) must stay under every chip on the input's maximum.
import { resolve } from "node:path"
import type { ContractSnapshot, Part } from "../contract/types.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import { armInputNet } from "../contract/arm-rails.ts"
import { armBrickMaxV, armInputTvs, DEFAULT_BRICK_TOLERANCE_PCT, HOTPLUG_RING_FACTOR, HOTPLUG_SURGE_A, INPUT_TVS_SERIES, tvsClampAt } from "./tvs.ts"
export { HOTPLUG_RING_FACTOR, HOTPLUG_SURGE_A } from "./tvs.ts"

// The hot-plug estimates (HOTPLUG_RING_FACTOR, HOTPLUG_SURGE_A) live in tvs.ts, a leaf the rail plan reads too.
// The input TVS: picked for the brick (tvs.ts armInputTvs), the smallest stand-off over its maximum output.
export interface InrushResult {
	figure: { check: string; value: string; limit: string; ok: boolean; note: string } | null
	violations: { kind: "arm-supply"; message: string }[]
}
const r2 = (x: number) => Math.round(x * 100) / 100

export function armInrush(s: ContractSnapshot): InrushResult {
	const arm = s.values.arm
	if (!arm) return { figure: null, violations: [] }
	const v = arm.input.volts
	const cat = loadCatalog(resolve(import.meta.dirname, "../..")) as unknown as (Part & { maxInV?: number | null })[]
	// Every chip the input feeds (its nets name armInputNet), with its catalog maximum input.
	const chips = (s.values.parts ?? []).filter((p) => Object.values(p.nets ?? {}).includes(armInputNet)).flatMap((p) => {
		const max = cat.find((c) => c.mpn === p.mpn)?.maxInV
		return typeof max === "number" ? [{ ref: p.ref, mpn: p.mpn, maxV: max }] : []
	})
	const violations: InrushResult["violations"] = []
	const maxV = armBrickMaxV(arm.input)
	const tol = arm.input.tolerancePct ?? DEFAULT_BRICK_TOLERANCE_PCT
	const tvs = armInputTvs(arm.input)
	if (!tvs) {
		const top = INPUT_TVS_SERIES.reduce((m, t) => (t.vrwmV > m.vrwmV ? t : m))
		violations.push({ kind: "arm-supply", message: `the ${v} V brick reaches ${maxV} V (±${tol} %${arm.input.tolerancePct === undefined ? ", an estimate" : ""}), over every input TVS's stand-off (at most ${top.vrwmV} V, ${top.mpn}): a TVS there would conduct all the time; use a brick of at most ${r2(top.vrwmV / (1 + tol / 100))} V` })
		return { figure: null, violations }
	}
	// The ring, held to the TVS's clamp at the estimated surge current: the peak every chip on the input must take.
	const clamp = tvsClampAt(tvs, HOTPLUG_SURGE_A)
	const ring = maxV * HOTPLUG_RING_FACTOR
	const peak = Math.min(ring, clamp)
	if (!chips.length) return { figure: null, violations }
	const lowest = chips.reduce((m, c) => (c.maxV < m.maxV ? c : m))
	// One rule for every chip on the input (lead-2, 26 Nov 2026): rated over the TVS's clamp at its full pulse current,
	// which holds whatever the surge; the estimate above only says how close a real hot plug comes.
	const rated = tvs.vcV
	for (const c of chips) if (c.maxV < rated && peak <= c.maxV) violations.push({ kind: "arm-supply", message: `${c.ref} ${c.mpn} on the ${armInputNet} input is rated ${c.maxV} V, under ${tvs.mpn}'s clamp of ${rated} V at its full ${tvs.ippA} A (a hot plug of the ${v} V brick reaches about ${r2(peak)} V, an estimate): every chip on the input must take the TVS's rated clamp; use one rated ${Math.ceil(rated)} V or more` })
	for (const c of chips) if (peak > c.maxV) violations.push({ kind: "arm-supply", message: `a hot-plugged ${v} V brick (up to ${maxV} V at ±${tol} %) peaks at about ${r2(peak)} V (the ring, ${HOTPLUG_RING_FACTOR}x, an estimate, held by ${tvs.mpn} to ${r2(clamp)} V at ${HOTPLUG_SURGE_A} A, a linear clamp model at an estimated surge), over ${c.ref} ${c.mpn}'s ${c.maxV} V maximum input: use a supply chip rated over it` })
	return {
		figure: { check: "Hot-plug input peak", value: `${r2(peak)} V (TVS rated clamp ${rated} V)`, limit: `at most ${lowest.maxV} V (${lowest.ref} ${lowest.mpn})`, ok: rated <= lowest.maxV, note: `${v} V brick, up to ${maxV} V (±${tol} %): the ring up to ${r2(ring)} V (${HOTPLUG_RING_FACTOR}x, an undamped LC's peak, an estimate), clamped by ${tvs.mpn} (stand-off ${tvs.vrwmV} V) at ${r2(clamp)} V at ${HOTPLUG_SURGE_A} A (a linear clamp model at an estimated surge) with a 100 uF electrolytic damping it` },
		violations,
	}
}
