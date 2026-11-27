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
	// A competition's robot rules the design is checked against (catalog/rules/<id>.json: "eurobot-2026").
	rules?: string
	// The drive the brief asks for: "skid4" when it says four-wheel drive, 4WD, skid steer or a rough floor; otherwise
	// a differential rover with a caster.
	drive?: "skid4"
	// Wheel encoders the brief asks for (odometry): the drive must be an encoder gearmotor on 6-pin plugs.
	encoders?: true
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
	// maxAccelMps2: the firmware ramps the duty so the speed changes no faster (a tall robot's stops and starts, e.g. one
	// carrying a beacon); without it the wheels brake and start as hard as the floor lets them.
	// differential: two driven wheels on one axle at axleXMm and a caster wheelbaseMm behind it. skid4: four driven wheels,
	// the front axle at axleXMm and the rear one wheelbaseMm behind it, each side's two motors driven together; no caster
	// (caster ""). It turns by skidding, so its wheelbase must be shorter than its track (model.ts skidTurn).
	drive: { kind: "differential" | "skid4"; motor: string; wheel: string; caster: string; trackMm: number; wheelbaseMm: number; axleXMm: number; maxAccelMps2?: number; turnScale?: number; coastMm?: number }
	// enclosure "fireproof-bag": the pack is kept permanently in a certified fireproof bag (Eurobot F.4.b, for a lithium pack
	// that is neither LiFePO4 nor a manufacturer's cased battery with its BMS; the charger goes to homologation).
	battery: { pack: string; at: { xMm: number; yMm: number }; enclosure?: "fireproof-bag" }
	// The front distance sensor's breakout (catalog sensors), standing at `at` facing +x, cabled to the board connector
	// `connector` (role connector, its IO1/IO2 on I2C_SDA/I2C_SCL and VCC on 3V3).
	sensor: { module: string; at: { xMm: number; yMm: number; zMm: number }; connector: string }
	chassis: {
		plateMm: [number, number]
		thicknessMm: number
		material: "PLA"
		clearanceMm: number
		// A mounting grid on the plate: M3 clearance holes on this pitch wherever nothing stands (py/chassis.py grid_holes),
		// for a team's own mechanism (the Eurobot brief's nice-to-have). None when absent.
		gridMm?: number
		// on: the board this one sits on as a HAT (a compute module's carrier); holes: its mounting holes when they aren't
		// at the corners (a bought board's record: mm from its lower-left corner, before the turn).
		boards: { name: string; at: { xMm: number; yMm: number }; rotDeg: 0 | 90 | 180 | 270; on?: string; holes?: { x: number; y: number; dia: number | null }[]; module?: string }[]
	}
	// Bought gears, belts, chains, bearings, shafts, couplers and lead screws, each naming what it mates with
	// (drivetrain.ts); none on today's direct-drive rover.
	driveTrain?: DriveTrainPart[]
	// A competition's beacon support (Eurobot General Rules 1.2 F.6): a printed mast from the plate, sizeMm square (wall
	// mastWallMm), whose flat top stands topMm off the floor and carries loadG (the opponent's beacon and its tag).
	beacon?: { at: { xMm: number; yMm: number }; topMm: number; sizeMm: number; mastWallMm: number; loadG: number }
	// A flat printed panel at the plate's edge for a competition's sticker (Eurobot F.6: 100 × 70 mm left free on a side
	// face): on `face`, centred along it, widthMm along the edge and heightMm up from the plate's top.
	sticker?: { face: "front" | "rear" | "left" | "right"; widthMm: number; heightMm: number }
	// Safety parts (safety.ts): an emergency stop button (catalog safety, kind "estop") standing through a panel whose top
	// is at.zMm off the floor, its NC contact wired to the board plug `connector` (role estop) in the motors' supply.
	// And a pull-cord start (match.h in the rover firmware): the board plug `connector` (role start) whose START pin the
	// cord's loop holds low; the cord is cordMm long; with matchS the firmware stops every motor that long after the start.
	safety?: { estop?: { part: string; at: { xMm: number; yMm: number; zMm: number }; connector: string; collarMm?: number }; start?: { connector: string; cordMm: number; matchS?: number } }
}
