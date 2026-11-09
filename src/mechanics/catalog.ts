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
	cells: 1
	nominalV: number
	fullV: number
	cutoffV: number
	mAh: number
	maxContA: number
	peakA: number
	internalOhm?: number
	sizeMm: [number, number, number]
	massG: number
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
}

export function loadMechCatalog(root: string): MechCatalog {
	return JSON.parse(readFileSync(join(root, "catalog", "mechanics.json"), "utf8")) as MechCatalog
}

export const byMpn = <T extends { mpn: string }>(list: T[], mpn: string): T | undefined => list.find((p) => p.mpn === mpn)
