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

// An undamped LC's step response peaks at twice the step: the ceiling (ESTIMATE: the cable and capacitors are not modelled).
export const HOTPLUG_RING_FACTOR = 2
// The current the TVS takes while it clamps the ring (ESTIMATE: set by the cable's inductance and the brick, unmeasured).
export const HOTPLUG_SURGE_A = 5
// The input TVS (circuit.ts SUPPORT.tvs): MDD SMBJ20A, its datasheet's table row.
export const INPUT_TVS = {
	mpn: "SMBJ20A",
	vrwmV: 20.0,
	vbrMaxV: 24.5,
	vcV: 32.4,
	ippA: 18.6,
	source: { url: "https://datasheet.lcsc.com/datasheet/pdf/2fdb55289569ebfc0bc21eab3853afe6.pdf", where: "MDD SMBJ series datasheet, electrical characteristics: SMBJ20A VRWM 20.0 V, VBR 22.20-24.50 V at IT 1 mA, VC 32.4 V at IPP 18.6 A, IR 1 uA" },
}
// The TVS's clamp at a current: straight between its breakdown (at 1 mA, about 0 A) and its clamp at IPP.
export const tvsClampV = (a: number) => INPUT_TVS.vbrMaxV + ((INPUT_TVS.vcV - INPUT_TVS.vbrMaxV) * a) / INPUT_TVS.ippA

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
	if (v > INPUT_TVS.vrwmV) violations.push({ kind: "arm-supply", message: `the ${v} V brick is over the input TVS's ${INPUT_TVS.vrwmV} V stand-off (${INPUT_TVS.mpn}): it would conduct all the time; use a brick of at most ${INPUT_TVS.vrwmV} V (a 19.5 V laptop brick)` })
	const ring = v * HOTPLUG_RING_FACTOR
	const peak = Math.min(ring, tvsClampV(HOTPLUG_SURGE_A))
	if (!chips.length) return { figure: null, violations }
	const lowest = chips.reduce((m, c) => (c.maxV < m.maxV ? c : m))
	for (const c of chips) if (peak > c.maxV) violations.push({ kind: "arm-supply", message: `a hot-plugged ${v} V brick peaks at about ${r2(peak)} V (the ring, ${HOTPLUG_RING_FACTOR}x, an estimate, held by ${INPUT_TVS.mpn} to ${r2(tvsClampV(HOTPLUG_SURGE_A))} V at ${HOTPLUG_SURGE_A} A, an estimate), over ${c.ref} ${c.mpn}'s ${c.maxV} V maximum input` })
	return {
		figure: { check: "Hot-plug input peak", value: `${r2(peak)} V`, limit: `at most ${lowest.maxV} V (${lowest.ref} ${lowest.mpn})`, ok: peak <= lowest.maxV, note: `${v} V brick: the ring up to ${r2(ring)} V (${HOTPLUG_RING_FACTOR}x, an undamped LC's peak, an estimate), clamped by ${INPUT_TVS.mpn} at ${r2(tvsClampV(HOTPLUG_SURGE_A))} V at ${HOTPLUG_SURGE_A} A (an estimate) with a 100 uF electrolytic damping it` },
		violations,
	}
}
