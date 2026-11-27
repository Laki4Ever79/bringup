// The CNC's emergency stop (gap 7): the e-stop's NC contact can't break the motor rail itself (the A22E: 1.5 A inductive
// at 24 V DC, against a brick of up to 6.67 A into four steppers and a spindle), so it holds a P-FET's gate loop instead
// (catalog AO4407A, role estop-switch; src/cnc/board.ts). These checks judge that loop with the catalog's numbers:
//   - the contact switches only the loop's current, inside its rating and over its minimum load (at the brick's low end);
//   - the gate never sees more than the FET's VGS maximum (the divider at the brick's high end, held by the Zener);
//   - the soft start keeps the inrush into the drivers' bulk capacitors under the brick's current; the turn-off's energy
//     in the FET stays under its repetitive avalanche rating, used for scale (ESTIMATES, from a first-order gate model).
import type { ContractValues } from "../contract/types.ts"
import type { MechCatalog } from "../mechanics/catalog.ts"
import type { MechViolation } from "../mechanics/checks.ts"
import { DEFAULT_BRICK_TOLERANCE_PCT } from "../arm/tvs.ts"

interface SwitchEntry {
	mpn: string
	role: string
	vgsMaxV: number
	earMj: number
	gate: { topOhm: number; bottomOhm: number; clampV: number; rOnOhm: number; cgdF: number; plateauV: number }
}
// The drivers' bulk on the switched rail, per TMC2209: its entry's 100 uF electrolytic and 10 uF ceramic on VS.
export const BULK_PER_DRIVER_F = 110e-6
// A silicon diode's drop on the fast turn-off path (the 1N4148W at a few mA): an estimate.
const DIODE_DROP_V = 0.7

export interface EstopFigures {
	loopMa: { min: number; max: number }
	vgsMaxV: number
	inrushA: number
	rampMs: number
	offMs: number
	offMj: number
}

export function estopFigures(values: Partial<ContractValues>, sw: SwitchEntry): EstopFigures | null {
	const m = values.cnc
	if (!m) return null
	const tol = DEFAULT_BRICK_TOLERANCE_PCT / 100
	const [vLo, vHi] = [m.input.volts * (1 - tol), m.input.volts * (1 + tol)]
	const g = sw.gate
	const sum = g.topOhm + g.bottomOhm
	const drive = (v: number) => (v * g.topOhm) / sum // VSG the divider sets
	const vgsMaxV = Math.min(drive(vHi), g.clampV)
	// Turn-on: the gate falls through the 47k; at the Miller plateau the drain's dV/dt is that current over Cgd.
	const ion = (drive(m.input.volts) - g.plateauV) / g.rOnOhm
	const dvdt = ion / g.cgdF
	const drivers = (values.parts ?? []).filter((p) => p.role === "stepper-driver").length
	const inrushA = drivers * BULK_PER_DRIVER_F * dvdt
	// Turn-off: the divider's middle rises to the source through the top resistor and lifts the gate through the diode.
	const ioff = (g.plateauV - DIODE_DROP_V) / g.topOhm
	const offS = (g.cgdF * m.input.volts) / ioff
	const r = (x: number, k = 2) => Math.round(x * 10 ** k) / 10 ** k
	return {
		loopMa: { min: r((vLo / sum) * 1000), max: r((vHi / sum) * 1000) },
		vgsMaxV: r(vgsMaxV),
		inrushA: r(inrushA),
		rampMs: r((m.input.volts / dvdt) * 1000, 1),
		offMs: r(offS * 1000),
		offMj: r(0.5 * m.input.volts * m.input.amps * offS * 1000, 1),
	}
}

export function estopChecks(values: Partial<ContractValues>, cat: { mech: MechCatalog; boardParts?: unknown }): MechViolation[] {
	const m = values.cnc
	if (!m || !values.parts) return []
	const out: MechViolation[] = []
	const parts = values.parts
	const stop = cat.mech.safety?.find((x) => x.mpn === m.estop)
	const sw = parts.find((p) => p.role === "estop-switch")
	const plug = parts.find((p) => p.role === "estop" && p.pins.includes("LOOP"))
	const bad = (message: string) => out.push({ kind: "cnc-wiring", message, fields: ["parts"], affects: ["parts"] })
	if (!stop) return out
	if (!sw) {
		// No switch: the contact would break the motor rail itself.
		if (stop.dcInductiveA !== undefined && stop.dcInductiveA < m.input.amps)
			bad(`the e-stop ${stop.mpn} breaks ${stop.dcInductiveA} A of inductive load at ${stop.ratedDcV} V DC, under the ${m.input.amps} A the ${m.input.volts} V brick feeds the steppers and spindle: put its NC contact in a power switch's gate loop (catalog role estop-switch, the AO4407A: VMOT to VMOT_SW) and its plug (role estop, B2B-XH-A-R)`)
		return out
	}
	if (!plug) bad(`the e-stop switch ${sw.ref} has no plug for the button's NC contact: add the e-stop's plug (catalog role estop, B2B-XH-A-R(LF)(SN), LOOP on @ESTOP_LOOP)`)
	const entry = ((cat.boardParts ?? []) as SwitchEntry[]).find((x) => x.mpn === sw.mpn && x.gate)
	if (!entry) return out
	const f = estopFigures(values, entry)
	if (!f) return out
	if (stop.minLoadMa !== undefined && f.loopMa.min < stop.minLoadMa) bad(`the e-stop's gate loop carries ${f.loopMa.min} mA at the brick's low end, under the ${stop.mpn}'s ${stop.minLoadMa} mA minimum load (its contact needs that current to stay reliable): a smaller gate divider`)
	if (stop.dcResistiveA !== undefined && f.loopMa.max / 1000 > stop.dcResistiveA) bad(`the e-stop's gate loop carries ${f.loopMa.max} mA, over the ${stop.mpn}'s ${stop.dcResistiveA} A rating`)
	if (f.vgsMaxV > entry.vgsMaxV) bad(`${sw.ref} ${sw.mpn}'s gate sees ${f.vgsMaxV} V at the brick's high end, over its ${entry.vgsMaxV} V maximum`)
	if (f.inrushA > m.input.amps) bad(`${sw.ref}'s soft start lets about ${f.inrushA} A into the drivers' bulk capacitors (an estimate: ${f.rampMs} ms ramp), over the ${m.input.amps} A brick: a larger gate resistor or Miller capacitor`)
	if (f.offMj > entry.earMj) bad(`${sw.ref}'s turn-off puts about ${f.offMj} mJ into it (an estimate: ${f.offMs} ms at up to ${m.input.amps} A), over its ${entry.earMj} mJ repetitive avalanche rating: a faster turn-off (a smaller top resistor)`)
	return out
}

// The spindle's stall stop (lead-2, after gap 11): a stalled spindle draws up to the brick's current (6.67 A) and cooks its
// MOSFET in seconds (catalog AO4468: ~1.3 W hot, Tj ~125 C), so the board must measure its current: a current-sense
// amplifier (role current-sense) on a shunt under the MOSFET's source, its full scale over the brick's current, its
// output on an MCU GPIO the firmware reads (SPINDLE_I).
interface SenseEntry {
	mpn: string
	gainVV: number
	support?: { shuntOhm?: number }[]
}
export function spindleSenseChecks(values: Partial<ContractValues>, cat: { boardParts?: unknown }): MechViolation[] {
	const m = values.cnc, parts = values.parts
	if (!m || !parts || !parts.some((p) => p.role === "spindle-driver")) return []
	const out: MechViolation[] = []
	const sense = parts.find((p) => p.role === "current-sense")
	if (!sense) {
		out.push({ kind: "cnc-wiring", message: `the spindle has no current sense: a stall (up to the brick's ${m.input.amps} A) can't be seen, so the firmware can't stop it before its MOSFET overheats: add the spindle's current amplifier (catalog role current-sense, INA180A1IDBVR; its shunt goes under the MOSFET's source, @SPINDLE_SHUNT)`, fields: ["parts"], affects: ["parts"] })
		return out
	}
	const entry = ((cat.boardParts ?? []) as SenseEntry[]).find((x) => x.mpn === sense.mpn)
	const shunt = entry?.support?.find((x) => x.shuntOhm)?.shuntOhm
	if (entry && shunt) {
		const fullA = Math.round((3.3 / (entry.gainVV * shunt)) * 10) / 10
		if (fullA < m.input.amps) out.push({ kind: "cnc-wiring", message: `${sense.ref} ${sense.mpn} reads at most ${fullA} A (3.3 V / (${entry.gainVV} V/V × ${shunt * 1000} mOhm)), under the brick's ${m.input.amps} A: a stall would read as full scale, not its current; a lower gain or a smaller shunt`, fields: ["parts"], affects: ["parts"] })
	}
	if (!(values.pins ?? []).some((p) => p.partRef === sense.ref && p.partPin === "OUT")) out.push({ kind: "cnc-wiring", message: `${sense.ref}'s OUT (the spindle's current) is on no MCU pin: assign an ADC-capable GPIO with partRef ${sense.ref} and partPin OUT (signal SPINDLE_I)`, fields: ["pins"], affects: ["architect"] })
	return out
}
