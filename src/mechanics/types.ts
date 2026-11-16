// The two mechanics fields of the design contract. `motion` holds the brief's targets (owned by the architect);
// `mechanics` the drive, battery and chassis layout (owned by the mechanics agent). Chassis frame: origin at the plate
// centre, +x forward, +y left, z up from the floor; millimetres throughout.
import type { DriveTrainPart } from "./drivetrain.ts"

export interface MotionTargets {
	speedMps: number
	runtimeMin: number
	edgeMm: number
	maxSlopeDeg: number
	stopBeforeWallMm: number
	payloadG: number
	maxSizeMm: [number, number]
	maxMassG: number
}

export interface Mount {
	what: string
	xMm: number
	yMm: number
	zMm: number
	sizeMm: [number, number, number]
	massG: number
}

export interface Mechanics {
	// axleXMm: where the wheel axle crosses the plate's long axis; the caster sits wheelbaseMm behind it.
	drive: { kind: "differential"; motor: string; wheel: string; caster: string; trackMm: number; wheelbaseMm: number; axleXMm: number }
	battery: { pack: string; at: { xMm: number; yMm: number } }
	// The front distance sensor's breakout (catalog sensors), standing at `at` facing +x, cabled to the board connector
	// `connector` (role connector, its IO1/IO2 on I2C_SDA/I2C_SCL and VCC on 3V3).
	sensor: { module: string; at: { xMm: number; yMm: number; zMm: number }; connector: string }
	chassis: {
		plateMm: [number, number]
		thicknessMm: number
		material: "PLA"
		clearanceMm: number
		// on: the board this one sits on as a HAT (a compute module's carrier); holes: its mounting holes when they aren't
		// at the corners (a bought board's record: mm from its lower-left corner, before the turn).
		boards: { name: string; at: { xMm: number; yMm: number }; rotDeg: 0 | 90 | 180 | 270; on?: string; holes?: { x: number; y: number; dia: number | null }[]; module?: string }[]
	}
	// Bought gears, belts, chains, bearings, shafts, couplers and lead screws, each naming what it mates with
	// (drivetrain.ts); none on today's direct-drive rover.
	driveTrain?: DriveTrainPart[]
	// Safety parts (safety.ts): an emergency stop button (catalog safety, kind "estop") standing through a panel whose top
	// is at.zMm off the floor, its NC contact wired to the board plug `connector` (role estop) in the motors' supply.
	// And a pull-cord start (match.h in the rover firmware): the board plug `connector` (role start) whose START pin the
	// cord's loop holds low; the cord is cordMm long; with matchS the firmware stops every motor that long after the start.
	safety?: { estop?: { part: string; at: { xMm: number; yMm: number; zMm: number }; connector: string }; start?: { connector: string; cordMm: number; matchS?: number } }
}
