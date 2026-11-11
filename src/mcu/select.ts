import { loadProfiles, type McuProfile } from "./profile.ts"
import { solvePins, type Need } from "./solver.ts"

// Choosing the MCU on equal terms (docs/mcu.md, Choosing a chip): every profile is put through the same tests: can it
// carry the design's pins and peripherals (the solver), does it have the radio, can Bringup build its board, and then a
// score from the same figures for each (sleep current on a battery, price, stock, a simulator for it). No vendor is
// preferred; every term is stated with its number, so an agent and an engineer can see why one ranks above another.

export interface McuRequest {
	needs: Need[]
	radio?: ("ble" | "wifi")[]
	battery?: boolean
}
export interface Ranked {
	id: string
	mpn: string
	fits: boolean // pins, peripherals and radio
	buildable: boolean // Bringup can generate its board today
	score: number
	why: string[]
}

// Score weights (points; higher ranks first). Chosen so one term rarely outweighs fitting at all: a battery design loses
// 1 point per µA of sleep current (capped at 40), any design 5 points per USD at 100 pcs, 15 for fewer than 100 in
// stock, 10 for an unknown price, and gains 10 when a simulator boots its firmware. A radio the design doesn't use
// costs 5 (certification and current for nothing).
export const WEIGHTS = { sleepPerUa: 1, sleepCap: 40, perUsd: 5, lowStock: 15, unknownPrice: 10, simulator: 10, unusedRadio: 5 }

export function stockOf(p: McuProfile): number | null {
	const m = /([\d,]+) in stock/.exec(p.priceUsd?.source ?? "")
	if (m) return Number(m[1].replace(/,/g, ""))
	return /no stock shown/.test(p.priceUsd?.source ?? "") ? 0 : null
}

export function rankMcus(req: McuRequest, profiles: McuProfile[] = loadProfiles()): Ranked[] {
	const out = profiles.map((p) => {
		const why: string[] = []
		const solved = solvePins(p, req.needs)
		const missingRadio = (req.radio ?? []).filter((r) => !p.radio.includes(r))
		if (!solved.ok) why.push(`pins: ${solved.reason}`)
		else why.push(`pins: all ${req.needs.length} needs fit`)
		if (missingRadio.length) why.push(`radio: no ${missingRadio.join("/")}`)
		if (!p.board.supported) why.push(`board: ${p.board.reason ?? "not generated yet"}`)
		let score = 100
		if (req.battery) {
			const pts = Math.min(WEIGHTS.sleepCap, p.currents.sleepUa * WEIGHTS.sleepPerUa)
			score -= pts
			why.push(`sleep ${p.currents.sleepUa} µA: -${+pts.toFixed(1)}`)
		}
		if (p.priceUsd) {
			const pts = p.priceUsd.usd * WEIGHTS.perUsd
			score -= pts
			why.push(`price $${p.priceUsd.usd} @${p.priceUsd.qty}: -${+pts.toFixed(1)}`)
		} else {
			score -= WEIGHTS.unknownPrice
			why.push(`price unknown: -${WEIGHTS.unknownPrice}`)
		}
		const stock = stockOf(p)
		if (stock !== null && stock < 100) {
			score -= WEIGHTS.lowStock
			why.push(`stock ${stock}: -${WEIGHTS.lowStock}`)
		}
		if (p.sim.backend) {
			score += WEIGHTS.simulator
			why.push(`simulator ${p.sim.backend}: +${WEIGHTS.simulator}`)
		}
		if (p.radio.length && !(req.radio ?? []).length) {
			score -= WEIGHTS.unusedRadio
			why.push(`radio unused: -${WEIGHTS.unusedRadio}`)
		}
		return { id: p.id, mpn: p.mpn, fits: solved.ok && missingRadio.length === 0, buildable: p.board.supported, score: +score.toFixed(1), why }
	})
	const tier = (r: Ranked) => (r.fits && r.buildable ? 0 : r.fits ? 1 : 2)
	return out.sort((a, b) => tier(a) - tier(b) || b.score - a.score || a.id.localeCompare(b.id))
}
