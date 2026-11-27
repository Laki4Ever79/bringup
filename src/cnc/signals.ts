// A CNC controller's signals, by the scripted design's names (src/inference/scripts.ts CNC_DESIGN): the drivers' STEP and
// DIR per motor (X, Y1, Y2 the ganged second Y motor = grblHAL's M3, Z), one shared enable, the limits, the spindle's PWM,
// the e-stop's trip (grblHAL's RESET input, FluidNC's estop_pin) and the drivers' UART.
export const CNC_SIGNALS = ["X_STEP", "X_DIR", "Y1_STEP", "Y1_DIR", "Y2_STEP", "Y2_DIR", "Z_STEP", "Z_DIR", "STEPPERS_EN", "LIMIT_X", "LIMIT_Y", "LIMIT_Z", "SPINDLE_PWM", "ESTOP_TRIP", "STEPPER_UART", "STEPPER_UART_TX"] as const
// Its own module, importing nothing: checks.ts imports fluidnc.ts, which imports grblhal.ts, which imports checks.ts, so
// a list declared in grblhal.ts was read before it was set when grblhal.ts loaded first (firmware-log.test.ts, 27 Nov).
