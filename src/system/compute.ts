// The checks on a bought compute board (docs/superpowers/specs/2026-11-15-compute-modules-design.md, "Checks"): plain
// code over its module record (catalog/modules/<id>.json), the robot's battery and motors (catalog/mechanics.json) and
// its carrier. Each finding names where its numbers come from. A value the check needs that the record leaves unknown
// (null) is said, as a warning: it never passes silently.
import type { Module } from "../modules/library.ts"
import type { BatteryPack, MotorPart } from "../mechanics/catalog.ts"
import type { AssemblyBoard, AssemblyPlate } from "./assembly.ts"
import { blocksSensor, boardsOverlap, footprint, offPlate, STANDOFF_DEFAULT_MM } from "../dashboard/assembly-geom.js"
import { field, type Cite, type Sourced } from "./bought.ts"

export type ComputeCheck = "compute-power" | "compute-rail" | "compute-header" | "compute-mechanics"
export interface ComputeFinding {
	check: ComputeCheck
	level: "error" | "warning"
	message: string
	sources: Cite[]
}

// The carrier's 5 V regulator: its output, its rated output current and (for a boost from the pack) its input current
// limit. A value nobody has chosen yet is null. `source` names where the figures come from (a datasheet, or "default").
export interface CarrierRegulator {
	outV: number
	maxOutA: number | null
	maxInA?: number | null
	efficiency?: number
	source?: Cite | "default"
}

// A boost from one cell to 5 V converts at about this (ESTIMATE: typical synchronous boost at a few amps; the
// regulator's own datasheet figure replaces it when given).
export const BOOST_EFFICIENCY_ESTIMATE = 0.9
// Headroom over the module's peak draw for the rail, when the peak is the board's own draw. A peak that is the vendor's
// recommended supply (the Raspberry Pi 5's 5 A, which already includes 1.6 A for USB peripherals and the vendor's own
// headroom) needs none on top.
export const RAIL_MARGIN = 0.2

const cite = (c: Cite | null | undefined) => (c ? `${c.url} (${c.where})` : "no source")
const r2 = (n: number) => Math.round(n * 100) / 100
const srcs = (...c: (Cite | null | undefined)[]) => c.filter((x): x is Cite => Boolean(x))
const regCite = (r: CarrierRegulator) => (r.source === "default" || !r.source ? "the carrier's regulator (default figures, no datasheet yet)" : cite(r.source))

// What the 5 V rail must deliver: the module's peak, plus the margin unless the peak is already the vendor's supply rating.
export interface RailNeed { amps: number; margin: number; supplyRating: boolean; volts: number | null; peak: Sourced<number>; inputV: Sourced<{ nom: number; min: number | null; max: number | null }> | undefined }
export function railNeed(m: Module): RailNeed | null {
	const peak = field<number>(m, "currentA.peak")
	const inputV = field<{ nom: number; min: number | null; max: number | null }>(m, "inputV")
	if (peak?.value == null) return null
	const supplyRating = /recommended PSU|power supply|supply the vendor/i.test(`${peak.source?.where ?? ""} ${peak.note ?? ""}`)
	const margin = supplyRating ? 0 : RAIL_MARGIN
	return { amps: r2(peak.value * (1 + margin)), margin, supplyRating, volts: inputV?.value?.nom ?? null, peak, inputV }
}

// (1) Power budget: the module's peak plus both motors at stall, drawn from the one battery, against its discharge
// rating; and the module's draw at the pack's side of the carrier's regulator against that regulator's input limit.
export function powerBudget(m: Module, o: { battery: BatteryPack | null; motors: { part: MotorPart; count: number } | null; regulator: CarrierRegulator | null }): ComputeFinding[] {
	const out: ComputeFinding[] = []
	const peak = field<number>(m, "currentA.peak"), inputV = field<{ nom: number }>(m, "inputV")
	if (peak?.value == null || inputV?.value?.nom == null) {
		out.push({ check: "compute-power", level: "warning", message: `${m.id}: the power budget can't be checked: the record's ${peak?.value == null ? `peak current is unknown (${peak?.note ?? "no note"})` : `input voltage is unknown (${inputV?.note ?? "no note"})`}`, sources: [] })
		return out
	}
	const pb = o.battery
	if (!pb) {
		out.push({ check: "compute-power", level: "warning", message: `${m.id}: the power budget can't be checked: the robot has no battery chosen yet (mechanics.battery.pack)`, sources: srcs(peak.source) })
		return out
	}
	const eff = o.regulator?.efficiency ?? BOOST_EFFICIENCY_ESTIMATE
	const watts = peak.value * inputV.value.nom
	// The worst case is the cell near empty: the regulator then pulls the most current for the same power.
	const moduleA = watts / (eff * pb.cutoffV)
	const stallA = o.motors ? o.motors.count * o.motors.part.stallA * (pb.fullV / o.motors.part.ratedV) : 0
	const needA = moduleA + stallA
	const motorWords = o.motors ? `plus ${o.motors.count} × ${o.motors.part.mpn} at stall, ${r2(stallA)} A on a full ${pb.fullV} V cell (stall ${o.motors.part.stallA} A at ${o.motors.part.ratedV} V: ${cite(o.motors.part.source?.stallA)})` : "with no motors"
	const moduleWords = `${m.id}'s ${peak.value} A peak at ${inputV.value.nom} V (${cite(peak.source)}) is ${r2(watts)} W, ${r2(moduleA)} A from the pack at its ${pb.cutoffV} V cut-off through a ${Math.round(eff * 100)} % regulator${o.regulator?.efficiency == null ? " (estimate)" : ""}`
	if (needA > pb.peakA)
		out.push({ check: "compute-power", level: "error", message: `brown-out risk: ${moduleWords}, ${motorWords}: ${r2(needA)} A in all, over the ${pb.mpn}'s ${pb.peakA} A discharge rating (${cite(pb.source?.peakA)}). The Pi resets when the motors start: use a pack rated for ${Math.ceil(needA)} A or more, or feed the Pi from its own supply`, sources: srcs(peak.source, pb.source?.peakA, o.motors?.part.source?.stallA) })
	if (!o.regulator) out.push({ check: "compute-power", level: "warning", message: `${m.id}: the carrier's regulator isn't chosen yet, so its input limit is unknown; the module alone needs ${r2(moduleA)} A from the pack (${cite(peak.source)})`, sources: srcs(peak.source) })
	else if (o.regulator.maxInA == null) out.push({ check: "compute-power", level: "warning", message: `${m.id}: the carrier regulator's input current limit is unknown (${regCite(o.regulator)}); the module needs ${r2(moduleA)} A on its input at the pack's cut-off`, sources: srcs(peak.source) })
	else if (moduleA > o.regulator.maxInA)
		out.push({ check: "compute-power", level: "error", message: `brown-out risk: ${moduleWords}, over the carrier regulator's ${o.regulator.maxInA} A input limit (${regCite(o.regulator)})`, sources: srcs(peak.source) })
	return out
}

// (2) Rail: the carrier's 5 V regulator delivers the module's peak plus the margin, at the module's input voltage.
export function railCheck(m: Module, reg: CarrierRegulator | null): ComputeFinding[] {
	const need = railNeed(m)
	const peak = field<number>(m, "currentA.peak")
	if (!need) return [{ check: "compute-rail", level: "warning", message: `${m.id}: the rail can't be checked: the record's peak current is unknown (${peak?.note ?? "no note"})`, sources: [] }]
	const why = need.supplyRating ? `the vendor's recommended supply, which already includes its headroom (${cite(need.peak.source)})` : `the ${need.peak.value} A peak plus ${need.margin * 100} % (${cite(need.peak.source)})`
	if (!reg) return [{ check: "compute-rail", level: "warning", message: `${m.id}: the carrier's 5 V regulator isn't chosen yet; it must deliver ${need.amps} A at ${need.volts ?? "?"} V: ${why}`, sources: srcs(need.peak.source) }]
	const out: ComputeFinding[] = []
	if (reg.maxOutA == null) out.push({ check: "compute-rail", level: "warning", message: `${m.id}: the carrier regulator's output current is unknown (${regCite(reg)}); it must deliver ${need.amps} A: ${why}`, sources: srcs(need.peak.source) })
	else if (reg.maxOutA < need.amps)
		out.push({ check: "compute-rail", level: "error", message: `the carrier's 5 V regulator is rated ${reg.maxOutA} A (${regCite(reg)}) but ${m.id} needs ${need.amps} A: ${why}. Pick a regulator rated ${need.amps} A or more`, sources: srcs(need.peak.source) })
	const iv = need.inputV
	if (need.volts != null && reg.outV !== need.volts) {
		const { min, max } = iv!.value!
		if (min == null || max == null)
			out.push({ check: "compute-rail", level: "warning", message: `the carrier's rail is ${reg.outV} V but ${m.id} asks for ${need.volts} V and publishes no tolerance (${iv!.note ?? cite(iv!.source)}): set the rail to ${need.volts} V`, sources: srcs(iv!.source) })
		else if (reg.outV < min || reg.outV > max)
			out.push({ check: "compute-rail", level: "error", message: `the carrier's rail is ${reg.outV} V, outside ${m.id}'s ${min}–${max} V input range (${cite(iv!.source)})`, sources: srcs(iv!.source) })
	}
	return out
}

// A carrier signal on the module's header: the function it must meet (the module's pin label names it) and its pin.
export type HeaderFunction = "5V" | "3V3" | "GND" | "UART TX" | "UART RX" | "I2C SDA" | "I2C SCL" | "PWM"
export interface HeaderSignal { fn: HeaderFunction; pin: number; net?: string }

const pinMatches = (fn: HeaderFunction, label: string) => (fn === "5V" || fn === "3V3" || fn === "GND" ? label === fn : fn === "PWM" ? /\bPWM\d*\b/.test(label) : label.includes(fn))

// The header pins the carrier uses, from the module's pin map: every 5 V and ground pin (the supply goes in on all of
// the 5 V pins), and for a UART bridge the UART's TX and RX. The MCU board's USB (the default) needs no header signal.
export function headerSignals(m: Module, bridge: "usb" | "uart"): HeaderSignal[] {
	const pins = field<Record<string, string>>(m, "header.pins")?.value ?? {}
	const by = (fn: HeaderFunction) => Object.entries(pins).filter(([, l]) => pinMatches(fn, l)).map(([p]) => ({ fn, pin: Number(p) }))
	return [...by("5V"), ...by("GND"), ...(bridge === "uart" ? [...by("UART TX"), ...by("UART RX")] : [])]
}

// (3) Header: every carrier signal lands on a pin with that function, and 5 V goes only onto the 5 V pins.
export function headerCheck(m: Module, signals: HeaderSignal[]): ComputeFinding[] {
	const pins = field<Record<string, string>>(m, "header.pins")
	if (!pins?.value) return [{ check: "compute-header", level: "warning", message: `${m.id}: the header can't be checked: the record has no pin map (${pins?.note ?? "no note"})`, sources: [] }]
	const src = cite(pins.source)
	const out: ComputeFinding[] = []
	for (const s of signals) {
		const label = pins.value[String(s.pin)]
		if (label === undefined) { out.push({ check: "compute-header", level: "error", message: `${s.fn}${s.net ? ` (${s.net})` : ""} is on pin ${s.pin}, which ${m.id}'s header doesn't have (${src})`, sources: srcs(pins.source) }); continue }
		if (pinMatches(s.fn, label)) continue
		const right = Object.entries(pins.value).filter(([, l]) => pinMatches(s.fn, l)).map(([p]) => p)
		const why = s.fn === "5V" ? `5 V goes only onto the 5 V pins (${right.join(", ")}): pin ${s.pin} is ${label}${/GPIO/.test(label) ? ", a 3.3 V GPIO that isn't 5 V tolerant" : ""}` : `pin ${s.pin} is ${label}; ${s.fn} is on pin ${right.join(" or ") || "none"}`
		out.push({ check: "compute-header", level: "error", message: `the carrier's ${s.fn}${s.net ? ` (${s.net})` : ""} lands on the wrong pin of ${m.id}'s header: ${why} (${src})`, sources: srcs(pins.source) })
	}
	return out
}

// A distance sensor's mount in the chassis frame (src/mechanics/model.ts: {xMm, yMm, zMm, sizeMm: [x, y, z]}).
export interface SensorMount { xMm: number; yMm: number; zMm: number; sizeMm: [number, number, number] }

// (4) Mechanics: the module's outline (from the record) fits the plate, overlaps no other board, and doesn't stand in
// front of the distance sensor. `baseZMm` is the module's underside in the chassis frame (the standoffs, plus the
// carrier's stack when it has one). Its height is the record's tallestMm; while that is unknown only the board itself
// (1.6 mm) is known, and the check says so.
export function mechanicsCheck(m: Module, o: { placed: AssemblyBoard; plate: AssemblyPlate; others: AssemblyBoard[]; sensor?: SensorMount | null; baseZMm?: number; maxHeightMm?: number | null }): ComputeFinding[] {
	const out: ComputeFinding[] = []
	const outline = field<{ widthMm: number; heightMm: number }>(m, "outline")
	const tallest = field<number>(m, "tallestMm")
	const src = srcs(outline?.source)
	const where = cite(outline?.source)
	const b = o.placed
	if (offPlate(b, o.plate)) out.push({ check: "compute-mechanics", level: "error", message: `${b.name} (${m.id}, ${b.outline.widthMm} × ${b.outline.heightMm} mm: ${where}) sticks out of the ${o.plate.lengthMm} × ${o.plate.widthMm} mm plate`, sources: src })
	for (const x of o.others) if (x.name !== b.name && boardsOverlap(b, x)) out.push({ check: "compute-mechanics", level: "error", message: `${b.name} (${m.id}, ${b.outline.widthMm} × ${b.outline.heightMm} mm: ${where}) overlaps ${x.name}`, sources: src })
	const known = tallest?.value != null
	const heightMm = known ? (tallest!.value as number) : 1.6
	const base = o.baseZMm ?? STANDOFF_DEFAULT_MM
	if (o.sensor) {
		const f = footprint(b)
		const mount = { xMm: b.xMm, yMm: b.yMm, zMm: base + heightMm / 2, sizeMm: [f.xMm, f.yMm, heightMm] }
		if (blocksSensor(mount, o.sensor)) out.push({ check: "compute-mechanics", level: "error", message: `${b.name} (${m.id}) stands in front of the distance sensor at x ${o.sensor.xMm} mm${known ? "" : " (the board alone, without its parts, already does)"}: move it behind the sensor (${where})`, sources: src })
	}
	if (!known) out.push({ check: "compute-mechanics", level: "warning", message: `${b.name} (${m.id}): unknown height: the record's tallest part isn't known (${tallest?.note ?? "no tallestMm"}), so its clearance${o.sensor ? ", whether it rises into the sensor's view" : ""}${o.maxHeightMm ? ` and the brief's ${o.maxHeightMm} mm height` : ""} can't be checked`, sources: [] })
	else if (o.maxHeightMm != null && base + heightMm > o.maxHeightMm)
		out.push({ check: "compute-mechanics", level: "error", message: `${b.name} (${m.id}) reaches ${r2(base + heightMm)} mm (${heightMm} mm tall: ${cite(tallest!.source)}), over the brief's ${o.maxHeightMm} mm`, sources: srcs(tallest!.source) })
	return out
}
