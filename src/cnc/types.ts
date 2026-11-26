import type { Mechanics } from "../mechanics/types.ts"

// A desktop CNC (docs/cnc.md, briefs/cnc.md): two contract fields, like the arm's. `cncTargets` holds the brief's
// targets (owned by the architect); `cnc` the axes, spindle, homing and supply that meet them (owned by the mechanics
// agent). A CNC design has no `mechanics` or `arm` field, so the rover's and the arm's checks stay out of it.
// Frame: origin at the work area's front-left corner on the bed's top, +x right, +y back, z up; millimetres.

export type CncAxisName = "x" | "y" | "z"
export const CNC_AXES: readonly CncAxisName[] = ["x", "y", "z"]

// travelMm: the work area (each axis's travel); footprintMm: the most the frame may take on the desk, [width, depth];
// rapidMmMin and feedMmMin: the fastest move and the cutting feed; cut: the design cut (one pass), which the axes' thrust
// and the spindle's power must meet; spindleW: the spindle's power, at most; repeatMm: positioning repeatability.
export interface CncTargets {
	travelMm: { x: number; y: number; z: number }
	footprintMm: [number, number]
	rapidMmMin: number
	feedMmMin: number
	cut: { material: string; depthMm: number; toolMm: number }
	spindleW: number
	repeatMm: number
}

// One axis: its motor (catalog/mechanics.json steppers mpn; motors: 2 for a gantry driven at both ends), lead screw
// (driveTrain mpn) and rails (rails mpn), the travel it gives, which end it homes at, and its driver's settings (the
// driver chip itself is a board part with role "stepper-driver"; uartAddr: its address on the drivers' UART, 0..3).
export interface CncAxis {
	name: CncAxisName
	motor: string
	motors: 1 | 2
	screw: string
	rail: string
	travelMm: number
	homeAt: "min" | "max"
	driver: { currentA: number; microsteps: number; uartAddr: number }
}

export interface CncSpec {
	// Exactly CNC_AXES, in that order.
	axes: CncAxis[]
	// The spindle (catalog spindles mpn), on the supply's volts, switched and speed-controlled by the board.
	spindle: { part: string; volts: number; watts: number }
	// The emergency stop (catalog safety mpn), cutting the motors' and the spindle's supply in hardware.
	estop: string
	// The machine's power input: a mains DC brick.
	input: { kind: "dc-brick"; volts: number; amps: number }
	// The frame on the desk: [width, depth] and height, mm.
	frame: { footprintMm: [number, number]; heightMm: number }
	// The controller's board(s) and where they sit on the frame.
	boards: Mechanics["chassis"]["boards"]
	// The motion firmware the board's pin map configures.
	firmware: "fluidnc" | "grblhal"
}
