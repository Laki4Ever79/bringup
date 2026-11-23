import { execFile } from "node:child_process"
import { countsPerRev, quadratureWired } from "../mechanics/firmware.ts"
import { ESTOP_HEAD_CLEARANCE_MM, ESTOP_PANEL_MM, estopPart } from "../mechanics/safety.ts"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { writeRosPackage } from "../ros/package.ts"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ContractSnapshot } from "../contract/types.ts"
import { assemblyOutlines, withAssembly } from "../mechanics/assembly.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { byMpn, type MotorMountPart } from "../mechanics/catalog.ts"
import { est } from "../mechanics/estimates.ts"
import { massAndCom, mounts, payloadMount, stickerPanel } from "../mechanics/model.ts"
import { connectorBoxes, MOUNTING_HOLE, mountingHoles } from "../codegen/circuit.ts"
import { CABLE_SLACK_MM } from "../dashboard/assembly-geom.js"
import { isMotorPlug } from "../mechanics/refs.ts"
import { STANDOFF } from "../contract/case.ts"

const exec = promisify(execFile)

// What py/chassis.py builds from (chassis frame: origin at the plate centre, +x forward, mm), plus the mass, centre of
// mass and drive numbers the simulation (py/mech/model.py) reads from the same file.
// The e-stop's printed deck (py/chassis.py): a bridge across the plate on two walls at its long edges, clear of
// everything on the plate; its panel PANEL_MM thick (within the button's 1-3 mm) with the button's cutout, and the collar
// ring around the head (mechanics.safety.estop.collarMm), HEAD_CLEARANCE_MM clear of it so it stays free to hit.
export interface ChassisEstop { xMm: number; yMm: number; panelTopMm: number; panelMm: number; holeMm: number; headMm: number; collarMm: number; aboveMm: number; belowMm: number; bodyMm: number }
// A beacon support's printed mast (py/chassis.py): sections of at most this height (an ESTIMATE of a common printer's
// build height) on a socket on the plate; each section above the first has a spigot into the one below.
export const MAST_SECTION_MAX_MM = 200
export interface ChassisBeacon { xMm: number; yMm: number; topMm: number; sizeMm: number; wallMm: number; sectionMaxMm: number }
export interface ChassisSpec {
	// The sticker panel (model.ts stickerPanel): its box in the plate's frame, z from the floor.
	sticker?: { xMm: number; yMm: number; zMm: number; sizeMm: [number, number, number] }
	// The beacon support's mast, when the robot has one (Eurobot F.6).
	beacon?: ChassisBeacon
	// The emergency stop's deck, when the robot has one.
	estop?: ChassisEstop
	// Boards the chassis places whose outline this run doesn't know (another board of a multi-board robot): left off the
	// plate and out of the mass, and named, never drawn at the main board's size.
	unplaced: string[]
	plate: { lengthMm: number; widthMm: number; thicknessMm: number; clearanceMm: number }
	gridMm?: number // a mounting grid's pitch (py/chassis.py grid_holes)
	standoffMm: number
	// axleDropMm: the axle's depth under the plate's underside (the caster sets the plate's height; the motor's bracket drops to the axle).
	// mount: how the motor is held. "bracket": a bought bracket (catalog motorMounts) against the plate's underside, its two
	// screws through holes in the plate, no printed cradle. "clamp": the printed cradle and a printed clamp under the motor,
	// held by two self-tapping screws into the cradle's bosses. "cradle-too-shallow": the cradle can't hold the axle that
	// close to the plate (it needs wall above the motor); the mechanics check says so.
	// rear: a skid-steer rover's rear-axle motor (drive.kind "skid4").
	motors: { side: "left" | "right"; rear?: true; xMm: number; yMm: number; bodyMm: [number, number, number]; axleDropMm: number; mount: MotorMount }[]
	// null on a skid-steer rover: four driven wheels, no caster.
	caster: { xMm: number; holesMm: [number, number][]; holeDiaMm: number; wheelMm: number; heightMm: number } | null
	battery: { xMm: number; yMm: number; sizeMm: [number, number, number] }
	// holes: the board's own mounting holes on the plate (its mountingHoles, or a bought module's record holes, turned by
	// rotDeg); a standoff under each. standoffs false: a HAT on another board's spacers, with none of its own on the plate.
	// screwHoleMm / pilotMm: the board's own hole and the standoff's pilot for the screw that hole takes (BOARD_SCREWS): a
	// designed board's Ø2.2 mm hole takes M2, a Raspberry Pi's Ø2.7 mm M2.5.
	boards: { name: string; xMm: number; yMm: number; widthMm: number; heightMm: number; rotDeg: number; holeInsetMm: number; holes: { xMm: number; yMm: number }[]; standoffs?: false; screwHoleMm: number; pilotMm: number }[]
	// The designed boards' screw, the case's: an M2 self-tapping screw through the board's hole into the standoff's pilot
	// hole. A board with other holes has its own (boards[].screwHoleMm, pilotMm).
	boardScrew: { boardHoleMm: number; pilotMm: number }
	// holes: the breakout's mounting holes through the bracket (yMm across the robot, zMm up from the plate's underside),
	// the ones that land on the bracket above the plate; holeDiaMm their clearance.
	sensor: { xMm: number; yMm: number; zMm: number; sizeMm: [number, number, number]; rangeMm: number; updateMs: number; holes: { yMm: number; zMm: number }[]; holeDiaMm: number }
	// The board's IMU (a part with role imu): the drive's bridge gives the firmware its gyro heading, so a robot is
	// simulated as built (its turns and odometry close on the gyro). noise and residual bias are ESTIMATES for the
	// LSM6DS3TR-C after the firmware's 1 s at-rest bias calibration (hw_board.cpp), not measured.
	imu?: { noiseDegPerSqrtS: number; biasDegPerS: number }
	massG: number
	com: [number, number, number] // the whole rover's, wheels and caster included
	printBedMm: [number, number, number] // the printer the printed parts must fit (estimate printBedMm)
	// The body's parts (every mount but the wheels and the caster, the payload included): each one's mass, centre and box
	// in the chassis frame (z from the floor), the same list massG and com come from. The URDF composes the body's
	// inertia from them (src/ros/urdf.ts bodyInertia). Absent in a spec written before 19 Nov 2026.
	bodyParts?: { what: string; atMm: [number, number, number]; sizeMm: [number, number, number]; massG: number }[]
	wheelMassG: number // each; the simulation hangs these on the wheels and the rest on the chassis body
	casterMassG: number
	drive: { kind?: "differential" | "skid4"; trackMm: number; axleXMm: number; wheelbaseMm: number; wheelDiameterMm: number; wheelWidthMm: number; maxAccelMps2?: number }
	motor: { ratedV: number; noLoadRpm: number; stallTorqueNm: number; stallA: number; noLoadA: number; encoderCountsPerRev?: number }
	pack: { nominalV: number; fullV: number; cutoffV: number; mAh: number; internalOhm: number | null }
	payloadG: number
	// For the simulated drive's pass rules: the motor driver's peak per channel, the brief's speed and wall distance.
	driverPeakA: number | null
	speedMps: number
	stopBeforeWallMm: number
	edgeMm: number // the course's step: the edge the brief says the rover crosses
	estimates: { floorMu: number; casterMu: number; rollingCrr: number; packOhm: number }
}

export type MotorMount =
	| { kind: "bracket"; mpn: string; holes: { xMm: number; yMm: number }[]; holeDiaMm: number }
	| { kind: "clamp"; screwHoles: { xMm: number; yMm: number }[]; pilotMm: number; clampMm: [number, number, number] }
	| { kind: "cradle-too-shallow"; needMm: number }
// The printed cradle's wall above and around the motor (py/chassis.py WALL).
export const CRADLE_WALL_MM = 2
// A #2-56 screw (2.18 mm) through the plate: the bracket's own hole size and a little more for printing.
export const BRACKET_PLATE_HOLE_MM = 2.4
// The clamp's M2 self-tapping screws: the board standoffs' pilot (STANDOFF.pilotMm) in a 4 mm boss beside the cradle.
export const CLAMP_BOSS_MM = 4
// The bracket matches by the motor's cross-section, any length: real run 13's POLOLU-5139 (an encoder motor, 32 mm long)
// was refused by a 26 mm length match and both motors became a hardware misfit (16 Nov 2026). An encoder motor goes
// in with its encoder's connector side away from the plate (its other sides stay within the cross-section or 0.25 mm).
// How a motor is held (lead and bringup-board, 16 Nov 2026): Pololu's bracket when it fits the motor and the design's
// axle drop is its axleFromFaceMm (±0.5 mm: the plate height is never changed for it); else the printed cradle with a
// clamp, when the cradle can reach that drop; else nothing that holds it there. The printed cradle alone needs a wall above
// the motor, so it can't hold the axle closer than H/2 + 2 mm: every real subscription rover asked for 5.0 mm and got
// 7.0 mm without a word (py/chassis.py clamped it).
export function motorMount(m: { xMm: number; yMm: number; bodyMm: [number, number, number]; axleDropMm: number }, motorMpn: string, mounts: MotorMountPart[], pilotMm: number): MotorMount {
	const [L, W, H] = m.bodyMm
	const bracket = mounts.find((b) => b.kind === "bracket" && /^POLOLU-/i.test(motorMpn) && b.fitsCrossSectionMm.every((v, i) => Math.abs(v - m.bodyMm[i + 1]) < 0.5) && Math.abs(m.axleDropMm - b.axleFromFaceMm) <= 0.5)
	if (bracket) {
		// The shaft (and the gearbox's face) points out to the wheel, along y.
		const out = Math.sign(m.yMm) || 1
		const yHole = +(m.yMm + out * (L / 2 - bracket.holeFromGearboxFaceMm)).toFixed(3)
		return { kind: "bracket", mpn: bracket.mpn, holes: [-1, 1].map((s) => ({ xMm: +(m.xMm + (s * bracket.holeSpacingMm) / 2).toFixed(3), yMm: yHole })), holeDiaMm: BRACKET_PLATE_HOLE_MM }
	}
	const need = H / 2 + CRADLE_WALL_MM
	if (m.axleDropMm < need - 1e-9) return { kind: "cradle-too-shallow", needMm: need }
	// Bosses either side of the cradle, mid-length; the clamp spans the cradle and both bosses under the motor.
	const reach = W / 2 + CRADLE_WALL_MM + CLAMP_BOSS_MM / 2
	return { kind: "clamp", screwHoles: [-1, 1].map((s) => ({ xMm: +(m.xMm + s * reach).toFixed(3), yMm: m.yMm })), pilotMm, clampMm: [2 * reach + CLAMP_BOSS_MM, 6, 2] }
}

// The sensor breakout's M2.5 screws: ISO 273's medium clearance hole.
export const SENSOR_HOLE_MM = 2.7
// The bracket's holes for the breakout: its mounting holes at the breakout's place (its centre at zMm − clearance above
// the plate's underside), the ones whose edge clears the plate's top by a millimetre (the lower pair can sit in the plate).
export function sensorHoles(sensor: { mountHolesMm?: [number, number][] }, at: { yMm: number; zMm: number }, plate: { thicknessMm: number; clearanceMm: number }): { yMm: number; zMm: number }[] {
	const zc = at.zMm - plate.clearanceMm
	return (sensor.mountHolesMm ?? []).map(([dy, dz]) => ({ yMm: +(at.yMm + dy).toFixed(3), zMm: +(zc + dz).toFixed(3) })).filter((h) => h.zMm - SENSOR_HOLE_MM / 2 >= plate.thicknessMm + 1)
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

// The robot's cables: from the main board's plug to what it serves, along the chassis (each axis's run, as a cable is
// laid along the plate and up a standoff), plus CABLE_SLACK_MM, and the shortest catalog cable that reaches. The sensor
// on its STEMMA QT cable from mechanics.sensor.connector (JT1); each motor's leads from the nearer 2-pin plug (JM1/JM2) to
// its rear terminals, under the plate. A run no catalog cable reaches has cable null (the parts list says so).
export interface RobotCable { what: string; from: string; needMm: number; kind: "stemma-qt" | "jst-ph-2-leads"; cable: { mpn: string; lengthMm: number } | null }
export function robotCables(s: ContractSnapshot, spec: ChassisSpec, cables: { mpn: string; kind: string; lengthMm: number }[]): RobotCable[] {
	const v = s.values
	const main = spec.boards.find((b) => b.name === "main")
	if (!main || !v.outline) return []
	const boxes = connectorBoxes(s, v.outline.widthMm, v.outline.heightMm)
	const at = (ref: string) => {
		const b = boxes.find((x) => x.ref === ref)
		if (!b) return null
		const p = turn({ x: b.x, y: b.y }, main.rotDeg)
		return { x: main.xMm + p.x, y: main.yMm + p.y, z: spec.plate.thicknessMm + spec.standoffMm + 1.6 }
	}
	const pick = (kind: RobotCable["kind"], need: number) => {
		const c = cables.filter((x) => x.kind === kind && x.lengthMm >= need).sort((a, b) => a.lengthMm - b.lengthMm)[0]
		return c ? { mpn: c.mpn, lengthMm: c.lengthMm } : null
	}
	const run = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.round(Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) + CABLE_SLACK_MM)
	const out: RobotCable[] = []
	const plug = v.mechanics?.sensor?.connector
	const from = plug ? at(plug) : null
	if (plug && from) {
		const need = run(from, { x: spec.sensor.xMm, y: spec.sensor.yMm, z: spec.sensor.zMm - spec.plate.clearanceMm })
		out.push({ what: "distance sensor", from: plug, needMm: need, kind: "stemma-qt", cable: pick("stemma-qt", need) })
	}
	// Each motor's plug is the one the board generator wires to it (circuit.ts: the motor plugs in ref order, JM1 the
	// left, JM2 the right, a skid-steer rover's JM3/JM4 its rear pair), not the nearest: the Eurobot base's spare plug JM3
	// sat nearest its left motor and the cable list ran that motor from it (17 Nov 2026).
	const plugs = (v.parts ?? []).filter(isMotorPlug).sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true })).map((p) => ({ ref: p.ref, at: at(p.ref) }))
	for (const m of spec.motors) {
		const end = { x: m.xMm, y: m.yMm - (Math.sign(m.yMm) || 1) * (m.bodyMm[0] / 2), z: -m.axleDropMm }
		const near = plugs[(m.rear ? 2 : 0) + (m.side === "right" ? 1 : 0)]
		if (!near?.at) continue
		const need = run(near.at!, end)
		out.push({ what: `${m.side} motor`, from: near.ref, needMm: need, kind: "jst-ph-2-leads", cable: pick("jst-ph-2-leads", need) })
	}
	return out
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
// The self-tapping screw a board's mounting hole takes (the largest metric size that passes it), and the pilot the
// printed standoff gets for it. M2 1.6 mm is the case's (STANDOFF.pilotMm); M2.5 2.1 mm is an ESTIMATE for a
// thread-forming screw in PLA (about 85 % of the thread), to be checked on a print.
export const BOARD_SCREWS: { threadMm: number; pilotMm: number }[] = [{ threadMm: 2, pilotMm: STANDOFF.pilotMm }, { threadMm: 2.5, pilotMm: 2.1 }]
export function boardScrew(holeMm: number): { threadMm: number; pilotMm: number } {
	return [...BOARD_SCREWS].reverse().find((x) => x.threadMm < holeMm) ?? BOARD_SCREWS[0]
}

export function chassisSpec(s: ContractSnapshot, others: { name: string; outline: { widthMm: number; heightMm: number } }[] = []): ChassisSpec | null {
	const v = s.values
	const mech = withAssembly(v), motion = v.motion
	const cat = defaultCheckCatalog()
	if (!mech || !motion || !cat) return null
	const motor = byMpn(cat.mech.motors, mech.drive.motor), wheel = byMpn(cat.mech.wheels, mech.drive.wheel), caster = byMpn(cat.mech.casters, mech.drive.caster)
	const pack = byMpn(cat.mech.batteries, mech.battery.pack), sensor = byMpn(cat.mech.sensors ?? [], mech.sensor.module)
	const skid = mech.drive.kind === "skid4"
	if (!motor || !wheel || (!caster && !skid) || !pack || !sensor) return null
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
		...(mech.chassis.gridMm ? { gridMm: mech.chassis.gridMm } : {}),
		standoffMm: est("standoffMm"),
		motors: ms.filter((m) => m.what.startsWith("motor:")).map((m) => {
			const base = { side: m.what.startsWith("motor:left") ? ("left" as const) : ("right" as const), ...(m.what.endsWith(":rear") ? { rear: true as const } : {}), xMm: m.xMm, yMm: m.yMm, bodyMm: motor.bodyMm, axleDropMm: mech.chassis.clearanceMm - wheel.diameterMm / 2 }
			return { ...base, mount: motorMount(base, motor.mpn, cat.mech.motorMounts ?? [], STANDOFF.pilotMm) }
		}),
		caster: caster && !skid ? { xMm: mech.drive.axleXMm - mech.drive.wheelbaseMm, holesMm: caster.holesMm, holeDiaMm: CASTER_HOLE_MM, wheelMm: caster.wheelMm, heightMm: caster.heightMm } : null,
		battery: { xMm: mech.battery.at.xMm, yMm: mech.battery.at.yMm, sizeMm: pack.sizeMm },
		boards: placed.map((b) => {
			const o = known.find((k) => k.name === b.name)!.outline
			const hat = Boolean(b.on && placed.some((x) => x.name === b.on))
			const holes = hat ? [] : b.holes?.length ? holesInChassis(b, o).map(([xMm, yMm]) => ({ xMm, yMm })) : boardHoles(s, b.name, o).map((h) => turn(h, b.rotDeg)).map((h) => ({ xMm: +(b.at.xMm + h.x).toFixed(3), yMm: +(b.at.yMm + h.y).toFixed(3) }))
			// A record's hole diameter (a bought module's) picks its screw; a designed board drills the generator's hole.
			const dia = b.holes?.find((h) => typeof h.dia === "number" && h.dia > 0)?.dia ?? MOUNTING_HOLE.diameterMm
			return { name: b.name, xMm: b.at.xMm, yMm: b.at.yMm, widthMm: o.widthMm, heightMm: o.heightMm, rotDeg: b.rotDeg, holeInsetMm: BOARD_HOLE_INSET_MM, holes, ...(hat ? { standoffs: false as const } : {}), screwHoleMm: dia, pilotMm: boardScrew(dia).pilotMm }
		}),
		boardScrew: { boardHoleMm: MOUNTING_HOLE.diameterMm, pilotMm: STANDOFF.pilotMm },
		unplaced,
		...((p) => (p ? { sticker: { xMm: p.xMm, yMm: p.yMm, zMm: p.zMm, sizeMm: p.sizeMm as [number, number, number] } } : {}))(stickerPanel(mech)),
		...(mech.beacon ? { beacon: { xMm: mech.beacon.at.xMm, yMm: mech.beacon.at.yMm, topMm: mech.beacon.topMm, sizeMm: mech.beacon.sizeMm, wallMm: mech.beacon.mastWallMm, sectionMaxMm: MAST_SECTION_MAX_MM } } : {}),
		...((e, b) => (e && b ? { estop: { xMm: e.at.xMm, yMm: e.at.yMm, panelTopMm: e.at.zMm, panelMm: Math.min(b.panelMaxMm, Math.max(b.panelMinMm, ESTOP_PANEL_MM)), holeMm: b.panelHoleMm, headMm: b.headMm, collarMm: e.collarMm ?? 0, aboveMm: b.aboveMm, belowMm: b.belowMm, bodyMm: b.bodyMm } } : {}))(mech.safety?.estop, mech.safety?.estop ? estopPart(cat.mech, mech.safety.estop.part) : undefined),
		sensor: { ...mech.sensor.at, sizeMm: sensor.sizeMm, rangeMm: sensor.rangeMm, updateMs: sensor.updateMs, holes: sensorHoles(sensor, mech.sensor.at, mech.chassis), holeDiaMm: SENSOR_HOLE_MM },
		...((s.values.parts ?? []).some((p) => p.role === "imu") ? { imu: { ...IMU_SIM } } : {}),
		massG,
		com,
		printBedMm: [est("printBedMm"), est("printBedMm"), est("printBedMm")],
		bodyParts: ms.filter((m) => !m.what.startsWith("wheel:") && m.what !== "caster").map((m) => ({ what: m.what, atMm: [m.xMm, m.yMm, m.zMm] as [number, number, number], sizeMm: [...m.sizeMm] as [number, number, number], massG: m.massG })),
		wheelMassG: wheel.massG,
		casterMassG: caster && !skid ? caster.massG : 0,
		drive: { kind: mech.drive.kind, trackMm: mech.drive.trackMm, axleXMm: mech.drive.axleXMm, wheelbaseMm: mech.drive.wheelbaseMm, wheelDiameterMm: wheel.diameterMm, wheelWidthMm: wheel.widthMm, ...(mech.drive.maxAccelMps2 ? { maxAccelMps2: mech.drive.maxAccelMps2 } : {}) },
		motor: { ratedV: motor.ratedV, noLoadRpm: motor.noLoadRpm, stallTorqueNm: motor.stallTorqueNm, stallA: motor.stallA, noLoadA: motor.noLoadA, ...(motor.encoder ? { encoderCountsPerRev: countsPerRev(motor, quadratureWired(s.values.pins))! } : {}) },
		pack: { nominalV: pack.nominalV, fullV: pack.fullV, cutoffV: pack.cutoffV, mAh: pack.mAh, internalOhm: pack.internalOhm ?? null },
		payloadG: motion.payloadG,
		driverPeakA: Number(cat.boardParts.find((p) => p.mpn === (v.parts ?? []).find((x) => x.role === "motor-driver")?.mpn)?.peakA ?? NaN) || null,
		speedMps: motion.speedMps,
		stopBeforeWallMm: motion.stopBeforeWallMm,
		edgeMm: motion.edgeMm,
		estimates: { floorMu: est("floorMu"), casterMu: est("casterMu"), rollingCrr: est("rollingCrr"), packOhm: pack.internalOhm ?? est("packInternalOhm") },
	}
}

export type ChassisArtifact = { ok: true; revision: number; dir: string; files: string[]; mounts: unknown; stub?: boolean; printCheck?: { ok: boolean; issues: string[]; notes: string[] } }
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
	// The printed motor clamp, when a motor is clamped (motorMount): print one per clamped motor.
	const clamp = [...(existsSync(join(dir, "motor-clamp.stl")) ? [join(dir, "motor-clamp.stl")] : []), ...(existsSync(join(dir, "battery-strap.stl")) ? [join(dir, "battery-strap.stl")] : [])]
	// The beacon support's mast, printed in sections (py/chassis.py mast_sections): each its own STL.
	const mast = readdirSync(dir).filter((f) => /^beacon-mast-\d+\.stl$/.test(f)).sort().map((f) => join(dir, f))
	const printCheck = existsSync(join(dir, "print.json")) ? (JSON.parse(readFileSync(join(dir, "print.json"), "utf8")) as { ok: boolean; issues: string[]; notes: string[] }) : undefined
	return { ok: true, revision, dir, files: ["chassis.step", "chassis.stl", "mounts.json", "spec.json"].map((f) => join(dir, f)).concat(clamp, mast, ros), mounts: JSON.parse(readFileSync(join(dir, "mounts.json"), "utf8")), ...(printCheck ? { printCheck } : {}) }
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


// The chassis and the bought parts it carries (boards, pack, motors, wheels, sensor, e-stop) share no volume: py/chassis.py
// measures every pair's common volume with exact booleans (mounts.json "interference"). The 2D fit checks name the pairs
// they compare; this one compares every pair, so a pair nobody listed still shows (the pack ran into the sensor's bracket
// on three of four example robots, 19 Nov 2026). A pair the kernel couldn't measure is reported, never passed.
export interface Interference { pairs: number; clashes: { a: string; b: string; volumeMm3: number; atMm: [number, number, number] }[]; unmeasured: { a: string; b: string; error: string }[]; shortShafts?: { motor: string; engagementMm: number }[]; shaftMinMm?: number }
export function interferenceChecks(built: { interference?: Interference } | null | undefined): { kind: "part-interference"; message: string; fields: ["mechanics"]; affects: ["mechanics"] }[] {
	const r = built?.interference
	if (!r) return []
	const out: { kind: "part-interference"; message: string; fields: ["mechanics"]; affects: ["mechanics"] }[] = []
	if (r.clashes.length)
		out.push({ kind: "part-interference", message: `parts of the robot occupy the same space (exact common volume, chassis frame, mm): ${r.clashes.map((c) => `${c.a} and ${c.b}: ${c.volumeMm3} mm³ around (${c.atMm.join(", ")})`).join("; ")}: move one of each pair`, fields: ["mechanics"], affects: ["mechanics"] })
	// A motor's shaft must reach into its wheel's hub (py/chassis.py shaft_engagement; the minimum is an ESTIMATE).
	if (r.shortShafts?.length)
		out.push({ kind: "part-interference", message: `a motor's shaft barely reaches its wheel: ${r.shortShafts.map((x) => `${x.motor} ${x.engagementMm} mm into the hub`).join(", ")} (at least ${r.shaftMinMm ?? 4} mm, an estimate): narrow the track or move the motors outward`, fields: ["mechanics"], affects: ["mechanics"] })
	if (r.unmeasured.length)
		out.push({ kind: "part-interference", message: `the interference check couldn't measure ${r.unmeasured.map((u) => `${u.a} against ${u.b}`).join(", ")}: not a pass; the chassis geometry needs a look`, fields: ["mechanics"], affects: ["mechanics"] })
	return out
}

// A board's standoffs stand on the plate under its holes; the pack lies on the plate between two rails. A pack thinner
// than the standoffs may lie under a board (checks.ts), but not on a standoff: the rover mock's pack ran onto the main
// board's standoffs (246.7 mm³, found by the interference check, 19 Nov 2026), which the 2D fit check couldn't see
// because it doesn't know the boards' holes. This does (chassisSpec's), so the layout solver can avoid it.
// The simulated gyro (ChassisSpec.imu): ESTIMATES. Noise: a few mdps/sqrt(Hz) is the order of a MEMS gyro's rate noise
// density (the LSM6DS3TR-C's datasheet gives its typical value; 5 mdps/sqrt(Hz) here, rounded up), as an angle random
// walk of 0.005 deg/sqrt(s). Bias: what a 1 s at-rest average leaves, 0.05 deg/s (a design choice, not measured).
export const IMU_SIM = { noiseDegPerSqrtS: 0.005, biasDegPerS: 0.05 }
export const STANDOFF_OD_MM = 5 // py/chassis.py STANDOFF_OD
export const RAIL_WALL_MM = 2 // py/chassis.py WALL: the rails beside the pack's long sides
export function packOnStandoffs(s: ContractSnapshot): { kind: "mech-fit"; message: string; fields: ["mechanics"]; affects: ["mechanics"] }[] {
	const mech = s.values.mechanics
	if (!mech?.battery) return []
	const spec = chassisSpec(s)
	if (!spec) return []
	const b = spec.battery
	const halfX = b.sizeMm[0] / 2 + STANDOFF_OD_MM / 2, halfY = b.sizeMm[1] / 2 + RAIL_WALL_MM + STANDOFF_OD_MM / 2
	const hits = spec.boards.filter((x) => x.standoffs !== false).flatMap((x) => x.holes.filter((h) => Math.abs(h.xMm - b.xMm) < halfX && Math.abs(h.yMm - b.yMm) < halfY).map((h) => `${x.name}'s at (${+h.xMm.toFixed(1)}, ${+h.yMm.toFixed(1)})`))
	if (!hits.length) return []
	return [{ kind: "mech-fit", message: `the battery (${b.sizeMm[0]} × ${b.sizeMm[1]} mm at x ${b.xMm}, y ${b.yMm}, with its rails) lies on board standoffs: ${hits.join(", ")}: move the battery clear of the boards' mounting holes, or beside the boards`, fields: ["mechanics"], affects: ["mechanics"] }]
}

// The printed parts can be printed: each fits the printer's bed in some orientation and no designed wall is thinner
// than three perimeters (py/printcheck.py, print.json). Parts that only need support are notes in the report, not
// violations. text-to-cad's lesson 5 (design for the process), 22 Nov 2026: before it, nothing checked the chassis
// against a printer, and the Eurobot base's 260 mm plate fits no 256 mm bed.
export function chassisPrintChecks(built: ChassisArtifact | undefined): { kind: "print-check"; message: string; fields: ["mechanics"]; affects: ["mechanics"] }[] {
	const p = built?.printCheck
	if (!p || p.ok) return []
	return [{ kind: "print-check", message: `the printed chassis parts can't be printed as designed: ${p.issues.join("; ")}: make the part smaller (the plate's size is the mechanics' chassis.plateMm) or thicker`, fields: ["mechanics"], affects: ["mechanics"] }]
}
