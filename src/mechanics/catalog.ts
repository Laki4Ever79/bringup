import { readFileSync } from "node:fs"
import { join } from "node:path"

// Bought drive parts (catalog/mechanics.json). Every number a check uses carries its source: the datasheet or the
// seller's spec table, and where on it. Board parts (the motor driver, the distance sensor) stay in parts.json.

export type Cite = { url: string; where: string }
type Sourced = { mpn: string; source: Record<string, Cite> }

export interface MotorPart extends Sourced {
	ratedV: number
	noLoadRpm: number
	stallTorqueNm: number
	stallA: number
	noLoadA: number
	gearRatio: number
	bodyMm: [number, number, number]
	shaftMm: number
	massG: number
	// A quadrature encoder on the motor shaft (counts per motor revolution, both edges of both channels), its supply range
	// and its plug's pin order.
	encoder?: { cpr: number; minV: number; maxV: number; pullupOhm: number; connector: string; pins: string[] }
}
export interface WheelPart extends Sourced {
	diameterMm: number
	widthMm: number
	shaftMm: number
	massG: number
	tread: "rubber" | "plastic"
}
export interface CasterPart extends Sourced {
	wheelMm: number
	heightMm: number
	swivel: true
	holesMm: [number, number][]
	massG: number
}
export interface BatteryPack extends Sourced {
	cells: 1 | 2
	nominalV: number
	fullV: number
	cutoffV: number
	mAh: number
	maxContA: number
	peakA: number
	internalOhm?: number
	sizeMm: [number, number, number]
	massG: number
	notes?: string
}
// A bought step-down module (no board circuit): it feeds a computer such as a Raspberry Pi 5 from a 2S pack.
// The catalog's 6 V motors on a 2S pack (8.4 V full) exceed the mech-voltage check's 1.3x limit (7.8 V): a 2S robot
// needs a motor duty limit or 12 V motors.
export interface RegulatorPart extends Sourced {
	outV: number
	maxA: number
	inMinV: number
	inMaxV: number
	efficiency: number
	sizeMm: [number, number, number]
	massG: number
	notes?: string
}
// A distance sensor on a small breakout, mounted upright at the chassis front and cabled to the board: the VL53L0X
// looks out of the top of its package, so on a flat board it would see the ceiling.
export interface SensorModule extends Sourced {
	chip: string
	rangeMm: number
	fovDeg: number
	updateMs: number
	i2cAddress: number
	sizeMm: [number, number, number]
	massG: number
	connector: string
	// The breakout's mounting holes from its centre (along its width, along its height), and the screw they take.
	mountHolesMm?: [number, number][]
	mountScrewMm?: number
}
// A bought safety part (catalog safety): an emergency stop button standing through a panel, its contact rated for the
// motors' current (DC13, an inductive load) and voltage, with the minimum load it switches reliably.
export interface SafetyPart extends Sourced {
	kind: "estop"
	colour: string
	contacts: "NC" | "NO"
	headMm: number
	aboveMm: number
	belowMm: number
	bodyMm: number
	panelHoleMm: number
	panelMinMm: number
	panelMaxMm: number
	ratedDcV: number
	dcInductiveA: number
	dcResistiveA: number
	minLoadMa: number
	minLoadV: number
	massG: number
	notes?: string
}
export interface HardwarePart {
	mpn: string
	kind: "screw" | "nut" | "insert" | "bearing" | "rod" | "standoff"
	threadMm: number // the metric thread's nominal diameter (M2 → 2)
	lengthMm?: number
	pitchMm?: number
	heightMm?: number
	acrossFlatsMm?: number
	selfTapping?: boolean // cuts its own thread in a printed pilot hole
	buy?: { supplier: string; url: string; packQty?: number }[]
	source: Record<string, { url: string; where: string }>
}

// A bought motor mount (Pololu's micro metal gearmotor bracket): which motor body it fits, how far its mounting face is
// from the motor's axis, and its two holes (across the motor, holeFromGearboxFaceMm behind the gearbox's face).
export interface MotorMountPart extends Sourced {
	kind: "bracket"
	perPack: number
	fitsBodyMm: [number, number, number]
	axleFromFaceMm: number
	holeSpacingMm: number
	holeDiaMm: number
	holeFromGearboxFaceMm: number
	screws: string
	buy?: { supplier: string; url: string; packQty?: number }[]
}

// A bought cable: a STEMMA QT (JST SH 4-pin both ends) or a JST PH 2-pin plug with bare leads (a motor's).
export interface CablePart extends Sourced {
	kind: "stemma-qt" | "jst-ph-2-leads"
	lengthMm: number
	awg?: number
	buy?: { supplier: string; url: string; packQty?: number }[]
}

export interface MechCatalog {
	sensors: SensorModule[]
	motors: MotorPart[]
	wheels: WheelPart[]
	casters: CasterPart[]
	batteries: BatteryPack[]
	regulators?: RegulatorPart[]
	// Bought fasteners and the like (robot-parts.ts lists them, counted from the chassis): screws, nuts.
	hardware?: HardwarePart[]
	// Bought cables (chassis.ts robotCables).
	cables?: CablePart[]
	// Bought motor mounts (chassis.ts motorMount).
	motorMounts?: MotorMountPart[]
	// Emergency stop buttons and the like (safety.ts).
	safety?: SafetyPart[]
}

export function loadMechCatalog(root: string): MechCatalog {
	return JSON.parse(readFileSync(join(root, "catalog", "mechanics.json"), "utf8")) as MechCatalog
}

// A catalog part by its mpn. The catalog's mpns carry a description after the part number ("POLOLU-2366 75:1 MP 6V");
// an agent naturally writes the part number alone ("POLOLU-2366"), so that names the part too when it names exactly
// one (real rover run 2, 15 Nov: every lookup of a correct part failed, and the run spent its revisions on it).
export const byMpn = <T extends { mpn: string }>(list: T[], mpn: string): T | undefined => {
	const exact = list.find((p) => p.mpn === mpn)
	if (exact || typeof mpn !== "string" || !mpn.trim()) return exact
	const key = mpn.trim().toLowerCase()
	const hits = list.filter((p) => p.mpn.toLowerCase().split(/\s+/)[0] === key || p.mpn.toLowerCase().startsWith(key + " "))
	return hits.length === 1 ? hits[0] : undefined
}
