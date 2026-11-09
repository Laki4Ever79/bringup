// The two mechanics fields of the design contract. `motion` holds the brief's targets (owned by the architect);
// `mechanics` the drive, battery and chassis layout (owned by the mechanics agent). Chassis frame: origin at the plate
// centre, +x forward, +y left, z up from the floor; millimetres throughout.

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
		boards: { name: string; at: { xMm: number; yMm: number }; rotDeg: 0 | 90 | 180 | 270 }[]
	}
}
