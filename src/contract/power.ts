import { QUIESCENT_A } from "../codegen/spice.ts"
import type { ContractSnapshot, DutyCycle, Rail } from "./types.ts"

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

export interface PowerEstimate {
	rail: string | null
	peakMa: number | null
	averageMa: number | null
	averageSource: "rail" | "duty cycle" | null
	// Upper bound from the duty cycle, taking the rail's peak load as the active current.
	dutyCycleMa: number | null
	dutyCycle: DutyCycle | null
	regulatorIqUa: number
	capacityMah: number | null
	capacitySource: "brief" | "requirements" | null
	days: number | null
	targetDays: number | null
}

// The rail the battery feeds: one named for the battery, else the busiest rail that is not the USB input.
function batteryRail(rails: Rail[]): Rail | null {
	const candidates = rails.filter((r) => !/VBUS|USB/i.test(r.name))
	const named = candidates.find((r) => /BAT/i.test(r.name) && r.averageMa !== undefined)
	if (named) return named
	const withAverage = candidates.filter((r) => r.averageMa !== undefined)
	const pool = withAverage.length > 0 ? withAverage : candidates
	return pool.reduce<Rail | null>((best, r) => (best === null || (r.averageMa ?? r.loadMa) > (best.averageMa ?? best.loadMa) ? r : best), null)
}

export function estimatePower(s: ContractSnapshot, brief: string): PowerEstimate {
	const { rails = [], requirements, parts = [] } = s.values
	const rail = batteryRail(rails)
	const dutyCycle = requirements?.dutyCycle ?? null
	const dutyCycleMa = dutyCycle && rail ? dutyCycleAverageMa(dutyCycle, rail.loadMa) : null
	const averageMa = rail?.averageMa ?? dutyCycleMa
	const fromBrief = capacityFromBrief(brief)
	const capacityMah = fromBrief ?? requirements?.batteryMah ?? null
	const regulatorIqUa = parts.some((p) => p.role === "ldo") ? Math.round(QUIESCENT_A * 1e6) : 0
	return {
		rail: rail?.name ?? null,
		peakMa: rail?.loadMa ?? null,
		averageMa,
		averageSource: rail?.averageMa !== undefined ? "rail" : dutyCycleMa !== null ? "duty cycle" : null,
		dutyCycleMa,
		dutyCycle,
		regulatorIqUa,
		capacityMah,
		capacitySource: fromBrief !== null ? "brief" : requirements?.batteryMah !== undefined ? "requirements" : null,
		days: capacityMah !== null && averageMa !== null ? batteryLifeDays(capacityMah, averageMa, regulatorIqUa) : null,
		targetDays: requirements?.batteryLifeDays ?? null,
	}
}

const ma = (x: number) => `${Number(x.toPrecision(3))} mA`

export function batteryLifeSummary(e: PowerEstimate): string {
	if (e.days === null) return `unknown (${e.averageMa === null ? "no average current in the contract" : "no battery capacity in the brief or requirements"})`
	return `${Math.round(e.days)} days${e.targetDays !== null ? ` vs target ${e.targetDays} days` : ""}`
}

export function powerBudgetLines(e: PowerEstimate): string[] {
	const out: string[] = []
	if (e.rail) out.push(`- Rail ${e.rail}: peak ${ma(e.peakMa!)}, average ${e.averageMa === null ? "not stated" : `${ma(e.averageMa)} (from the ${e.averageSource})`}`)
	if (e.dutyCycle) {
		const d = e.dutyCycle
		out.push(`- Duty cycle: ${d.activeMs} ms active every ${d.periodS} s, ${d.sleepUa} µA asleep${e.dutyCycleMa !== null ? `; at most ${ma(e.dutyCycleMa)} average if active at the rail's peak` : ""}`)
	}
	out.push(`- Regulator quiescent current: ${e.regulatorIqUa} µA${e.regulatorIqUa > 0 ? " (AP2112K-class LDO, worst case)" : " (no LDO in the parts)"}`)
	out.push(`- Battery: ${e.capacityMah === null ? "capacity not stated" : `${e.capacityMah} mAh (from the ${e.capacitySource})`}`)
	if (e.days === null) {
		out.push(`- Estimated battery life: ${batteryLifeSummary(e)}`)
	} else {
		out.push(`- Estimated battery life: ${e.capacityMah} mAh / (${ma(e.averageMa!)} + ${ma(e.regulatorIqUa / 1000)}) / 24 h = ${batteryLifeSummary(e)}`)
	}
	return out
}
