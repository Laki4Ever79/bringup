import { BLE_READING_MS, bleAdvertiseMs, templateConstant } from "../codegen/firmware.ts"
import { readFileSync } from "node:fs"
import { DROPOUT_MV, QUIESCENT_A, type LdoModel } from "../codegen/spice.ts"
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
// cpuMa / radioMa: an MCU's datasheet current with the CPU running and with the radio on, for the duty-cycle check.
type CatalogIq = { mpn: string; iqUa?: number; sleepUa?: number; cpuMa?: number; radioMa?: number; dropoutMv?: number; dropoutAtMa?: number }
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

// The sleep current to use: the contract's duty-cycle sleepUa, but never below the MCU's datasheet deep-sleep floor
// (catalog sleepUa). A design can't sleep below its chip; real run 8 claimed 0 µA.
export interface SleepCurrent {
	sleepUa: number
	raisedFrom: number | null // the contract's figure, when it was below the floor
	floorFrom: string | null // the MCU whose datasheet floor applies
}

export function effectiveSleepUa(s: ContractSnapshot, entries: CatalogIq[] = catalog()): SleepCurrent | null {
	const d = s.values.requirements?.dutyCycle
	if (!d) return null
	const mcu = (s.values.parts ?? []).find((p) => p.role === "mcu")
	const floor = mcu ? entries.find((c) => c.mpn.toUpperCase() === mcu.mpn.toUpperCase())?.sleepUa : undefined
	if (typeof floor !== "number") return { sleepUa: d.sleepUa, raisedFrom: null, floorFrom: null }
	return d.sleepUa < floor ? { sleepUa: floor, raisedFrom: d.sleepUa, floorFrom: mcu!.mpn } : { sleepUa: d.sleepUa, raisedFrom: null, floorFrom: mcu!.mpn }
}

// The bench's measured rail average: the charge each wake draws above the board's floor (µC), spread over the
// contract's period, plus the design's sleep current. Pass sleepUa from effectiveSleepUa so a 0 µA claim can't pass.
export function measuredAverageMa(m: { chargeUc: number; periodS: number; sleepUa: number }): number {
	if (!(m.periodS > 0)) throw new Error(`measuredAverageMa: periodS must be > 0, got ${m.periodS}`)
	return (m.chargeUc / m.periodS + m.sleepUa) / 1000
}

// The LDO's behavioural model for the power simulation: dropout and quiescent current from its catalog entry, else the
// AP2112K-class worst case (400 mV at the rail's rating, 55 µA).
export function ldoModel(part: Part, entries: CatalogIq[] = catalog()): LdoModel {
	const c = entries.find((e) => e.mpn.toUpperCase() === part.mpn.toUpperCase())
	if (c && typeof c.iqUa === "number" && typeof c.dropoutMv === "number" && typeof c.dropoutAtMa === "number") {
		return { mpn: part.mpn, iqUa: c.iqUa, dropoutMv: c.dropoutMv, dropoutAtMa: c.dropoutAtMa, source: "catalog" }
	}
	return { mpn: part.mpn, iqUa: typeof c?.iqUa === "number" ? c.iqUa : ASSUMED_IQ_UA, dropoutMv: DROPOUT_MV, dropoutAtMa: null, source: "assumed" }
}

export interface RailDraw {
	name: string
	peakMa: number
	averageMa: number | null
	source: "rail" | "measured" | "duty cycle" | null
	// The firmware revision the bench measured it on, when source is "measured".
	measuredRevision?: number
	// Its stated average equals this lower-voltage rail's: read as including that rail's loads (the input of the LDO
	// that feeds it), so it is counted once, not twice (real run 20).
	sameAs?: string
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
	sleep: SleepCurrent | null
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
	const sleep = effectiveSleepUa(s)
	const dutyCycle = requirements?.dutyCycle ? { ...requirements.dutyCycle, sleepUa: sleep!.sleepUa } : null
	const draws: RailDraw[] = fed.map((r) => {
		if (r.averageMa !== undefined && r.averageSource === "measured") return { name: r.name, peakMa: r.loadMa, averageMa: r.averageMa, source: "measured", measuredRevision: r.measuredRevision }
		if (r.averageMa !== undefined) return { name: r.name, peakMa: r.loadMa, averageMa: r.averageMa, source: "rail" }
		if (dutyCycle) return { name: r.name, peakMa: r.loadMa, averageMa: dutyCycleAverageMa(dutyCycle, r.loadMa), source: "duty cycle" }
		return { name: r.name, peakMa: r.loadMa, averageMa: null, source: null }
	})
	for (const d of draws) {
		if (d.source !== "rail" || !(d.averageMa! > 0)) continue
		const v = fed.find((r) => r.name === d.name)!.voltageV
		const lower = draws.find((o) => o !== d && o.source === "rail" && o.averageMa === d.averageMa && fed.find((r) => r.name === o.name)!.voltageV < v)
		if (lower) d.sameAs = lower.name
	}
	const busiest = fed.reduce<Rail | null>((best, r) => (best === null || r.loadMa > best.loadMa ? r : best), null)
	const dutyCycleMa = dutyCycle && busiest ? dutyCycleAverageMa(dutyCycle, busiest.loadMa) : null
	const averageMa = draws.length > 0 && draws.every((d) => d.averageMa !== null) ? draws.reduce((sum, d) => sum + (d.sameAs ? 0 : d.averageMa!), 0) : null
	const fromBrief = capacityFromBrief(brief)
	const capacityMah = fromBrief ?? requirements?.batteryMah ?? null
	const regulators = parts.filter((p) => p.role === "ldo").map((p) => regulatorIq(p))
	const regulatorIqUa = regulators.reduce((sum, r) => sum + r.iqUa, 0)
	return {
		rails: draws,
		averageMa,
		dutyCycleMa,
		dutyCycle,
		sleep,
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
	const measured = e.rails.filter((r) => r.source === "measured").map((r) => `${r.name} measured on bench${r.measuredRevision !== undefined ? `, rev ${r.measuredRevision}` : ""}`)
	if (e.days !== null) return `${Math.round(e.days)} days${e.targetDays !== null ? ` vs target ${e.targetDays} days` : ""}${measured.length ? ` (${measured.join("; ")})` : ""}`
	const missing = e.rails.filter((r) => r.averageMa === null).map((r) => r.name)
	if (e.rails.length === 0 || missing.length > 0) return `unknown (no average current${missing.length > 0 ? ` for ${missing.join(", ")}` : " in the contract"})`
	return "unknown (no battery capacity in the brief or requirements)"
}

export function powerBudgetLines(e: PowerEstimate): string[] {
	const out: string[] = []
	if (e.rails.length > 0) out.push("- Battery-fed rails (each average is that rail's own loads, so they add up):")
	for (const r of e.rails) {
		const from = r.source === "measured" ? `measured on bench${r.measuredRevision !== undefined ? `, rev ${r.measuredRevision}` : ""}` : `from the ${r.source}`
		const same = r.sameAs ? `; the same as ${r.sameAs}'s, so read as including ${r.sameAs}'s loads and counted once` : ""
		out.push(`- Rail ${r.name}: peak ${ma(r.peakMa)}, average ${r.averageMa === null ? "not stated" : `${ma(r.averageMa)} (${from}${same})`}`)
	}
	if (e.dutyCycle) {
		const d = e.dutyCycle
		const asleep = e.sleep?.raisedFrom != null ? `${e.sleep.raisedFrom} µA asleep stated, raised to the ${e.sleep.floorFrom}'s ${d.sleepUa} µA deep-sleep floor (datasheet)` : `${d.sleepUa} µA asleep`
		out.push(`- Duty cycle: ${d.activeMs} ms active every ${d.periodS} s, ${asleep}${e.dutyCycleMa !== null ? `; at most ${ma(e.dutyCycleMa)} average if active at the busiest rail's peak` : ""}`)
	}
	const each = e.regulators.map((r) => `${r.ref} ${r.mpn} ${r.iqUa} µA, ${r.source === "catalog" ? "from the catalog" : "not in the catalog: assumed AP2112K-class"}`)
	out.push(`- Regulator quiescent current: ${e.regulatorIqUa} µA (${each.length > 0 ? each.join("; ") : "no LDO in the parts"})`)
	out.push(`- Battery: ${e.capacityMah === null ? "capacity not stated" : `${e.capacityMah} mAh (from the ${e.capacitySource})`}`)
	if (e.days === null) {
		out.push(`- Estimated battery life: ${batteryLifeSummary(e)}`)
	} else {
		const terms = [...e.rails.filter((r) => !r.sameAs).map((r) => ma(r.averageMa!)), ...(e.regulatorIqUa > 0 ? [ma(e.regulatorIqUa / 1000)] : [])]
		out.push(`- Estimated battery life: ${e.capacityMah} mAh / (${terms.join(" + ")}) / 24 h = ${batteryLifeSummary(e)}`)
	}
	return out
}

// For the reviewer, like DRC or SPICE: battery life derived from the duty cycle alone, with every input shown, so it
// doesn't have to re-derive it by hand or trust the rails' stated averages (real runs 15 and 16).
export function dutyCycleCheckLines(e: PowerEstimate, s?: ContractSnapshot, entries: CatalogIq[] = catalog()): string[] {
	const d = e.dutyCycle
	const peak = Math.max(0, ...e.rails.map((r) => r.peakMa))
	if (!d) return ["Battery-life check: not computed (no requirements.dutyCycle)"]
	if (peak <= 0) return ["Battery-life check: not computed (no battery-fed rail with a peak current)"]
	const n = (x: number) => Number(x.toPrecision(3))
	const mcuSleep = e.sleep?.raisedFrom != null ? `${d.sleepUa} µA (MCU deep-sleep floor; ${e.sleep.raisedFrom} µA stated)` : `${d.sleepUa} µA (MCU deep sleep)`
	const ldo = e.regulatorIqUa > 0 ? ` + ${e.regulatorIqUa} µA (LDO quiescent)` : ""
	// The firmware is awake for the reading plus its BLE window: activeMs, unless that is too short for both.
	const advertiseMs = bleAdvertiseMs(d)
	const wakeMs = Math.max(d.activeMs, BLE_READING_MS + advertiseMs)
	const wake = { ...d, activeMs: wakeMs }
	const connectedS = templateConstant("BLE_CONNECTED_MAX_MS") / 1000
	const lifeLine = (averageMa: number, label: string) => {
		const days = e.capacityMah !== null ? e.capacityMah / averageMa / 24 : null
		return days === null
			? `- ${label} ${ma(averageMa)}; battery life unknown (no capacity in the brief or requirements)`
			: `- ${label} ${ma(averageMa)}; ${e.capacityMah} mAh / ${ma(averageMa)} / 24 h = ${Math.round(days)} days${e.targetDays !== null ? ` vs target ${e.targetDays} days` : ""}`
	}
	const firmwareWake = `- The firmware's wake: the ${BLE_READING_MS} ms reading, then ${advertiseMs} ms of BLE advertising (BLE_ADVERTISE_MS, from activeMs)${wakeMs > d.activeMs ? `, ${wakeMs} ms in all (requirements.dutyCycle.activeMs says ${d.activeMs} ms)` : ""}. A phone that connects keeps it awake up to ${connectedS} s, which this average leaves out.`
	const asleep = `- Asleep the rest of the ${d.periodS} s period: ${mcuSleep}${ldo}`
	const worstMa = dutyCycleAverageMa(wake, peak) + e.regulatorIqUa / 1000
	// The MCU's datasheet currents per phase, when the catalog lists them: the reading with the CPU running, the
	// advertising window with the radio on. Charging the whole wake at the rail's peak (a regulator sizing figure) was
	// a modelling error the reviewer then trusted; it stays below as the labelled worst case.
	const mcu = s ? (s.values.parts ?? []).find((p) => p.role === "mcu") : undefined
	const figures = mcu ? entries.find((c) => c.mpn.toUpperCase() === mcu.mpn.toUpperCase()) : undefined
	if (mcu && typeof figures?.cpuMa === "number" && typeof figures.radioMa === "number") {
		const readingMc = (figures.cpuMa * BLE_READING_MS) / 1000
		const advertiseMc = (figures.radioMa * advertiseMs) / 1000
		const asleepMa = (1 - wakeMs / (d.periodS * 1000)) * (d.sleepUa / 1000)
		// The status LED's blink, bounded without the LED's data: 3.3 V across the board generator's 1k resistor.
		const hasLed = (s!.values.parts ?? []).some((p) => p.role === "led")
		const blinkMs = templateConstant("READING_BLINK_MS")
		const ledMa = 3.3 / 1
		const ledMc = hasLed && Number.isFinite(blinkMs) ? (ledMa * blinkMs) / 1000 : 0
		const averageMa = (readingMc + advertiseMc + ledMc) / d.periodS + asleepMa + e.regulatorIqUa / 1000
		return [
			`Battery-life check (computed in code from the duty cycle and ${mcu.ref} ${mcu.mpn}'s datasheet currents, not from the rails' stated averages):`,
			firmwareWake,
			`- Reading: ${BLE_READING_MS} ms at ${figures.cpuMa} mA (CPU running, datasheet) = ${n(readingMc)} mC`,
			`- Advertising: ${advertiseMs} ms at ${figures.radioMa} mA (radio receiving, datasheet; it gives no Bluetooth LE figure, so the receive current stands in for the whole window, which keeps the radio on while advertising transmits in short bursts) = ${n(advertiseMc)} mC`,
			...(ledMc > 0 ? [`- Status LED blink: ${blinkMs} ms at no more than ${ledMa} mA (3.3 V across its 1k resistor; the LED's own forward drop only lowers it) = ${n(ledMc)} mC`] : []),
			asleep,
			lifeLine(averageMa, "Average"),
			...connectionLines(e, averageMa, figures.radioMa, connectedS),
			"- Leaves out the other parts' currents while awake (charger and LDO idle, button pull-up).",
			`- Worst case, the busiest battery-fed rail's peak (${ma(peak)}, a regulator sizing figure) for the whole ${wakeMs} ms wake:`,
			lifeLine(worstMa, "  worst-case average"),
		]
	}
	return [
		"Battery-life check (computed in code from the duty cycle, not from the rails' stated averages):",
		`- Each reading: ${wakeMs} ms awake${wakeMs > d.activeMs ? ` (requirements.dutyCycle.activeMs says ${d.activeMs} ms)` : ""} at up to ${ma(peak)} (the busiest battery-fed rail's peak) = ${n((peak * wakeMs) / 1000)} mC`,
		`- The firmware's wake: the ${BLE_READING_MS} ms reading, then ${advertiseMs} ms of BLE advertising (BLE_ADVERTISE_MS, from activeMs). A phone that connects keeps it awake up to ${connectedS} s, which this average leaves out.`,
		asleep,
		lifeLine(worstMa, "Average"),
		"- Assumes the firmware sleeps between readings as requirements.dutyCycle says, and the peak current for the whole wake (an upper bound on current). So a result at or above the target shows the target is met; one below it does not by itself show it is missed: then judge the stated average against the parts.",
	]
}

// The brief requires accepting a connection, but not how often one comes, so the check can't charge for it. Instead it
// says how many full-length connections a day the target leaves room for (real beacon run N: blocked on "the average
// leaves out connected time").
function connectionLines(e: PowerEstimate, averageMa: number, radioMa: number, connectedS: number): string[] {
	if (e.capacityMah === null || e.targetDays === null || !(e.targetDays > 0)) return []
	const allowedMa = e.capacityMah / (e.targetDays * 24)
	const eachMc = radioMa * connectedS
	const spareMa = allowedMa - averageMa
	const perDay = spareMa > 0 ? Math.floor((spareMa * 86400) / eachMc) : 0
	return [
		`- Connections: a phone that connects keeps it awake up to ${connectedS} s at about ${radioMa} mA (${n3(eachMc)} mC each). The ${e.targetDays}-day target allows ${ma(allowedMa)} on average; ${spareMa > 0 ? `${ma(spareMa)} above this average, which pays for ${perDay} full-length connection${perDay === 1 ? "" : "s"} a day` : "this average already uses all of it"} (the brief does not say how often a phone connects).`,
	]
}
const n3 = (x: number) => Number(x.toPrecision(3))

// The MCU's datasheet currents from the catalog, when it lists them.
export function mcuCurrents(s: ContractSnapshot, entries: CatalogIq[] = catalog()): { ref: string; mpn: string; cpuMa: number; radioMa: number } | null {
	const mcu = (s.values.parts ?? []).find((p) => p.role === "mcu")
	const c = mcu ? entries.find((e) => e.mpn.toUpperCase() === mcu.mpn.toUpperCase()) : undefined
	return mcu && typeof c?.cpuMa === "number" && typeof c.radioMa === "number" ? { ref: mcu.ref, mpn: mcu.mpn, cpuMa: c.cpuMa, radioMa: c.radioMa } : null
}
