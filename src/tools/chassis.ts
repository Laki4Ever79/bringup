import { execFile } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { writeRosPackage } from "../ros/package.ts"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ContractSnapshot } from "../contract/types.ts"
import { assemblyOutlines, withAssembly } from "../mechanics/assembly.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { byMpn } from "../mechanics/catalog.ts"
import { est } from "../mechanics/estimates.ts"
import { massAndCom, mounts, payloadMount } from "../mechanics/model.ts"
import { MOUNTING_HOLE, mountingHoles } from "../codegen/circuit.ts"
import { STANDOFF } from "../contract/case.ts"

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
	// holes: the board's own mounting holes on the plate (its mountingHoles, or a bought module's record holes, turned by
	// rotDeg); a standoff under each. standoffs false: a HAT on another board's spacers, with none of its own on the plate.
	boards: { name: string; xMm: number; yMm: number; widthMm: number; heightMm: number; rotDeg: number; holeInsetMm: number; holes: { xMm: number; yMm: number }[]; standoffs?: false }[]
	// The board's screw, the case's: an M2 self-tapping screw through the board's hole into the standoff's pilot hole.
	boardScrew: { boardHoleMm: number; pilotMm: number }
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
	estimates: { floorMu: number; casterMu: number; rollingCrr: number; packOhm: number }
}

// The caster's M4 screws (the catalog's casters have 4.2–5 mm holes).
const CASTER_HOLE_MM = 4.2
// A board's holes, from its centre: this board's own (mountingHoles, which leaves out a corner a connector took); another
// board of the robot, known only by its outline, at the four corners where every board puts them (MOUNTING_HOLE).
const BOARD_HOLE_INSET_MM = MOUNTING_HOLE.insetMm
function boardHoles(s: ContractSnapshot, name: string, outline: { widthMm: number; heightMm: number }): { x: number; y: number }[] {
	if (name === "main") return mountingHoles(s).map((h) => ({ x: h.x, y: h.y }))
	const [dx, dy] = [outline.widthMm / 2 - MOUNTING_HOLE.insetMm, outline.heightMm / 2 - MOUNTING_HOLE.insetMm]
	return [[-dx, -dy], [dx, -dy], [-dx, dy], [dx, dy]].map(([x, y]) => ({ x, y }))
}
const turn = (p: { x: number; y: number }, deg: number) => {
	const r = (deg * Math.PI) / 180
	return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) }
}

// A board's own holes (mm from its lower-left corner, before the turn) in the chassis frame: centred, turned
// counter-clockwise by rotDeg (+x forward, +y left), moved to the board's place.
export function holesInChassis(b: { at: { xMm: number; yMm: number }; rotDeg: number; holes?: { x: number; y: number }[] }, o: { widthMm: number; heightMm: number }): [number, number][] {
	const t = (b.rotDeg * Math.PI) / 180, c = Math.round(Math.cos(t)), s = Math.round(Math.sin(t))
	return (b.holes ?? []).map((h) => {
		const x = h.x - o.widthMm / 2, y = h.y - o.heightMm / 2
		return [Math.round((b.at.xMm + x * c - y * s) * 1000) / 1000, Math.round((b.at.yMm + x * s + y * c) * 1000) / 1000] as [number, number]
	})
}

// others: the outlines of the robot's other boards, by name; this board is "main".
export function chassisSpec(s: ContractSnapshot, others: { name: string; outline: { widthMm: number; heightMm: number } }[] = []): ChassisSpec | null {
	const v = s.values
	const mech = withAssembly(v), motion = v.motion
	const cat = defaultCheckCatalog()
	if (!mech || !motion || !cat) return null
	const motor = byMpn(cat.mech.motors, mech.drive.motor), wheel = byMpn(cat.mech.wheels, mech.drive.wheel), caster = byMpn(cat.mech.casters, mech.drive.caster)
	const pack = byMpn(cat.mech.batteries, mech.battery.pack), sensor = byMpn(cat.mech.sensors ?? [], mech.sensor.module)
	if (!motor || !wheel || !caster || !pack || !sensor) return null
	const outline = { widthMm: v.outline?.widthMm ?? 0, heightMm: v.outline?.heightMm ?? 0 }
	// The assembly's outlines win over the caller's for the other boards; this board's own outline is the truth for "main"
	// (the assembly's copy of it can lag until the system sends it again).
	const fromAssembly = assemblyOutlines(v).filter((a) => a.name !== "main")
	const own = [{ name: "main", outline }, ...others.filter((o) => o.name !== "main")]
	const known = [...own.filter((k) => !fromAssembly.some((a) => a.name === k.name)), ...fromAssembly]
	const placed = mech.chassis.boards.filter((b) => known.some((k) => k.name === b.name))
	const unplaced = mech.chassis.boards.filter((b) => !known.some((k) => k.name === b.name)).map((b) => b.name)
	const ms = mounts(mech, known, cat.mech)
	ms.push(payloadMount(mech, motion.payloadG))
	const { massG, com } = massAndCom(ms)
	return {
		plate: { lengthMm: mech.chassis.plateMm[0], widthMm: mech.chassis.plateMm[1], thicknessMm: mech.chassis.thicknessMm, clearanceMm: mech.chassis.clearanceMm },
		standoffMm: est("standoffMm"),
		motors: ms.filter((m) => m.what.startsWith("motor:")).map((m) => ({ side: m.what.endsWith("left") ? ("left" as const) : ("right" as const), xMm: m.xMm, yMm: m.yMm, bodyMm: motor.bodyMm, axleDropMm: mech.chassis.clearanceMm - wheel.diameterMm / 2 })),
		caster: { xMm: mech.drive.axleXMm - mech.drive.wheelbaseMm, holesMm: caster.holesMm, holeDiaMm: CASTER_HOLE_MM, wheelMm: caster.wheelMm, heightMm: caster.heightMm },
		battery: { xMm: mech.battery.at.xMm, yMm: mech.battery.at.yMm, sizeMm: pack.sizeMm },
		boards: placed.map((b) => {
			const o = known.find((k) => k.name === b.name)!.outline
			const hat = Boolean(b.on && placed.some((x) => x.name === b.on))
			const holes = hat ? [] : b.holes?.length ? holesInChassis(b, o).map(([xMm, yMm]) => ({ xMm, yMm })) : boardHoles(s, b.name, o).map((h) => turn(h, b.rotDeg)).map((h) => ({ xMm: +(b.at.xMm + h.x).toFixed(3), yMm: +(b.at.yMm + h.y).toFixed(3) }))
			return { name: b.name, xMm: b.at.xMm, yMm: b.at.yMm, widthMm: o.widthMm, heightMm: o.heightMm, rotDeg: b.rotDeg, holeInsetMm: BOARD_HOLE_INSET_MM, holes, ...(hat ? { standoffs: false as const } : {}) }
		}),
		boardScrew: { boardHoleMm: MOUNTING_HOLE.diameterMm, pilotMm: STANDOFF.pilotMm },
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
		estimates: { floorMu: est("floorMu"), casterMu: est("casterMu"), rollingCrr: est("rollingCrr"), packOhm: pack.internalOhm ?? est("packInternalOhm") },
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
	// The robot's ROS 2 workspace beside its chassis (docs/ros.md): its own package from the same spec, and the shared
	// ros2_control hardware that speaks to its firmware. Best effort: a ROS package that can't be written never fails
	// the chassis.
	const ros: string[] = []
	try {
		const ws = join(dir, "ros", "src")
		ros.push(writeRosPackage(ws, spec, { robot: "rover", revision }))
		cpSync(join(root, "templates", "ros", "bringup_hardware"), join(ws, "bringup_hardware"), { recursive: true })
		ros.push(join(ws, "bringup_hardware"))
	} catch (e) {
		console.error("[chassis] ROS package not written:", e)
	}
	return { ok: true, revision, dir, files: ["chassis.step", "chassis.stl", "mounts.json", "spec.json"].map((f) => join(dir, f)).concat(ros), mounts: JSON.parse(readFileSync(join(dir, "mounts.json"), "utf8")) }
}

// Every hole of a board on the chassis has a standoff under it in the built chassis (mounts.json, measured back from the
// solid), and every standoff a board hole over it: the board and the chassis disagreed by 0.5 mm and a screw size before
// (15 Nov 2026), and nothing compared them.
const MOUNT_TOL_MM = 0.2
export function boardMountChecks(s: ContractSnapshot, built: { standoffHoles?: { xMm: number; yMm: number }[]; casterHoles?: unknown } | null | undefined): { kind: "board-mount-mismatch"; message: string; fields: ["mechanics"]; affects: ["mechanics"] }[] {
	const spec = chassisSpec(s)
	const standoffs = built?.standoffHoles
	if (!spec || !standoffs) return []
	const near = (a: { xMm: number; yMm: number }, b: { xMm: number; yMm: number }) => Math.hypot(a.xMm - b.xMm, a.yMm - b.yMm) <= MOUNT_TOL_MM
	const fmt = (h: { xMm: number; yMm: number }) => `(${+h.xMm.toFixed(2)}, ${+h.yMm.toFixed(2)})`
	const problems: string[] = []
	for (const b of spec.boards) for (const h of b.holes) if (!standoffs.some((o) => near(o, h))) problems.push(`${b.name}'s hole at ${fmt(h)} has no standoff under it`)
	const all = spec.boards.flatMap((b) => b.holes)
	for (const o of standoffs) if (!all.some((h) => near(o, h))) problems.push(`the standoff at ${fmt(o)} has no board hole over it`)
	if (!problems.length) return []
	return [{ kind: "board-mount-mismatch", message: `the chassis and the boards disagree on where the boards mount (mm on the plate): ${problems.join("; ")}`, fields: ["mechanics"], affects: ["mechanics"] }]
}

