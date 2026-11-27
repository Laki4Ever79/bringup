import type { ContractValues } from "../contract/types.ts"
import { CNC_AXES } from "./types.ts"

// A CNC controller's signals, by the scripted design's names (src/inference/scripts.ts CNC_DESIGN): the drivers' STEP and
// DIR per motor (X, Y1, Y2 the ganged second Y motor = grblHAL's M3, Z), one shared enable, the limits, the spindle's PWM,
// the e-stop's trip (grblHAL's RESET input, FluidNC's estop_pin) and the drivers' UART.
export const CNC_SIGNALS = ["X_STEP", "X_DIR", "Y1_STEP", "Y1_DIR", "Y2_STEP", "Y2_DIR", "Z_STEP", "Z_DIR", "STEPPERS_EN", "LIMIT_X", "LIMIT_Y", "LIMIT_Z", "SPINDLE_PWM", "ESTOP_TRIP", "STEPPER_UART", "STEPPER_UART_TX"] as const
const SHARED = ["STEPPERS_EN", "LIMIT_X", "LIMIT_Y", "LIMIT_Z", "SPINDLE_PWM", "ESTOP_TRIP", "STEPPER_UART", "STEPPER_UART_TX"]

// The motors' labels in the drivers' order: X, Y, Z, a ganged axis's motors numbered (Y1, Y2) (board.ts cncMotors' labels;
// that module reaches codegen, so it isn't imported here).
export const motorLabels = (cnc: ContractValues["cnc"] | undefined) =>
	CNC_AXES.flatMap((name) => {
		const a = cnc?.axes.find((x) => x.name === name)
		return a ? Array.from({ length: a.motors }, (_, k) => `${name.toUpperCase()}${a.motors > 1 ? k + 1 : ""}`) : []
	})

// The signals this machine's firmware needs: STEP and DIR per motor of the machine, not the scripted design's four (the
// first real CNC run, 27 Nov 2026: one Y motor, Y_STEP and Y_DIR in pins, and the checks asked for Y1 and Y2 to the end).
// Without a machine yet, the scripted design's list.
export const cncSignals = (cnc: ContractValues["cnc"] | undefined): string[] =>
	cnc ? [...motorLabels(cnc).flatMap((l) => [`${l}_STEP`, `${l}_DIR`]), ...SHARED] : [...CNC_SIGNALS]
// Its own module, importing only types and the axis names: checks.ts imports fluidnc.ts, which imports grblhal.ts, which imports checks.ts, so
// a list declared in grblhal.ts was read before it was set when grblhal.ts loaded first (firmware-log.test.ts, 27 Nov).
