// The arm's checks (plain code, no AI): each defect becomes a violation that wakes the mechanics agent. Torque per joint at
// the worst pose, reach to the pick and drop points with the gripper down, and tipping with the payload at full reach.
import type { ContractValues } from "../contract/types.ts"
import { byMpn, servoAt, type MechCatalog, type ServoPart } from "../mechanics/catalog.ts"
import type { CheckCatalog, MechViolation } from "../mechanics/checks.ts"
import { est, estNote } from "../mechanics/estimates.ts"
import { G } from "../mechanics/model.ts"
import { armReachMm, planarLinks, solve } from "./kinematics.ts"
import type { ArmJointName, ArmSpec, ArmTargets } from "./types.ts"

// The firmware comes down onto the pick and drop from this far above (templates/fw-arm, the scripted pick-and-place), so
// the points must be reachable with the gripper down there too, not just touched (a cup's rim clipped on the way in).
export const ARM_APPROACH_MM = 40
// How far inside the base plate's edge the whole arm's centre of mass must stay (mm).
export const TIP_MARGIN_MM = 10
const fmt = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString()

const servoOf = (cat: MechCatalog, mpn: string) => byMpn(cat.servos ?? [], mpn)

// A printed link's mass: the geometry tool's when it has run (arm.links), else the estimate per length.
function linkMass(arm: ArmSpec, n: ArmJointName | "gripper", lengthMm: number): { g: number; comMm: number; estimated: boolean } {
	const l = arm.links?.find((x) => x.name === n)
	if (l) return { g: l.massG, comMm: l.comMm[0], estimated: false }
	return n === "gripper" ? { g: est("armGripperG"), comMm: 0, estimated: true } : { g: (est("armLinkG") * lengthMm) / 100, comMm: lengthMm / 2, estimated: true }
}

// The masses the arm carries, as (grams, mm out from the shoulder axis along the stretched arm), and whether any is estimated.
function outboard(arm: ArmSpec, t: ArmTargets, cat: MechCatalog): { masses: { what: string; g: number; at: number }[]; estimated: boolean } {
	const [l1, l2] = planarLinks(arm)
	const wp = arm.joints.find((j) => j.name === "wrist-pitch")!.linkMm
	const wr = arm.joints.find((j) => j.name === "wrist-roll")!.linkMm
	const at = { shoulder: 0, elbow: l1, "wrist-pitch": l1 + l2, "wrist-roll": l1 + l2 + wp }
	const servoG = (mpn: string) => servoOf(cat, mpn)?.massG ?? 0
	const masses: { what: string; g: number; at: number }[] = []
	let estimated = false
	// Each servo sits at the joint it turns (its body at the axis, conservatively the joint itself).
	for (const n of ["elbow", "wrist-pitch", "wrist-roll"] as const) masses.push({ what: `${n} servo`, g: servoG(arm.joints.find((j) => j.name === n)!.servo), at: at[n] })
	masses.push({ what: "gripper servo", g: servoG(arm.gripper.servo), at: at["wrist-roll"] + wr / 2 })
	for (const [n, len] of [["shoulder", l1], ["elbow", l2], ["wrist-pitch", wp], ["wrist-roll", wr]] as const) {
		const m = linkMass(arm, n, len)
		estimated ||= m.estimated
		masses.push({ what: `${n} link`, g: m.g, at: at[n] + m.comMm })
	}
	const grip = linkMass(arm, "gripper", 0)
	estimated ||= grip.estimated
	masses.push({ what: "gripper", g: grip.g, at: l1 + l2 + wp + wr + grip.comMm })
	masses.push({ what: "payload", g: t.payloadG, at: l1 + l2 + wp + wr })
	return { masses, estimated }
}

// The static gravity torque on each joint with the arm stretched level at full reach and the payload in the gripper, and
// what the joint's servo may carry: ARM_TORQUE_SHARE of its stall torque at the rail. The base yaw and the wrist roll turn
// about axes gravity doesn't load in that pose (0).
export function worstTorques(arm: ArmSpec, t: ArmTargets, cat: MechCatalog): { joint: ArmJointName; nm: number; allowNm: number }[] {
	const { masses } = outboard(arm, t, cat)
	const [l1, l2] = planarLinks(arm)
	const axis: Partial<Record<ArmJointName, number>> = { shoulder: 0, elbow: l1, "wrist-pitch": l1 + l2 }
	return arm.joints.map((j) => {
		const s = servoOf(cat, j.servo)
		const at = s ? servoAt(s, arm.railV) : null
		const allowNm = at && !("error" in at) ? est("ARM_TORQUE_SHARE") * at.stallNm : 0
		const a = axis[j.name]
		const nm = a === undefined ? 0 : masses.filter((m) => m.at > a + 1e-9).reduce((sum, m) => sum + (m.g / 1000) * G * ((m.at - a) / 1000), 0)
		return { joint: j.name, nm, allowNm }
	})
}

// The strongest catalog servo of the same control type that the rail allows, and the weakest one that carries nm.
function strongerServo(cat: MechCatalog, control: ServoPart["control"], railV: number, nm: number): { fits?: ServoPart; strongest?: ServoPart } {
	const ok = (cat.servos ?? []).filter((s) => s.control === control).map((s) => ({ s, at: servoAt(s, railV) })).filter((x): x is { s: ServoPart; at: { stallNm: number; stallA: number; degPerS: number } } => !("error" in x.at))
	const allow = (x: { at: { stallNm: number } }) => est("ARM_TORQUE_SHARE") * x.at.stallNm
	const fits = ok.filter((x) => allow(x) >= nm).sort((a, b) => allow(a) - allow(b))[0]?.s
	const strongest = ok.sort((a, b) => allow(b) - allow(a))[0]?.s
	return { fits, strongest }
}

// The plate's own mass, solid PLA (an estimate: infill lowers it).
const plateG = (arm: ArmSpec) => (arm.base.plateMm[0] * arm.base.plateMm[1] * arm.base.thicknessMm * est("plaDensityGcm3")) / 1000

export function armChecks(values: Partial<ContractValues>, cat: CheckCatalog): MechViolation[] {
	const arm = values.arm, t = values.armTargets
	if (!arm) return []
	const out: MechViolation[] = []
	const push = (kind: MechViolation["kind"], message: string, affects: MechViolation["affects"] = ["mechanics"]) => out.push({ kind, message, fields: affects.includes("architect") ? ["arm", "armTargets"] : ["arm"], affects })
	// Every servo is in the catalog. (A servo off its rated voltage is the power checks' arm-supply, src/contract/power-auto.ts
	// armPowerChecks: not repeated here, and a joint whose servo the rail can't run gets no torque verdict.)
	const named = [...arm.joints.map((j) => ({ what: `the ${j.name} joint`, mpn: j.servo })), { what: "the gripper", mpn: arm.gripper.servo }]
	for (const { what, mpn } of named)
		if (!servoOf(cat.mech, mpn)) push("arm-torque", `${what}'s servo ${mpn} is not in catalog/mechanics.json servos (${(cat.mech.servos ?? []).map((x) => x.mpn).join(", ")})`)
	if (out.length || !t) return out

	// Torque.
	const { estimated } = outboard(arm, t, cat.mech)
	const note = estimated ? ` (links estimated: ${estNote("armLinkG")} per 100 mm, ${estNote("armGripperG")}; the arm geometry tool's link masses replace them)` : ""
	for (const w of worstTorques(arm, t, cat.mech)) {
		if (w.nm <= w.allowNm + 1e-9) continue
		const j = arm.joints.find((x) => x.name === w.joint)!
		const s = servoOf(cat.mech, j.servo)!
		if ("error" in servoAt(s, arm.railV)) continue
		const { fits, strongest } = strongerServo(cat.mech, s.control, arm.railV, w.nm)
		const fix = fits ? `the weakest catalog servo that carries it is ${fits.mpn}` : `no catalog servo carries it (the strongest, ${strongest?.mpn ?? "none"}, allows ${strongest ? fmt(est("ARM_TORQUE_SHARE") * (servoAt(strongest, arm.railV) as { stallNm: number }).stallNm) : "0"} N·m): shorten the reach or lighten the payload`
		push("arm-torque", `the ${w.joint} joint carries ${fmt(w.nm)} N·m with the arm stretched level at ${fmt(armReachMm(arm), 0)} mm and ${t.payloadG} g in the gripper, over the ${fmt(w.allowNm)} N·m its ${j.servo} may carry (${est("ARM_TORQUE_SHARE") * 100}% of its stall torque at ${arm.railV} V, ${estNote("ARM_TORQUE_SHARE")})${note}: ${fix}`, fits ? ["mechanics"] : ["mechanics", "architect"])
	}

	// Reach.
	const reach = armReachMm(arm)
	if (t.reachMm > reach + 0.5) push("arm-reach", `the links reach ${fmt(reach, 1)} mm from the shoulder axis to the grip point, short of the brief's ${t.reachMm} mm by ${fmt(t.reachMm - reach, 1)} mm`)
	for (const [name, p] of [["pick", t.pick], ["drop", t.drop]] as const) {
		const r = solve(arm, p)
		if (!Array.isArray(r)) {
			push("arm-reach", `the ${name} point: ${r.error}`)
			continue
		}
		const above = { ...p, zMm: p.zMm + ARM_APPROACH_MM }
		const a = solve(arm, above)
		if (!Array.isArray(a)) push("arm-reach", `the ${name} point's approach, ${ARM_APPROACH_MM} mm above it (the gripper comes down onto it from there): ${a.error}`)
	}

	// Tipping: the whole arm's centre of mass, the payload at full reach in 8 directions, inside the plate by TIP_MARGIN_MM.
	if (arm.base.holdDown === "clamps") return out
	const { masses } = outboard(arm, t, cat.mech)
	const off = arm.joints.find((j) => j.name === "base-yaw")!.linkMm
	const baseServo = servoOf(cat.mech, arm.joints[0].servo)?.massG ?? 0
	const shoulderServo = servoOf(cat.mech, arm.joints[1].servo)?.massG ?? 0
	const fixedG = plateG(arm) + arm.base.ballastG + baseServo + shoulderServo
	const armG = masses.reduce((s, m) => s + m.g, 0)
	const armMoment = masses.reduce((s, m) => s + m.g * (off + m.at), 0) + shoulderServo * off
	const [L, W] = arm.base.plateMm
	for (let k = 0; k < 8; k++) {
		const a = (k * Math.PI) / 4
		const r = armMoment / (fixedG + armG) // the centre's distance out from the yaw axis, along the arm
		const x = r * Math.cos(a), y = r * Math.sin(a)
		const room = Math.min(L / 2 - Math.abs(x), W / 2 - Math.abs(y))
		if (room < TIP_MARGIN_MM) {
			push("arm-tipping", `with ${t.payloadG} g at full reach toward ${Math.round((a * 180) / Math.PI)}°, the arm's centre of mass is ${fmt(r, 0)} mm out from the base axis, ${room < 0 ? `${fmt(-room, 0)} mm beyond` : `only ${fmt(room, 0)} mm inside`} the ${L} × ${W} mm plate's edge (it must stay ${TIP_MARGIN_MM} mm inside): grow the plate, add ballastG (base ${fmt(fixedG, 0)} g, plate ${estNote("plaDensityGcm3")}), or clamp it to the desk (holdDown "clamps")`)
			break
		}
	}
	return out
}
