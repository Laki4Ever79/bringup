// The arm's kinematics (src/arm/types.ts frame: origin at the base plate's top centre, +x forward, +y left, z up; mm).
// The base yaw turns the arm about z. The shoulder, elbow and wrist pitch bend it in its vertical plane, each angle
// relative to the link before it, 0 being stretched forward and level and positive raising it. The wrist roll turns the
// last link about its own axis, so it never moves the grip point. Links: the base yaw's linkMm is the shoulder axis's
// offset forward of the yaw axis, at shoulderZMm above the plate; each other joint's linkMm reaches the next joint's axis,
// and the wrist roll's reaches the fingertips' grip point.
import { ARM_JOINTS, type ArmJointName, type ArmSpec, type Xyz } from "./types.ts"

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI
const link = (arm: ArmSpec, n: ArmJointName) => arm.joints.find((j) => j.name === n)?.linkMm ?? 0

// The planar links: shoulder→elbow, elbow→wrist, wrist→grip point (the wrist pitch's and the wrist roll's together).
export function planarLinks(arm: ArmSpec): [number, number, number] {
	return [link(arm, "shoulder"), link(arm, "elbow"), link(arm, "wrist-pitch") + link(arm, "wrist-roll")]
}

// The reach the links give: from the shoulder axis to the grip point, stretched out.
export const armReachMm = (arm: ArmSpec) => planarLinks(arm).reduce((a, b) => a + b, 0)

// Each joint's position (ARM_JOINTS order) and the grip point, for angles in degrees (ARM_JOINTS order).
export function forward(arm: ArmSpec, degs: number[]): { joints: Xyz[]; tip: Xyz } {
	const [yaw, sh, el, wp] = degs.map(rad)
	const [l1, l2, l3] = planarLinks(arm)
	const off = link(arm, "base-yaw"), z0 = arm.base.shoulderZMm
	const a1 = sh, a2 = sh + el, a3 = sh + el + wp
	// In the arm's plane: r forward of the yaw axis, z up from the plate.
	const plane: [number, number][] = [
		[0, z0],
		[off, z0],
		[off + l1 * Math.cos(a1), z0 + l1 * Math.sin(a1)],
	]
	const wrist: [number, number] = [plane[2][0] + l2 * Math.cos(a2), plane[2][1] + l2 * Math.sin(a2)]
	const rollAt: [number, number] = [wrist[0] + link(arm, "wrist-pitch") * Math.cos(a3), wrist[1] + link(arm, "wrist-pitch") * Math.sin(a3)]
	const tip: [number, number] = [wrist[0] + l3 * Math.cos(a3), wrist[1] + l3 * Math.sin(a3)]
	const at = ([r, z]: [number, number]): Xyz => ({ xMm: r * Math.cos(yaw), yMm: r * Math.sin(yaw), zMm: z })
	return { joints: [plane[0], plane[1], plane[2], wrist, rollAt].map(at), tip: at(tip) }
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toString()
const where = (p: Xyz) => `(${fmt(p.xMm)}, ${fmt(p.yMm)}, ${fmt(p.zMm)})`

// The joint angles (degrees, ARM_JOINTS order) that put the grip point at `at`, the gripper pointing straight down when
// gripDown (otherwise the last link level). Within each joint's limits; when no pose reaches the point, the reason and how
// many millimetres short (0 when the point is in range but a joint limit stops it). Never NaN.
export function solve(arm: ArmSpec, at: Xyz, gripDown = true): number[] | { error: string; shortMm: number } {
	const [l1, l2, l3] = planarLinks(arm)
	const lim = (n: ArmJointName) => arm.joints.find((j) => j.name === n)!
	const within = (n: ArmJointName, d: number) => d >= lim(n).minDeg - 1e-6 && d <= lim(n).maxDeg + 1e-6
	const yaw = deg(Math.atan2(at.yMm, at.xMm))
	if (!within("base-yaw", yaw)) return { error: `the point ${where(at)} is ${fmt(yaw)}° round the base, outside its ${lim("base-yaw").minDeg}…${lim("base-yaw").maxDeg}°`, shortMm: 0 }
	const last = gripDown ? -90 : 0
	// The wrist axis, in the arm's plane relative to the shoulder axis.
	const r = Math.hypot(at.xMm, at.yMm) - link(arm, "base-yaw") - l3 * Math.cos(rad(last))
	const z = at.zMm - arm.base.shoulderZMm - l3 * Math.sin(rad(last))
	const d = Math.hypot(r, z)
	if (d > l1 + l2) return { error: `the point ${where(at)} is ${fmt(d - l1 - l2)} mm beyond the arm's reach${gripDown ? " with the gripper pointing down" : ""}`, shortMm: d - l1 - l2 }
	if (d < Math.abs(l1 - l2)) return { error: `the point ${where(at)} is ${fmt(Math.abs(l1 - l2) - d)} mm too close to the shoulder for the arm to fold to`, shortMm: Math.abs(l1 - l2) - d }
	const c2 = Math.max(-1, Math.min(1, (d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2)))
	const tried: string[] = []
	// Elbow up (bent down from a raised shoulder) first: it keeps the forearm above the table.
	for (const sign of [-1, 1]) {
		const el = sign * Math.acos(c2)
		const sh = Math.atan2(z, r) - Math.atan2(l2 * Math.sin(el), l1 + l2 * Math.cos(el))
		const pose = [yaw, deg(sh), deg(el), last - deg(sh) - deg(el), 0]
		const out = ARM_JOINTS.filter((n, i) => !within(n, pose[i]))
		if (!out.length) return pose
		tried.push(out.map((n) => `${n} ${fmt(pose[ARM_JOINTS.indexOf(n)])}° (limits ${lim(n).minDeg}…${lim(n).maxDeg}°)`).join(", "))
	}
	return { error: `the point ${where(at)} is in reach, but no pose keeps every joint in its limits: ${tried.join("; or ")}`, shortMm: 0 }
}
