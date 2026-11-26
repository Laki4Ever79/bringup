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
	internalOhmEstimate?: boolean // no datasheet states it: the value is reasoned, and reports say so
	sizeMm: [number, number, number]
	massG: number
	// Lithium chemistry, whether the pack carries its maker's protection circuit (BMS), and whether it is a manufacturer's
	// cased battery product (a power-tool, laptop or USB power-bank battery): Eurobot's F.4.b exempts LiFePO4 and a
	// maker's BMS in its own solid case; any other lithium pack lives in a certified fireproof bag with a homologated charger.
	chemistry?: "LiPo" | "Li-ion" | "LiFePO4" | "NiMH"
	bms?: boolean
	manufacturerCase?: boolean
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
	// The motor cross-section it clamps (width, height): any length (a longer gearbox, an encoder on the back).
	fitsCrossSectionMm: [number, number]
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

// A bought servo (an arm's joints): a hobby PWM servo or a serial bus servo. Torque, current and speed per supply voltage,
// as the datasheet lists them (ascending v); servoAt reads them at the arm's rail. estimates: the keys no primary source
// gives (the hobby servos' ear holes, a stall current sellers disagree on): reports say so.
// A mains power brick (an arm's DC input, ArmSpec.input): its output and plug; the arm's board takes the plug.
export interface PowerBrickPart extends Sourced {
	mpn: string
	volts: number
	amps: number
	plug: string
	// [outer, inner] diameter of the barrel plug, mm: it must match the board's jack (its catalog plugMm).
	plugMm: [number, number]
	// The output's tolerance, %, set-up, line and load together (the maker's datasheet); unknown when the maker doesn't
	// publish it. brickMaxV is what the board's input must stand.
	tolerancePct?: number
	mains: string
	buy?: { supplier: string; url: string; packQty?: number }[]
}

export interface ServoPart extends Sourced {
	control: "pwm" | "ttl-bus"
	minV: number
	maxV: number
	stallNm: { v: number; nm: number }[]
	stallA: { v: number; a: number }[]
	secPer60: { v: number; s: number }[] // no-load speed
	rangeDeg: number
	pulseUs?: [number, number] // pwm: the pulse for 0 and rangeDeg
	massG: number
	bodyMm: [number, number, number]
	earsMm: number // over the mounting ears (a bus servo with none: its body length)
	holesMm: [number, number][] // mounting holes from the output shaft's axis, along the body and across it
	holeDiaMm: number
	spline: string // "25T" etc.
	estimates?: string[]
	buy?: { supplier: string; url: string; packQty?: number }[]
}

// A list of {v, value} points read at v: linear between the listed voltages, the nearest end beyond them.
function atV<T extends { v: number }>(pts: T[], v: number, get: (p: T) => number): number {
	const s = [...pts].sort((a, b) => a.v - b.v)
	if (v <= s[0].v) return get(s[0])
	for (let i = 1; i < s.length; i++)
		if (v <= s[i].v) return get(s[i - 1]) + ((get(s[i]) - get(s[i - 1])) * (v - s[i - 1].v)) / (s[i].v - s[i - 1].v)
	return get(s[s.length - 1])
}

// The servo at its supply voltage: stall torque (N·m), stall current (A) and no-load speed (deg/s). Outside the servo's
// rated range it refuses (an SG90 on a 7.4 V rail burns out), naming the servo and its range.
export function servoAt(p: ServoPart, v: number): { stallNm: number; stallA: number; degPerS: number } | { error: string } {
	if (!(v >= p.minV - 1e-9 && v <= p.maxV + 1e-9)) return { error: `${p.mpn} is rated ${p.minV}–${p.maxV} V, not ${v} V` }
	return { stallNm: atV(p.stallNm, v, (x) => x.nm), stallA: atV(p.stallA, v, (x) => x.a), degPerS: 60 / atV(p.secPer60, v, (x) => x.s) }
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
	// Bought drive-train parts (drivetrain.ts): pulleys, belts and the like, each number sourced; a design's
	// mechanics.driveTrain names them by mpn and copies their numbers.
	driveTrain?: (Sourced & { kind: string; [k: string]: unknown })[]
	// Bought cables (chassis.ts robotCables).
	cables?: CablePart[]
	// Bought motor mounts (chassis.ts motorMount).
	motorMounts?: MotorMountPart[]
	// Emergency stop buttons and the like (safety.ts).
	safety?: SafetyPart[]
	// Servos for an arm's joints (src/arm).
	servos?: ServoPart[]
	powerBricks?: PowerBrickPart[]
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

// The most a brick can put out: nominal × (1 + tolerance). Unknown tolerance: null, never a guess.
export const brickMaxV = (b: { volts: number; tolerancePct?: number }): number | null => (b.tolerancePct === undefined ? null : Math.round(b.volts * (1 + b.tolerancePct / 100) * 1000) / 1000)
