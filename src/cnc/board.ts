import type { ContractSnapshot, Part } from "../contract/types.ts"
import { COMPUTE, resolveEnd, type ChipCtx, type ChipJob, type Spec } from "../codegen/chip-support.ts"
import { CNC_AXES } from "./types.ts"

// The CNC's stepper drivers on the board (docs/cnc.md gap 5): each driver's context for its catalog entry's wiring
// (catalog/parts.json TMC2209-LA "nets"/"support", src/codegen/chip-support.ts), and its sense resistors.
// circuit.ts registers stepperDriverCtx (registerChipContext); this module doesn't import circuit.ts.

// The drivers in the parts list's order drive the machine's motors in axis order, a gantry axis's two in turn:
// X, Y1, Y2, Z for the scripted CNC. Each motor's plug is a contract part whose pins put A1/A2/B1/B2 on the nets
// "<MOTOR>_A1"… the driver's outputs share ("@" nets).
export function cncMotors(s: ContractSnapshot): { label: string; axis: string; currentA: number; addr: number }[] {
	const m = s.values.cnc
	if (!m) return []
	const used = new Set(m.axes.map((a) => a.driver.uartAddr))
	const free = [0, 1, 2, 3].filter((a) => !used.has(a))
	const out: { label: string; axis: string; currentA: number; addr: number }[] = []
	for (const name of CNC_AXES) {
		const a = m.axes.find((x) => x.name === name)
		if (!a) continue
		for (let k = 0; k < a.motors; k++)
			out.push({ label: `${name.toUpperCase()}${a.motors > 1 ? k + 1 : ""}`, axis: name, currentA: a.driver.currentA, addr: k === 0 ? a.driver.uartAddr : (free.shift() ?? -1) })
	}
	return out
}

// The net the motors' supply is on: the contract's rail at the brick's volts (as circuit.ts netName names it).
export function motorSupplyRail(s: ContractSnapshot): string | null {
	const v = s.values.cnc?.input.volts
	const r = v === undefined ? undefined : (s.values.rails ?? []).find((x) => Math.abs(x.voltageV - v) < 0.5)
	return r ? (/^\d/.test(r.name) ? `V${r.name}` : r.name) : null
}

// The spindle's gate driver (the SN74AHCT1G125, role spindle-driver): VCC on the logic 5 V (logic5V: circuit.ts hands
// the power tree's step-down net), OE on GND until the emergency stop cuts it (gap 7), the flyback's cathode on the
// motor rail (the brick's net). Null when the board has no motor rail yet.
export function spindleDriverCtx(s: ContractSnapshot, part: Part, logic5V: string): ChipCtx | null {
	if (part.role !== "spindle-driver") return null
	const motor = switchedRail(s) ?? motorSupplyRail(s) ?? (s.values.parts ?? []).find((p) => p.mpn === "DC-091-A250")?.nets?.VIN
	// With the e-stop switch, the stop also disables the buffer (OE high: Y off, the gate's pull-down holds the spindle off).
	return motor ? { in: logic5V, oe: hasEstopSwitch(s) ? "@ESTOP_TRIP" : "GND", motor: `@${motor}` } : null
}

// The CNC's emergency stop (gap 7): a high-side P-FET (role estop-switch) between the brick's motor rail and VMOT_SW, its
// gate held on only through the e-stop's NC loop. The drivers and the spindle are fed from VMOT_SW; the logic's step-down
// stays on the unswitched rail.
export const VMOT_SW_NET = "VMOT_SW"
export const hasEstopSwitch = (s: ContractSnapshot) => (s.values.parts ?? []).some((p) => p.role === "estop-switch")
export const switchedRail = (s: ContractSnapshot) => (hasEstopSwitch(s) && motorSupplyRail(s) ? VMOT_SW_NET : null)
export function estopSwitchCtx(s: ContractSnapshot, part: Part): ChipCtx | null {
	if (part.role !== "estop-switch") return null
	const vm = motorSupplyRail(s)
	return vm ? { in: vm, out: VMOT_SW_NET } : null
}
// The enable gate (OR) and a limit switch's plug: their nets are fixed in their catalog entries; they only need a context.
export const fixedCtx = (role: string) => (_s: ContractSnapshot, part: Part): ChipCtx | null => (part.role === role ? {} : null)

export function stepperDriverCtx(s: ContractSnapshot, part: Part): ChipCtx | null {
	if (part.role !== "stepper-driver") return null
	const drivers = (s.values.parts ?? []).filter((p) => p.role === "stepper-driver")
	const motor = cncMotors(s)[drivers.indexOf(part)]
	const vm = motorSupplyRail(s)
	if (!motor || !vm || motor.addr < 0) return null
	const bit = (b: number) => (motor.addr & b ? "rail:3V3" : "GND")
	// With the e-stop's enable gate, every driver's ENN is its output (STEPPERS_ENN); without it the MCU's pins drive ENN.
	const enn = (s.values.parts ?? []).some((p) => p.role === "enable-gate") ? { enn: "@STEPPERS_ENN" } : {}
	return { in: switchedRail(s) ?? vm, ...enn, ms1: bit(1), ms2: bit(2), oa1: `@${motor.label}_A1`, oa2: `@${motor.label}_A2`, ob1: `@${motor.label}_B1`, ob2: `@${motor.label}_B2`, currentA: motor.currentA }
}

// Sense resistors the board may take (1206, 1 %, 0.25 W; LCSC pages read 26 Nov 2026). C2941110 is 15 mΩ, not 150.
export const SENSE_RESISTORS: (Spec & { ohms: number; source: string })[] = [
	{ kind: "resistor", value: "0.15", ohms: 0.15, lcsc: "C37936", mpn: "1206W4F150LT5E", footprint: "1206", source: "https://jlcpcb.com/partdetail/C37936: 150 mΩ ±1 % 250 mW 1206 (UNI-ROYAL)" },
	{ kind: "resistor", value: "0.1", ohms: 0.1, lcsc: "C25334", mpn: "1206W4F100LT5E", footprint: "1206", source: "https://jlcpcb.com/partdetail/C25334: 100 mΩ ±1 % 250 mW 1206 (UNI-ROYAL)" },
]
// The TMC2209's full-scale RMS current with a sense resistor (datasheet rev 1.09 §9: I_RMS = (CS+1)/32 · V_FS/(R+20 mΩ)
// · 1/√2, CS 31, V_FS 325 mV).
export const tmc2209MaxRmsA = (ohms: number) => 0.325 / (ohms + 0.02) / Math.SQRT2
// The largest catalog sense resistor whose full scale still covers the run current (the finest current steps).
export function senseResistor(currentA: number): (typeof SENSE_RESISTORS)[number] | null {
	return [...SENSE_RESISTORS].sort((a, b) => b.ohms - a.ohms).find((r) => tmc2209MaxRmsA(r.ohms) >= currentA) ?? null
}

// { compute: "rsense" }, a: the sense pin, b: GND: the resistor for the context's run current (ctx.currentA).
COMPUTE.rsense = (e, chip, ctx): ChipJob[] => {
	const r = typeof ctx.currentA === "number" ? senseResistor(ctx.currentA) : null
	if (!r) throw new Error(`chip support: ${chip.ref}'s sense resistor needs ctx.currentA within the catalog's range (${ctx.currentA})`)
	const a = resolveEnd(e.a ?? "", chip, ctx), b = resolveEnd(e.b ?? "", chip, ctx)
	const { ohms: _o, source: _s, ...spec } = r
	return a && b ? [{ job: `${chip.ref} ${e.job} (${r.value} Ω: ${tmc2209MaxRmsA(r.ohms).toFixed(2)} A RMS full scale for ${ctx.currentA} A)`, spec, a, b, near: chip.ref, ...(e.bound ? { bound: e.bound } : {}) }] : []
}
