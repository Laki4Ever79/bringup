// Where each of a CNC controller's firmware signals ends on the board (docs/cnc.md gap 2): the part and pin its MCU GPIO
// drives or reads, found by role, so a check asking for a missing signal says the whole pin entry, not "with its part's
// pin" (gap 2 pin probe, 27 Nov 2026: 7 of the 18 signals were asked for with no end named). Pure, types only: the
// checks import it (no codegen, no import cycle).
//   - ESTOP_TRIP on the enable gate's A (the e-stop's side of the OR; the MCU's STEPPERS_EN is B);
//   - LIMIT_X, LIMIT_Y, LIMIT_Z on the limit-switch plugs' SIG, in the parts' order;
//   - STEPPER_UART (the MCU's RX) on the first stepper driver's PDN_UART: every driver shares the one line;
//   - STEPPER_UART_TX on the TX resistor's pin1 (the 1 kΩ that joins TX onto the line, its pin2 on @STEPPER_UART);
//   - SPINDLE_PWM on the spindle driver's A; SPINDLE_I on the current amplifier's OUT;
//   - <MOTOR>_STEP and _DIR on that motor's driver (the drivers in the parts' order drive the motors in axis order, a
//     gantry's two in turn: board.ts cncMotors), STEPPERS_EN on the enable gate's B.
import type { ContractValues, Part } from "../contract/types.ts"
import { CNC_AXES } from "./types.ts"

// The drivers' single-wire UART takes TX through 1 kΩ (TMC2209 datasheet §4.4: the MCU's TX joins RX through a resistor).
export const TX_RESISTOR = { mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402" }

export type SignalEnd = { ref: string; pin: string } | { add: string }

// The motors' labels in the drivers' order (board.ts cncMotors' labels; that module reaches codegen, so not imported).
export const motorLabels = (cnc: ContractValues["cnc"]) =>
	CNC_AXES.flatMap((name) => {
		const a = cnc?.axes.find((x) => x.name === name)
		return a ? Array.from({ length: a.motors }, (_, k) => `${name.toUpperCase()}${a.motors > 1 ? k + 1 : ""}`) : []
	})

export function cncSignalEnd(signal: string, parts: Part[], cnc?: ContractValues["cnc"]): SignalEnd | null {
	const role = (r: string) => parts.filter((p) => p.role === r)
	const at = (p: Part | undefined, pin: string) => (p && p.pins.includes(pin) ? { ref: p.ref, pin } : null)
	const motor = /^(.+)_(STEP|DIR)$/.exec(signal)
	if (motor) return at(role("stepper-driver")[motorLabels(cnc).indexOf(motor[1])], motor[2])
	if (signal === "STEPPERS_EN") return at(role("enable-gate")[0], "B")
	if (signal === "ESTOP_TRIP") return at(role("enable-gate")[0], "A")
	const limit = /^LIMIT_([XYZ])$/.exec(signal)
	if (limit) return at(role("limit-switch")["XYZ".indexOf(limit[1])], "SIG")
	if (signal === "STEPPER_UART") return at(role("stepper-driver")[0], "PDN_UART")
	if (signal === "STEPPER_UART_TX") {
		const r = parts.find((p) => p.role === "resistor" && p.nets?.pin2 === "@STEPPER_UART")
		return r ? { ref: r.ref, pin: "pin1" } : role("stepper-driver").length ? { add: `a 1 kΩ resistor (${TX_RESISTOR.mpn}, LCSC ${TX_RESISTOR.lcsc}, ${TX_RESISTOR.footprint}, pins ["pin1", "pin2"], nets { "pin2": "@STEPPER_UART" }) from TX onto the drivers' line: add it to parts and end STEPPER_UART_TX on its pin1` } : null
	}
	if (signal === "SPINDLE_PWM") return at(role("spindle-driver")[0], "A")
	if (signal === "SPINDLE_I") return at(role("current-sense")[0], "OUT")
	return null
}

// "SIGNAL on partRef R partPin P" for each missing signal, or what to add first.
export function signalEndsText(missing: string[], parts: Part[], cnc?: ContractValues["cnc"]): string {
	return missing
		.map((s) => {
			const e = cncSignalEnd(s, parts, cnc)
			return !e ? s : "add" in e ? `${s} (${e.add})` : `${s} (partRef ${e.ref}, partPin ${e.pin})`
		})
		.join(", ")
}
