// The request mapper: a change request's sentence to field changes, in plain code, for the sentences it knows. ONE
// mapper: the scripted agents (src/inference/scripts.ts) propose what it returns, and the "what if" preview
// (src/dashboard/what-if.ts) shows the same thing before anything is sent. A sentence it doesn't know is null: the
// real agents handle it, and the preview says so instead of guessing.
import { resolve } from "node:path"
import type { Mechanics } from "../mechanics/types.ts"
import type { ArmSpec, ArmTargets } from "../arm/types.ts"
import { ARM_POINT_SHARE } from "../mechanics/brief.ts"
import type { Part } from "../contract/types.ts"
import { loadCatalog, type CatalogPart } from "../tools/parts-search.ts"
import { parseSwap } from "../tools/sourcing.ts"

export interface FieldChange<T> { value: T; reason: string }

// "N cm/mm narrower|wider": the plate's width and the track together, so the wheels keep their clearance.
// "set the turn scale to 1.01": a real robot's turn calibration (the build guide's "Teach it how it turns").
// "set the coast to 21.5 mm": the same calibration's coast, measured by the wheels after a straight stop.
export function mechanicsFromRequest(request: string, current: Mechanics): FieldChange<Mechanics> | null {
	const m = /(\d+(?:\.\d+)?)\s*(cm|mm)\s+(narrower|wider)/i.exec(request)
	if (m) {
		const d = Number(m[1]) * (m[2].toLowerCase() === "cm" ? 10 : 1) * (m[3].toLowerCase() === "narrower" ? -1 : 1)
		return { value: { ...current, drive: { ...current.drive, trackMm: current.drive.trackMm + d }, chassis: { ...current.chassis, plateMm: [current.chassis.plateMm[0], current.chassis.plateMm[1] + d] } }, reason: `engineer asked: ${request} (plate and track together, so the wheels keep clear)` }
	}
	const turn = /turn scale (?:to |of |= ?)?(\d+(?:\.\d+)?)/i.exec(request)
	if (turn) return { value: { ...current, drive: { ...current.drive, turnScale: Number(turn[1]) } }, reason: `engineer measured it: ${request} (the odometry's track times this; rover_odo.h RoverCal)` }
	// "set the coast to 21.5 mm": how far it rolls on after a stop, from a turn calibration (the go-to's first stop allows for it).
	const coast = /\bcoast (?:to |of |= ?)?(\d+(?:\.\d+)?)\s*mm\b/i.exec(request)
	if (coast) return { value: { ...current, drive: { ...current.drive, coastMm: Number(coast[1]) } }, reason: `engineer measured it: ${request} (the go-to stops that much early; rover_odo.h ROVER_COAST_MM)` }
	return null
}

let catalog: CatalogPart[] | null = null
const CATALOG = () => (catalog ??= loadCatalog(resolve(import.meta.dirname, "../..")))

// "swap U2 SHT40-AD1B-R2 for the SHTC3-TR-2.5KS (C194656) from the catalog": the catalog part takes the ref's place,
// same role only. null when the sentence isn't a swap; { error } when it is one this design can't take.
export function partsAfterSwap(request: string, parts: Part[], cat: CatalogPart[] = CATALOG()): (FieldChange<Part[]> & { part: Part }) | { error: string } | null {
	const swap = parseSwap(request)
	if (!swap) return null
	const old = parts.find((p) => p.ref === swap.ref)
	if (!old) return { error: `there is no ${swap.ref} on this board` }
	const to = cat.find((c) => c.role === old.role && c.mpn.toUpperCase() === swap.mpn.toUpperCase())
	if (!to) return { error: `${swap.mpn} isn't in the catalog as a ${old.role}` }
	if (old.mpn === to.mpn) return { error: `${old.ref} is already the ${to.mpn}` }
	const part = { ref: old.ref, role: old.role, mpn: to.mpn, lcsc: to.lcsc, footprint: to.footprint, pins: [...to.pins], reason: `The engineer swapped it in for the ${old.mpn}, from the catalog, in a change request.` } as Part
	return { part, value: parts.map((p) => (p.ref === old.ref ? part : p)), reason: `engineer swapped ${old.ref} ${old.mpn} for the ${to.mpn} from the catalog` }
}

// "make the reach 300 mm" (or "reach of 30 cm"): the arm's targets at the new reach, the pick and drop moved out with it
// exactly as the brief's reader places them (ARM_POINT_SHARE of the reach out, the same distance apart, same heights).
export function armTargetsFromRequest(request: string, current: ArmTargets): FieldChange<ArmTargets> | null {
	const m = /\breach\b[^.;\d]*?(\d+(?:\.\d+)?)\s*(cm|mm)\b/i.exec(request)
	if (!m) return null
	const reachMm = Number(m[1]) * (m[2].toLowerCase() === "cm" ? 10 : 1)
	if (reachMm === current.reachMm) return null
	const half = Math.hypot(current.drop.xMm - current.pick.xMm, current.drop.yMm - current.pick.yMm) / 2
	const r = ARM_POINT_SHARE * reachMm
	const x = Math.round(Math.sqrt(Math.max(0, r * r - half * half)) / 5) * 5
	return { value: { ...current, reachMm, pick: { ...current.pick, xMm: x }, drop: { ...current.drop, xMm: x } }, reason: `engineer asked: ${request} (the pick and drop move out with it, ${Math.round(ARM_POINT_SHARE * 100)} % of the reach, the same ${Math.round(half * 2)} mm apart)` }
}

// The arm's links long enough for its targets' reach: the shoulder and elbow links grow (or shrink) in proportion, in
// 5 mm steps, the wrist and the gripper as they are. null when they already reach exactly that far.
export function armLinksForReach(arm: ArmSpec, reachMm: number): ArmSpec | null {
	const sum = arm.joints.filter((j) => j.name !== "base-yaw").reduce((s, j) => s + j.linkMm, 0)
	if (sum === reachMm) return null
	const grow = ["shoulder", "elbow"]
	const base = arm.joints.filter((j) => grow.includes(j.name)).reduce((s, j) => s + j.linkMm, 0)
	const fixed = sum - base
	const scale = (reachMm - fixed) / base
	const joints = arm.joints.map((j) => (grow.includes(j.name) ? { ...j, linkMm: Math.round((j.linkMm * scale) / 5) * 5 } : j))
	// Rounding: the elbow takes up what's left, so the sum is the reach exactly.
	const now = joints.filter((j) => j.name !== "base-yaw").reduce((s, j) => s + j.linkMm, 0)
	const elbow = joints.find((j) => j.name === "elbow")!
	elbow.linkMm += reachMm - now
	return { ...arm, joints, links: undefined }
}
