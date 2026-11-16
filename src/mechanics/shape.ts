import { RULE_SETS } from "../rules/eurobot.ts"
import { DRIVE_TRAIN_SHAPE, driveTrainShapeError } from "./drivetrain.ts"

// The shapes the contract accepts for motion and mechanics (contract.ts shapeError): what an agent must write.
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown, min = 0) => typeof v === "number" && Number.isFinite(v) && v >= min
const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((x) => num(x, 1))

export function motionShapeError(v: unknown): string | null {
	const shape = "motion must be {speedMps > 0, runtimeMin > 0, edgeMm ≥ 0, maxSlopeDeg ≥ 0, stopBeforeWallMm ≥ 0, payloadG ≥ 0, maxSizeMm: [length, width], maxMassG > 0, rules?: eurobot-2026 (only when the brief is for that competition)}"
	if (!obj(v)) return shape
	const ok = num(v.speedMps) && (v.speedMps as number) > 0 && num(v.runtimeMin) && (v.runtimeMin as number) > 0 && num(v.edgeMm) && num(v.maxSlopeDeg) && num(v.stopBeforeWallMm) && num(v.payloadG) && pair(v.maxSizeMm) && num(v.maxMassG) && (v.maxMassG as number) > 0
	if (!ok) return shape
	if (v.rules !== undefined && !(RULE_SETS as readonly unknown[]).includes(v.rules)) return `motion.rules is one of: ${RULE_SETS.join(", ")} (a competition's robot rules), or left out`
	return null
}

// The shape, for the mechanics engineer's instruction (agents/roles.ts) as well as the error.

export const MECHANICS_SHAPE =
	'mechanics must be {drive: {kind: "differential", motor, wheel, caster (catalog/mechanics.json mpns), trackMm, wheelbaseMm, axleXMm}, battery: {pack (mpn), at: {xMm, yMm}}, sensor: {module (catalog sensors mpn), at: {xMm, yMm, zMm}, connector (board connector ref)}, chassis: {plateMm: [length, width], thicknessMm, material: "PLA", clearanceMm, boards: [{name, at: {xMm, yMm}, rotDeg: 0|90|180|270}]}, safety?: {estop?: {part (catalog safety mpn), at: {xMm, yMm, zMm (the top of the panel it stands through)}, connector (board plug ref, role estop)}, start?: {connector (board plug ref, role start), cordMm, matchS?}}, driveTrain?} (mm; origin at the plate centre, +x forward). ' + DRIVE_TRAIN_SHAPE
export function mechanicsShapeError(v: unknown): string | null {
	const shape = MECHANICS_SHAPE
	if (!obj(v) || !obj(v.drive) || !obj(v.battery) || !obj(v.chassis) || !obj(v.sensor)) return shape
	const d = v.drive, b = v.battery, c = v.chassis, s = v.sensor
	const at = (p: unknown) => obj(p) && typeof p.xMm === "number" && typeof p.yMm === "number"
	const ok =
		d.kind === "differential" && [d.motor, d.wheel, d.caster].every((x) => typeof x === "string" && x) && num(d.trackMm, 1) && num(d.wheelbaseMm, 1) && typeof d.axleXMm === "number" &&
		typeof b.pack === "string" && at(b.at) &&
		typeof s.module === "string" && at(s.at) && typeof (s.at as Record<string, unknown>).zMm === "number" && typeof s.connector === "string" &&
		pair(c.plateMm) && num(c.thicknessMm, 0.5) && c.material === "PLA" && num(c.clearanceMm) &&
		Array.isArray(c.boards) && c.boards.every((x) => obj(x) && typeof x.name === "string" && at(x.at) && [0, 90, 180, 270].includes(x.rotDeg as number))
	if (!ok) return shape
	if (d.maxAccelMps2 !== undefined && !(num(d.maxAccelMps2) && (d.maxAccelMps2 as number) > 0)) return "mechanics.drive.maxAccelMps2, when set, is the firmware's acceleration limit in m/s² (> 0)"
	if (v.beacon !== undefined) {
		const b = v.beacon
		if (!obj(b) || !at(b.at) || !num(b.topMm, 1) || !num(b.sizeMm, 1) || !num(b.mastWallMm, 0.4) || !num(b.loadG)) return "mechanics.beacon must be {at: {xMm, yMm}, topMm (its flat top off the floor), sizeMm (the mast's square side), mastWallMm, loadG (what its top carries)}"
	}
	if (v.sticker !== undefined) {
		const k = v.sticker
		if (!obj(k) || !["front", "rear", "left", "right"].includes(k.face as string) || !num(k.widthMm, 1) || !num(k.heightMm, 1)) return "mechanics.sticker must be {face: front|rear|left|right, widthMm, heightMm} (a flat panel at that edge of the plate)"
	}
	if (v.safety !== undefined) {
		const e = obj(v.safety) ? v.safety.estop : null
		const estopOk = e === undefined || (obj(e) && typeof e.part === "string" && e.part !== "" && at(e.at) && typeof (e.at as Record<string, unknown>).zMm === "number" && typeof e.connector === "string" && e.connector !== "" && (e.collarMm === undefined || num(e.collarMm)))
		const st = obj(v.safety) ? v.safety.start : null
		const startOk = st === undefined || (obj(st) && typeof st.connector === "string" && st.connector !== "" && num(st.cordMm, 1) && (st.matchS === undefined || num(st.matchS, 1)))
		if (!obj(v.safety) || !estopOk || !startOk) return 'mechanics.safety must be {estop?: {part (catalog safety mpn), at: {xMm, yMm, zMm (the top of the panel it stands through, off the floor)}, connector (the board plug ref, role estop), collarMm? (a printed ring around the button on its deck, mm above the deck)}, start?: {connector (the board plug ref, role start), cordMm, matchS? (seconds the robot drives after the cord is pulled)}}'
	}
	return driveTrainShapeError(v.driveTrain)
}
