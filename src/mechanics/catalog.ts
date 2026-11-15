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
}
export interface MechCatalog {
	sensors: SensorModule[]
	motors: MotorPart[]
	wheels: WheelPart[]
	casters: CasterPart[]
	batteries: BatteryPack[]
	regulators?: RegulatorPart[]
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
