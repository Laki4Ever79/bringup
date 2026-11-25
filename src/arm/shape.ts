import { ARM_JOINTS } from "./types.ts"

// The shapes the contract accepts for armTargets and arm (contract.ts shapeError): what an agent must write.
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown, min = -Infinity) => typeof v === "number" && Number.isFinite(v) && v >= min
const pos = (v: unknown) => num(v) && (v as number) > 0
const xyz = (v: unknown) => obj(v) && num(v.xMm) && num(v.yMm) && num(v.zMm)
const channel = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 15

export const ARM_TARGETS_SHAPE =
	"armTargets must be {reachMm > 0 (shoulder axis to the fingertips' grip point), payloadG ≥ 0 (the design load at full reach), pick: {xMm, yMm, zMm}, drop: {xMm, yMm, zMm} (mm from the base plate's top centre, +x forward, +y left, z up), repeats ≥ 1, objectG ≥ 0 (the demo object)}"

export function armTargetsShapeError(v: unknown): string | null {
	if (!obj(v)) return ARM_TARGETS_SHAPE
	const ok = pos(v.reachMm) && num(v.payloadG, 0) && xyz(v.pick) && xyz(v.drop) && Number.isInteger(v.repeats) && (v.repeats as number) >= 1 && num(v.objectG, 0)
	return ok ? null : ARM_TARGETS_SHAPE
}

export const ARM_SHAPE = `arm must be {base: {plateMm: [length, width], thicknessMm, shoulderZMm (the shoulder axis above the plate's top), holdDown: "mass"|"clamps", ballastG ≥ 0}, joints: exactly ${ARM_JOINTS.length} in this order: ${ARM_JOINTS.join(", ")}, each {name, servo (catalog/mechanics.json servos mpn), channel (servo driver output 0..15), linkMm (to the next joint's axis; wrist-roll: to the fingertips' grip point), minDeg < maxDeg (0 = stretched forward and level)}, gripper: {servo, channel, openMm, fingerMm}, railV (the servos' rail, V), input: {kind: "dc-brick", volts, amps}, boards: [{name, at: {xMm, yMm}, rotDeg: 0|90|180|270}], links? (written by the arm geometry tool)} (mm; origin at the base plate's top centre, +x forward)`

export function armShapeError(v: unknown): string | null {
	if (!obj(v) || !obj(v.base) || !Array.isArray(v.joints) || !obj(v.gripper) || !obj(v.input) || !Array.isArray(v.boards)) return ARM_SHAPE
	const b = v.base
	const baseOk = Array.isArray(b.plateMm) && b.plateMm.length === 2 && b.plateMm.every(pos) && pos(b.thicknessMm) && num(b.shoulderZMm, 0) && ["mass", "clamps"].includes(b.holdDown as string) && num(b.ballastG, 0)
	if (!baseOk) return `${ARM_SHAPE}; its base is wrong`
	const names = v.joints.map((j) => (obj(j) ? j.name : undefined))
	const missing = ARM_JOINTS.filter((n) => !names.includes(n))
	if (missing.length) return `${ARM_SHAPE}; it has no ${missing.join(", ")} joint`
	if (names.length !== ARM_JOINTS.length || names.some((n, i) => n !== ARM_JOINTS[i])) return `${ARM_SHAPE}; its joints are ${names.join(", ")}`
	for (const j of v.joints as Record<string, unknown>[]) {
		const ok = typeof j.servo === "string" && j.servo !== "" && channel(j.channel) && num(j.linkMm, 0) && num(j.minDeg) && num(j.maxDeg) && (j.minDeg as number) < (j.maxDeg as number)
		if (!ok) return `${ARM_SHAPE}; joint ${j.name} is wrong`
	}
	const g = v.gripper
	if (!(typeof g.servo === "string" && g.servo !== "" && channel(g.channel) && pos(g.openMm) && pos(g.fingerMm))) return `${ARM_SHAPE}; its gripper is wrong`
	const chans = [...(v.joints as Record<string, unknown>[]).map((j) => j.channel), g.channel]
	if (new Set(chans).size !== chans.length) return `${ARM_SHAPE}; two servos share a channel (${chans.join(", ")})`
	if (!pos(v.railV)) return `${ARM_SHAPE}; railV must be > 0`
	const i = v.input
	if (!(i.kind === "dc-brick" && pos(i.volts) && pos(i.amps))) return `${ARM_SHAPE}; its input is wrong`
	const at = (p: unknown) => obj(p) && num(p.xMm) && num(p.yMm)
	if (!v.boards.every((x) => obj(x) && typeof x.name === "string" && at(x.at) && [0, 90, 180, 270].includes(x.rotDeg as number))) return `${ARM_SHAPE}; its boards are wrong`
	if (v.links !== undefined) {
		const ok = Array.isArray(v.links) && v.links.every((l) => obj(l) && ([...ARM_JOINTS, "gripper"] as unknown[]).includes(l.name) && num(l.massG, 0) && Array.isArray(l.comMm) && l.comMm.length === 3 && l.comMm.every((x) => num(x)))
		if (!ok) return `${ARM_SHAPE}; links must be [{name (a joint or "gripper"), massG, comMm: [x, y, z]}]`
	}
	return null
}
