// A CNC board's fixed wiring, decided in code (docs/cnc.md gap 2): the nets every CNC controller's parts take the same
// way, so an agent only picks the parts and the pins. Before this, the scripted design wrote each of them by hand, and
// leaving one out was silent or nearly: no 24 V on the jack, an e-stop that can never trip, a driver UART that never
// reads back, or a bare "connected to nothing" with no hint which net (gap 2 probe, 27 Nov 2026). Only a missing net is
// filled; one the agent wrote stays. Pure: the contract tools apply it on every CNC parts, pins, rails or cnc write.
//   - the brick's jack (DC-091-A250): VIN on the motors' rail (the rail at the brick's volts), its sleeve on GND;
//   - each stepper plug (4 pins A1 A2 B1 B2) on the next driver's outputs, motors in cncMotors' order (X, Y1, Y2, Z);
//   - the spindle's MOSFET (role mosfet, beside a spindle-driver): G on the gate, D on the spindle's minus lead, S on the
//     current shunt when the board senses the spindle's current, else on GND;
//   - the spindle's terminal (2 pins POS NEG): POS on the e-stop's switched rail (or the motor rail without one), NEG on
//     the MOSFET's drain;
//   - the e-stop's plug (role estop): LOOP on the e-stop switch's gate loop;
//   - the drivers' UART TX resistor (the part at the far end of STEPPER_UART_TX): its other pin on the line.
import type { ContractSnapshot, Part } from "../contract/types.ts"
import { cncMotors, motorSupplyRail, switchedRail } from "./board.ts"

const same = (pins: string[], want: string[]) => pins.length === want.length && want.every((p) => pins.includes(p))

export function withCncWiring(parts: Part[], s: ContractSnapshot): { parts: Part[]; note: string | null } {
	const ctx: ContractSnapshot = { ...s, values: { ...s.values, parts } }
	const motorRail = motorSupplyRail(ctx)
	const spindleRail = switchedRail(ctx) ? `@${switchedRail(ctx)}` : motorRail
	const sensed = parts.some((p) => p.role === "current-sense")
	const spindleSwitch = parts.some((p) => p.role === "spindle-driver")
	const motors = cncMotors(ctx)
	const plugLabel = (p: Part) => /^@(.+)_A1$/.exec(p.nets?.A1 ?? "")?.[1]
	const freeLabels = motors.map((m) => m.label).filter((l) => !parts.some((p) => plugLabel(p) === l))
	const txEnd = (ctx.values.pins ?? []).find((p) => p.signal === "STEPPER_UART_TX")
	const filled: string[] = []
	const out = parts.map((p) => {
		const want: Record<string, string> = {}
		if (p.mpn === "DC-091-A250" && motorRail) Object.assign(want, { VIN: motorRail, GND: "GND", GND_2: "GND", GND_3: "GND", GND_4: "GND" })
		else if (p.role === "connector" && same(p.pins, ["A1", "A2", "B1", "B2"]) && !plugLabel(p) && freeLabels.length) {
			const l = freeLabels.shift()!
			Object.assign(want, { A1: `@${l}_A1`, A2: `@${l}_A2`, B1: `@${l}_B1`, B2: `@${l}_B2` })
		} else if (p.role === "mosfet" && spindleSwitch)
			for (const pin of p.pins) want[pin] = /^G/.test(pin) ? "@SPINDLE_GATE" : /^D/.test(pin) ? "@SPINDLE_N" : sensed ? "@SPINDLE_SHUNT" : "GND"
		else if (p.role === "connector" && same(p.pins, ["POS", "NEG"]) && spindleSwitch && spindleRail) Object.assign(want, { POS: spindleRail, NEG: "@SPINDLE_N" })
		else if (p.role === "estop" && p.pins.includes("LOOP")) want.LOOP = "@ESTOP_LOOP"
		else if (txEnd && p.ref === txEnd.partRef && p.role === "resistor" && p.pins.length === 2) {
			const other = p.pins.find((x) => x !== txEnd.partPin)
			if (other) want[other] = "@STEPPER_UART"
		}
		const add = Object.fromEntries(Object.entries(want).filter(([pin]) => p.nets?.[pin] === undefined))
		if (!Object.keys(add).length) return p
		filled.push(`${p.ref} ${Object.entries(add).map(([pin, net]) => `${pin}→${net.replace(/^@/, "")}`).join(" ")}`)
		return { ...p, nets: { ...(p.nets ?? {}), ...add } }
	})
	return filled.length ? { parts: out, note: `the CNC's fixed wiring: ${filled.join("; ")}` } : { parts, note: null }
}
