import { execFile } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ContractSnapshot } from "../contract/types.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { byMpn } from "../mechanics/catalog.ts"
import { est } from "../mechanics/estimates.ts"
import { massAndCom, mounts } from "../mechanics/model.ts"

const exec = promisify(execFile)

// What py/chassis.py builds from (chassis frame: origin at the plate centre, +x forward, mm), plus the mass, centre of
// mass and drive numbers the simulation (py/mech/model.py) reads from the same file.
export interface ChassisSpec {
	// Boards the chassis places whose outline this run doesn't know (another board of a multi-board robot): left off the
	// plate and out of the mass, and named, never drawn at the main board's size.
	unplaced: string[]
	plate: { lengthMm: number; widthMm: number; thicknessMm: number; clearanceMm: number }
	standoffMm: number
	// axleDropMm: the axle's depth under the plate's underside (the caster sets the plate's height; the motor's bracket drops to the axle).
	motors: { side: "left" | "right"; xMm: number; yMm: number; bodyMm: [number, number, number]; axleDropMm: number }[]
	caster: { xMm: number; holesMm: [number, number][]; holeDiaMm: number; wheelMm: number; heightMm: number }
	battery: { xMm: number; yMm: number; sizeMm: [number, number, number] }
	boards: { name: string; xMm: number; yMm: number; widthMm: number; heightMm: number; rotDeg: number; holeInsetMm: number }[]
	sensor: { xMm: number; yMm: number; zMm: number; sizeMm: [number, number, number]; rangeMm: number; updateMs: number }
	massG: number
	com: [number, number, number] // the whole rover's, wheels and caster included
	wheelMassG: number // each; the simulation hangs these on the wheels and the rest on the chassis body
	casterMassG: number
	drive: { trackMm: number; axleXMm: number; wheelbaseMm: number; wheelDiameterMm: number; wheelWidthMm: number }
	motor: { ratedV: number; noLoadRpm: number; stallTorqueNm: number; stallA: number; noLoadA: number }
	pack: { nominalV: number; fullV: number; cutoffV: number; mAh: number; internalOhm: number | null }
	payloadG: number
	// For the simulated drive's pass rules: the motor driver's peak per channel, the brief's speed and wall distance.
	driverPeakA: number | null
	speedMps: number
	stopBeforeWallMm: number
	edgeMm: number // the course's step: the edge the brief says the rover crosses
	estimates: { floorMu: number; rollingCrr: number; packOhm: number }
}

// The caster's M4 screws (the catalog's casters have 4.2–5 mm holes).
const CASTER_HOLE_MM = 4.2
const BOARD_HOLE_INSET_MM = 3.5

// others: the outlines of the robot's other boards, by name; this board is "main".
export function chassisSpec(s: ContractSnapshot, others: { name: string; outline: { widthMm: number; heightMm: number } }[] = []): ChassisSpec | null {
	const v = s.values
	const mech = v.mechanics, motion = v.motion
	const cat = defaultCheckCatalog()
	if (!mech || !motion || !cat) return null
	const motor = byMpn(cat.mech.motors, mech.drive.motor), wheel = byMpn(cat.mech.wheels, mech.drive.wheel), caster = byMpn(cat.mech.casters, mech.drive.caster)
	const pack = byMpn(cat.mech.batteries, mech.battery.pack), sensor = byMpn(cat.mech.sensors ?? [], mech.sensor.module)
	if (!motor || !wheel || !caster || !pack || !sensor) return null
	const outline = { widthMm: v.outline?.widthMm ?? 0, heightMm: v.outline?.heightMm ?? 0 }
	const known = [{ name: "main", outline }, ...others.filter((o) => o.name !== "main")]
	const placed = mech.chassis.boards.filter((b) => known.some((k) => k.name === b.name))
	const unplaced = mech.chassis.boards.filter((b) => !known.some((k) => k.name === b.name)).map((b) => b.name)
	const ms = mounts(mech, known, cat.mech)
	ms.push({ what: "payload", xMm: 0, yMm: 0, zMm: mech.chassis.clearanceMm + mech.chassis.thicknessMm + 10, sizeMm: [20, 20, 20], massG: motion.payloadG })
	const { massG, com } = massAndCom(ms)
	return {
		plate: { lengthMm: mech.chassis.plateMm[0], widthMm: mech.chassis.plateMm[1], thicknessMm: mech.chassis.thicknessMm, clearanceMm: mech.chassis.clearanceMm },
		standoffMm: est("standoffMm"),
		motors: ms.filter((m) => m.what.startsWith("motor:")).map((m) => ({ side: m.what.endsWith("left") ? ("left" as const) : ("right" as const), xMm: m.xMm, yMm: m.yMm, bodyMm: motor.bodyMm, axleDropMm: mech.chassis.clearanceMm - wheel.diameterMm / 2 })),
		caster: { xMm: mech.drive.axleXMm - mech.drive.wheelbaseMm, holesMm: caster.holesMm, holeDiaMm: CASTER_HOLE_MM, wheelMm: caster.wheelMm, heightMm: caster.heightMm },
		battery: { xMm: mech.battery.at.xMm, yMm: mech.battery.at.yMm, sizeMm: pack.sizeMm },
		boards: placed.map((b) => {
			const o = known.find((k) => k.name === b.name)!.outline
			return { name: b.name, xMm: b.at.xMm, yMm: b.at.yMm, widthMm: o.widthMm, heightMm: o.heightMm, rotDeg: b.rotDeg, holeInsetMm: BOARD_HOLE_INSET_MM }
		}),
		unplaced,
		sensor: { ...mech.sensor.at, sizeMm: sensor.sizeMm, rangeMm: sensor.rangeMm, updateMs: sensor.updateMs },
		massG,
		com,
		wheelMassG: wheel.massG,
		casterMassG: caster.massG,
		drive: { trackMm: mech.drive.trackMm, axleXMm: mech.drive.axleXMm, wheelbaseMm: mech.drive.wheelbaseMm, wheelDiameterMm: wheel.diameterMm, wheelWidthMm: wheel.widthMm },
		motor: { ratedV: motor.ratedV, noLoadRpm: motor.noLoadRpm, stallTorqueNm: motor.stallTorqueNm, stallA: motor.stallA, noLoadA: motor.noLoadA },
		pack: { nominalV: pack.nominalV, fullV: pack.fullV, cutoffV: pack.cutoffV, mAh: pack.mAh, internalOhm: pack.internalOhm ?? null },
		payloadG: motion.payloadG,
		driverPeakA: Number(cat.boardParts.find((p) => p.mpn === (v.parts ?? []).find((x) => x.role === "motor-driver")?.mpn)?.peakA ?? NaN) || null,
		speedMps: motion.speedMps,
		stopBeforeWallMm: motion.stopBeforeWallMm,
		edgeMm: motion.edgeMm,
		estimates: { floorMu: est("floorMu"), rollingCrr: est("rollingCrr"), packOhm: pack.internalOhm ?? est("packInternalOhm") },
	}
}

export type ChassisArtifact = { ok: true; revision: number; dir: string; files: string[]; mounts: unknown; stub?: boolean }
export type ChassisResult = ChassisArtifact | { ok: false; reason: string }

export async function buildChassis(python: string, root: string, dir: string, s: ContractSnapshot, revision: number): Promise<ChassisResult> {
	const spec = chassisSpec(s)
	if (!spec) return { ok: false, reason: "no mechanics design (or a part not in catalog/mechanics.json) to build a chassis from" }
	mkdirSync(dir, { recursive: true })
	const specPath = join(dir, "spec.json")
	writeFileSync(specPath, JSON.stringify(spec, null, 1))
	try {
		await exec(python, [join(root, "py", "chassis.py"), specPath, dir], { timeout: 300_000 })
	} catch (e) {
		const stderr = String((e as { stderr?: string }).stderr ?? e).trim().split("\n").filter(Boolean).at(-1) ?? "the chassis generator failed"
		return { ok: false, reason: stderr }
	}
	return { ok: true, revision, dir, files: ["chassis.step", "chassis.stl", "mounts.json", "spec.json"].map((f) => join(dir, f)), mounts: JSON.parse(readFileSync(join(dir, "mounts.json"), "utf8")) }
}
