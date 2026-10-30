import { readFileSync } from "node:fs"
import { QUIESCENT_A } from "../codegen/spice.ts"
import type { ContractSnapshot, DutyCycle, Part, Rail } from "./types.ts"

// Battery life from plain arithmetic, so neither the reviewer nor the report has to invent numbers.

export function batteryLifeDays(capacityMah: number, averageMa: number, regulatorIqUa: number): number | null {
	const drawMa = averageMa + regulatorIqUa / 1000
	if (!(capacityMah > 0) || !(drawMa > 0) || !Number.isFinite(drawMa)) return null
	return capacityMah / drawMa / 24
}

// Average current if the device draws activeMa while awake and sleepUa otherwise.
export function dutyCycleAverageMa(d: DutyCycle, activeMa: number): number {
	const awake = d.activeMs / (d.periodS * 1000)
	return awake * activeMa + (1 - awake) * (d.sleepUa / 1000)
}

export function capacityFromBrief(brief: string): number | null {
	const m = /(\d[\d,]*(?:\.\d+)?)\s*mAh/i.exec(brief)
	return m ? Number(m[1].replace(/,/g, "")) : null
}

// An LDO's typical quiescent current: the catalog's iqUa when it lists the part, else AP2112K-class 55 µA.
const ASSUMED_IQ_UA = Math.round(QUIESCENT_A * 1e6)
type CatalogIq = { mpn: string; iqUa?: number }
let catalogCache: CatalogIq[] | null = null
function catalog(): CatalogIq[] {
	return (catalogCache ??= JSON.parse(readFileSync(new URL("../../catalog/parts.json", import.meta.url), "utf8")))
}

export interface RegulatorIq {
	ref: string
	mpn: string
	iqUa: number
	source: "catalog" | "assumed"
}

export function regulatorIq(part: Part, entries: CatalogIq[] = catalog()): RegulatorIq {
	const iq = entries.find((c) => c.mpn.toUpperCase() === part.mpn.toUpperCase())?.iqUa
	return typeof iq === "number" ? { ref: part.ref, mpn: part.mpn, iqUa: iq, source: "catalog" } : { ref: part.ref, mpn: part.mpn, iqUa: ASSUMED_IQ_UA, source: "assumed" }
}

export interface RailDraw {
	name: string
	peakMa: number
	averageMa: number | null
	source: "rail" | "duty cycle" | null
}

export interface PowerEstimate {
	// Every rail the battery feeds (all but the USB input). Each averageMa is that rail's OWN loads, excluding
	// rails it feeds, so they add up: an LDO's input current is its output current.
	rails: RailDraw[]
	// Sum of the rails' averages; null when any battery-fed rail has no average.
	averageMa: number | null
	// Upper bound from the duty cycle, taking the busiest rail's peak as the active current.
	dutyCycleMa: number | null
	dutyCycle: DutyCycle | null
	// Sum over every LDO; each LDO draws its own quiescent current from the cell.
	regulatorIqUa: number
	regulators: RegulatorIq[]
	capacityMah: number | null
	capacitySource: "brief" | "requirements" | null
	days: number | null
	targetDays: number | null
}

const batteryFed = (rails: Rail[]) => rails.filter((r) => !/VBUS|USB/i.test(r.name))

export function estimatePower(s: ContractSnapshot, brief: string): PowerEstimate {
	const { rails = [], requirements, parts = [] } = s.values
	const fed = batteryFed(rails)
	const dutyCycle = requirements?.dutyCycle ?? null
	const draws: RailDraw[] = fed.map((r) => {
		if (r.averageMa !== undefined) return { name: r.name, peakMa: r.loadMa, averageMa: r.averageMa, source: "rail" }
		if (dutyCycle) return { name: r.name, peakMa: r.loadMa, averageMa: dutyCycleAverageMa(dutyCycle, r.loadMa), source: "duty cycle" }
		return { name: r.name, peakMa: r.loadMa, averageMa: null, source: null }
	})
	const busiest = fed.reduce<Rail | null>((best, r) => (best === null || r.loadMa > best.loadMa ? r : best), null)
	const dutyCycleMa = dutyCycle && busiest ? dutyCycleAverageMa(dutyCycle, busiest.loadMa) : null
	const averageMa = draws.length > 0 && draws.every((d) => d.averageMa !== null) ? draws.reduce((sum, d) => sum + d.averageMa!, 0) : null
	const fromBrief = capacityFromBrief(brief)
	const capacityMah = fromBrief ?? requirements?.batteryMah ?? null
	const regulators = parts.filter((p) => p.role === "ldo").map((p) => regulatorIq(p))
	const regulatorIqUa = regulators.reduce((sum, r) => sum + r.iqUa, 0)
	return {
		rails: draws,
		averageMa,
		dutyCycleMa,
		dutyCycle,
		regulatorIqUa,
		regulators,
		capacityMah,
		capacitySource: fromBrief !== null ? "brief" : requirements?.batteryMah !== undefined ? "requirements" : null,
		days: capacityMah !== null && averageMa !== null ? batteryLifeDays(capacityMah, averageMa, regulatorIqUa) : null,
		targetDays: requirements?.batteryLifeDays ?? null,
	}
}

const ma = (x: number) => `${Number(x.toPrecision(3))} mA`

export function batteryLifeSummary(e: PowerEstimate): string {
	if (e.days !== null) return `${Math.round(e.days)} days${e.targetDays !== null ? ` vs target ${e.targetDays} days` : ""}`
	const missing = e.rails.filter((r) => r.averageMa === null).map((r) => r.name)
	if (e.rails.length === 0 || missing.length > 0) return `unknown (no average current${missing.length > 0 ? ` for ${missing.join(", ")}` : " in the contract"})`
	return "unknown (no battery capacity in the brief or requirements)"
}

export function powerBudgetLines(e: PowerEstimate): string[] {
	const out: string[] = []
	if (e.rails.length > 0) out.push("- Battery-fed rails (each average is that rail's own loads, so they add up):")
	for (const r of e.rails) {
		out.push(`- Rail ${r.name}: peak ${ma(r.peakMa)}, average ${r.averageMa === null ? "not stated" : `${ma(r.averageMa)} (from the ${r.source})`}`)
	}
	if (e.dutyCycle) {
		const d = e.dutyCycle
		out.push(`- Duty cycle: ${d.activeMs} ms active every ${d.periodS} s, ${d.sleepUa} µA asleep${e.dutyCycleMa !== null ? `; at most ${ma(e.dutyCycleMa)} average if active at the busiest rail's peak` : ""}`)
	}
	const each = e.regulators.map((r) => `${r.ref} ${r.mpn} ${r.iqUa} µA, ${r.source === "catalog" ? "from the catalog" : "not in the catalog: assumed AP2112K-class"}`)
	out.push(`- Regulator quiescent current: ${e.regulatorIqUa} µA (${each.length > 0 ? each.join("; ") : "no LDO in the parts"})`)
	out.push(`- Battery: ${e.capacityMah === null ? "capacity not stated" : `${e.capacityMah} mAh (from the ${e.capacitySource})`}`)
	if (e.days === null) {
		out.push(`- Estimated battery life: ${batteryLifeSummary(e)}`)
	} else {
		const terms = [...e.rails.map((r) => ma(r.averageMa!)), ...(e.regulatorIqUa > 0 ? [ma(e.regulatorIqUa / 1000)] : [])]
		out.push(`- Estimated battery life: ${e.capacityMah} mAh / (${terms.join(" + ")}) / 24 h = ${batteryLifeSummary(e)}`)
	}
	return out
}
