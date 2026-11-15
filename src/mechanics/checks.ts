import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentRole, ContractSnapshot, FieldName, Part, PinAssignment as Pin } from "../contract/types.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import { blocksSensor, motorHalfUnder, motorUnderPlateMm, mountOnPlate, plateMaxWidthMm, wheelsRubPlate } from "../dashboard/assembly-geom.js"
import { checkBoards, withAssembly } from "./assembly.ts"
import { byMpn, loadMechCatalog, type MechCatalog } from "./catalog.ts"
import { est, estNote } from "./estimates.ts"
import { edgeForceN, G, massAndCom, motorAt, mounts, supportPolygon } from "./model.ts"
import type { Mechanics, Mount, MotionTargets } from "./types.ts"

// The plain-code mechanics checks: free, instant, run on every contract change. Each states its numbers, the limit,
// the margin and what to change; any estimate it leans on is named "(estimate: <name> <value>)". They never assume
// which board carries the motor driver: mechanicsCheckOver takes every board of the robot (option B, a driver board,
// runs the same checks).

export type MechViolation = {
	kind: "mech-torque" | "mech-speed" | "mech-stopping" | "mech-current" | "mech-runtime" | "mech-voltage" | "mech-tipping" | "mech-climb" | "mech-fit" | "mech-wiring" | "mech-hw-layer" | "mech-drive"
	message: string
	fields: FieldName[]
	affects: AgentRole[]
}

// Board parts with the numbers the checks read (catalog/parts.json entries carry extra keys).
export type BoardPartData = { mpn: string; role?: string; [k: string]: unknown }
export interface CheckCatalog {
	mech: MechCatalog
	boardParts: BoardPartData[]
}

export const TORQUE_MARGIN = 1.5
export const SPEED_LOAD_DERATE = 0.8 // speed under load vs no-load at the cell's nominal voltage
export const USABLE_ENERGY = 0.85 // of the pack's rated Wh, before the cut-off
export const TIP_MARGIN_MM = 10
export const CLIMB_MARGIN = 1.2 // the drive wheels' grip must push the caster up the edge with this margin
export const LEVEL_TOLERANCE_MM = 3 // caster and wheels must hold the plate level within this

const ROOT = resolve(import.meta.dirname, "../..")
let cached: CheckCatalog | null = null
export function defaultCheckCatalog(): CheckCatalog | null {
	if (cached) return cached
	if (!existsSync(resolve(ROOT, "catalog/mechanics.json"))) return null
	cached = { mech: loadMechCatalog(ROOT), boardParts: loadCatalog(ROOT) as unknown as BoardPartData[] }
	return cached
}

const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100
const ALL: FieldName[] = ["mechanics"]

// A computed value against the brief's limit, for the report (filled by the same code as the checks).
export interface MechFigure {
	check: string
	value: string
	limit: string
	ok: boolean
	note?: string
}

// The figures behind the checks for one board's contract (empty without motion targets or a complete mechanics design).
export function mechanicsFigures(c: ContractSnapshot): MechFigure[] {
	const cat = defaultCheckCatalog()
	const v = c.values as { motion?: MotionTargets }
	const figures: MechFigure[] = []
	if (cat) mechanicsCheckOver(v.motion, withAssembly(c.values), checkBoards(c), cat, figures)
	return figures
}

// The largest plate the brief's size allows, [length, width]: the wheels stand outside the plate's width, so the width
// is the brief's less two wheels and their clearance (the size check below says the same). The brief's own size until
// the mechanics names a catalog wheel. A system sizes its shared plate by this, not by the brief's outer size: the
// rover-climate plate was grown to 110 mm wide against a 120 mm brief, leaving no room for the wheels (15 Nov).
export function plateLimitMm(c: ContractSnapshot): [number, number] | undefined {
	const max = c.values.motion?.maxSizeMm
	if (!max) return undefined
	const cat = defaultCheckCatalog()
	const wheel = cat && c.values.mechanics ? byMpn(cat.mech.wheels, c.values.mechanics.drive.wheel) : undefined
	return wheel ? [max[0], max[1] - 2 * wheel.widthMm - 4] : max
}

export function mechanicsChecks(c: ContractSnapshot): MechViolation[] {
	const cat = defaultCheckCatalog()
	return cat ? mechanicsChecksWith(c, cat) : []
}

export function mechanicsChecksWith(c: ContractSnapshot, cat: CheckCatalog): MechViolation[] {
	const v = c.values as { motion?: MotionTargets }
	// A motor driver with no motion targets: a robot nobody made one (real rover run 6, 15 Nov, all fast models: the
	// architect picked the DRV8833 and drew a 145 × 110 mm board, but never wrote motion, so no chassis, drive or
	// simulation followed, and the run settled and passed review as a plain board).
	// Run 7 (fast models again): no driver either, but the design's own requirements said "drives on two DC motors".
	const req = c.values.requirements
	// Not for a board in a system (an assembly): the climate board on a rover names the rover but carries no motion.
	const saysRobot = !c.values.assembly && /\b(motors?|wheels?|rover|robot|drives? (around|on|itself)|self-driving|differential drive)\b/i.test(`${req?.summary ?? ""} ${(req?.peripherals ?? []).join(" ")}`)
	if (!v.motion && ((c.values.parts ?? []).some((p) => p.role === "motor-driver") || saysRobot))
		return [{ kind: "mech-fit", message: "the design moves (a motor driver, or requirements that name motors, wheels or a rover) but has no motion targets: a robot needs its motion field (the brief's speedMps, runtimeMin, edgeMm, maxSlopeDeg, stopBeforeWallMm, payloadG, maxSizeMm, maxMassG); write it, and the mechanics engineer designs the drive and chassis", fields: ["motion"], affects: ["architect"] }]
	return mechanicsCheckOver(v.motion, withAssembly(c.values), checkBoards(c), cat)
}

// Distance from a point to each edge of a convex polygon (inside: all positive); the smallest.
function insideMargin(p: [number, number], poly: [number, number][]): number {
	let min = Infinity
	// Orientation-independent: signed distances with the polygon's centroid on the positive side.
	const cx = poly.reduce((t, q) => t + q[0], 0) / poly.length, cy = poly.reduce((t, q) => t + q[1], 0) / poly.length
	for (let i = 0; i < poly.length; i++) {
		const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length]
		const len = Math.hypot(bx - ax, by - ay) || 1
		const side = (x: number, y: number) => ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / len
		const sign = Math.sign(side(cx, cy)) || 1
		min = Math.min(min, side(p[0], p[1]) * sign)
	}
	return min
}

// Where a part fits on the plate (origin at the centre): the x and y its centre may take, or the plate it needs. The
// numbers an agent can act on (real rover run 3, 15 Nov: "enlarge the plate or move it" had the battery and caster
// moved a few mm at a time, revision after revision, without ever landing on the plate).
export function fitWindow(m: { sizeMm: number[]; xMm: number; yMm: number }, L: number, W: number): string {
	const hx = L / 2 - m.sizeMm[0] / 2, hy = W / 2 - m.sizeMm[1] / 2
	if (hx < 0 || hy < 0) return `it needs a plate at least ${r1(m.sizeMm[0])} × ${r1(m.sizeMm[1])} mm`
	const parts = [Math.abs(m.xMm) > hx + 1e-9 && `xMm between ${r1(-hx)} and ${r1(hx)}`, Math.abs(m.yMm) > hy + 1e-9 && `yMm between ${r1(-hy)} and ${r1(hy)}`].filter(Boolean)
	return `on this plate its centre must have ${parts.join(" and ")} (now ${r1(m.xMm)}, ${r1(m.yMm)}), or make the plate longer or wider`
}

// The caster sits wheelbaseMm behind the axle (x = axleXMm − wheelbaseMm): its window is a wheelbase range.
export function casterWindow(m: { sizeMm: number[]; xMm: number; yMm: number }, L: number, W: number, d: { axleXMm: number; wheelbaseMm: number }): string {
	const hx = L / 2 - m.sizeMm[0] / 2
	if (hx < 0 || W / 2 - m.sizeMm[1] / 2 < 0) return `it needs a plate at least ${r1(m.sizeMm[0])} × ${r1(m.sizeMm[1])} mm`
	return `the caster sits at axleXMm − wheelbaseMm (${r1(d.axleXMm)} − ${r1(d.wheelbaseMm)}); on this plate wheelbaseMm must be between ${r1(Math.max(1, d.axleXMm - hx))} and ${r1(d.axleXMm + hx)} with axleXMm ${r1(d.axleXMm)}, or move the axle, or make the plate longer`
}

export function mechanicsCheckOver(motion: MotionTargets | undefined, mech: Mechanics | undefined, boards: { name: string; snapshot: ContractSnapshot }[], cat: CheckCatalog, figures: MechFigure[] = []): MechViolation[] {
	if (!motion) return []
	const out: MechViolation[] = []
	const push = (kind: MechViolation["kind"], message: string, affects: AgentRole[] = ["mechanics"], fields: FieldName[] = ALL) => out.push({ kind, message, fields, affects })
	if (!mech) return [{ kind: "mech-fit", message: "the brief asks for a robot (motion targets are set) but there is no mechanics design yet: choose motors, wheels, caster, battery and lay out the chassis", fields: ALL, affects: ["mechanics"] }]

	const d = mech.drive
	const motor = byMpn(cat.mech.motors, d.motor), wheel = byMpn(cat.mech.wheels, d.wheel), caster = byMpn(cat.mech.casters, d.caster), pack = byMpn(cat.mech.batteries, mech.battery.pack)
	for (const [what, mpn, found] of [["motor", d.motor, motor], ["wheel", d.wheel, wheel], ["caster", d.caster, caster], ["battery", mech.battery.pack, pack]] as const)
		if (!found) push("mech-fit", `${what} ${mpn} is not in catalog/mechanics.json: pick one listed there, so its numbers have a datasheet behind them`)
	if (!motor || !wheel || !caster || !pack) return out

	// Parts and pins over every board of the robot.
	const parts: Part[] = boards.flatMap((b) => b.snapshot.values.parts ?? [])
	const pins: Pin[] = boards.flatMap((b) => b.snapshot.values.pins ?? [])
	const data = (role: string) => {
		const p = parts.find((x) => x.role === role)
		return p ? { part: p, data: cat.boardParts.find((x) => x.mpn === p.mpn) } : null
	}
	const driver = data("motor-driver")
	const sensor = mech.sensor ? byMpn(cat.mech.sensors ?? [], mech.sensor.module) : undefined
	if (mech.sensor && !sensor) push("mech-fit", `sensor ${mech.sensor.module} is not in catalog/mechanics.json: pick one listed there`)

	const boardInfo = boards.map((b) => ({ name: b.name, outline: { widthMm: b.snapshot.values.outline?.widthMm ?? 0, heightMm: b.snapshot.values.outline?.heightMm ?? 0 } }))
	for (const b of mech.chassis.boards) if (!boards.some((x) => x.name === b.name)) push("mech-fit", `the chassis places board "${b.name}", which this design doesn't have (its boards: ${boards.map((x) => x.name).join(", ")}): place only the design's boards`)
	const ms: Mount[] = mounts(mech, boardInfo, cat.mech)
	const plateTop = mech.chassis.clearanceMm + mech.chassis.thicknessMm
	ms.push({ what: "payload", xMm: 0, yMm: 0, zMm: plateTop + 10, sizeMm: [20, 20, 20], massG: motion.payloadG })
	const { massG, com } = massAndCom(ms)
	const fig = (check: string, value: string, limit: string, ok: boolean, note?: string) => figures.push({ check, value, limit, ok, ...(note ? { note } : {}) })
	const massKg = massG / 1000
	const r = wheel.diameterMm / 2 / 1000
	const casterX = d.axleXMm - d.wheelbaseMm
	// Share of the weight on the drive wheels (moments about the caster).
	const onWheels = Math.min(1, Math.max(0, (com[0] - casterX) / (d.axleXMm - casterX)))
	const nominal = motorAt(motor, pack.nominalV)
	const full = motorAt(motor, pack.fullV)

	// Torque: each wheel lifts its share over the edge and overcomes rolling resistance, with margin.
	const perWheelKg = (massKg * onWheels) / 2
	const needN = edgeForceN(perWheelKg, r, motion.edgeMm / 1000) + (est("rollingCrr") * massKg * G) / 2
	const needNm = needN * r
	fig("Edge torque per wheel", `${r2(needNm * 1000)} mN·m`, `stall ${r2(nominal.stallNm * 1000)} mN·m ÷ ${TORQUE_MARGIN}`, nominal.stallNm >= TORQUE_MARGIN * needNm, `${motion.edgeMm} mm edge, ${Math.round(onWheels * 100)} % of ${Math.round(massG)} g on the wheels ${estNote("rollingCrr")}`)
	if (!(nominal.stallNm >= TORQUE_MARGIN * needNm))
		push("mech-torque", `to climb the ${motion.edgeMm} mm edge each wheel needs ${needNm === Infinity ? "more than any motor gives (the edge is at or above the axle)" : `${r2(needNm * 1000)} mN·m`}; ${d.motor} stalls at ${r2(nominal.stallNm * 1000)} mN·m at the cell's ${pack.nominalV} V, under the ${TORQUE_MARGIN}× margin (${massG.toFixed(0)} g, ${Math.round(onWheels * 100)} % on the wheels, ${estNote("rollingCrr")}): pick a higher gear ratio or bigger wheels, or lighten it`)

	// Climb, the caster: the drive wheels push it into the edge, which meets its wheel at height h. Lifting its load W
	// takes a push of W·√(r² − (r − h)²)/(r − h) (the edge's reaction along the line to the axle); the wheels push with at
	// most μ times their own load. The simulation found this one: a 38 mm caster under 41 % of a 255 g rover stalls at
	// a 10 mm step whatever the motors give.
	const cr = caster.wheelMm / 2, h = motion.edgeMm
	const casterShare = 1 - onWheels
	if (h >= cr) fig("Caster climb", `${Math.round(casterShare * 100)} % of the weight`, `edge under the caster's axle`, false)
	if (h >= cr) push("mech-climb", `the ${h} mm edge is at or above the caster's axle (${caster.wheelMm} mm wheel): no push lifts it over; pick a caster with a wheel over ${2 * h} mm`)
	else {
		const pushPerLoad = Math.sqrt(cr * cr - (cr - h) ** 2) / (cr - h)
		const maxShare = est("floorMu") / (est("floorMu") + CLIMB_MARGIN * pushPerLoad)
		fig("Caster climb", `${Math.round(casterShare * 100)} % of the weight`, `at most ${Math.round(maxShare * 100)} %`, casterShare <= maxShare, `${caster.wheelMm} mm caster, ${h} mm edge, ${CLIMB_MARGIN}× margin ${estNote("floorMu")}`)
		if (casterShare > maxShare)
			push("mech-climb", `the caster carries ${Math.round(casterShare * 100)} % of the weight; for the drive wheels to push its ${caster.wheelMm} mm wheel up the ${h} mm edge it may carry at most ${Math.round(maxShare * 100)} % (${CLIMB_MARGIN}× margin, ${estNote("floorMu")}): move weight (the battery) toward the axle, lengthen the wheelbase, or pick a bigger caster`)
	}

	// Top speed under load at the nominal voltage.
	const topMps = (nominal.noLoadRadS * SPEED_LOAD_DERATE) * r
	fig("Top speed", `${r2(topMps)} m/s`, `at least ${motion.speedMps} m/s`, topMps >= motion.speedMps, `loaded, ${SPEED_LOAD_DERATE} of no-load at ${pack.nominalV} V`)
	if (topMps < motion.speedMps)
		push("mech-speed", `${d.motor} on ${wheel.diameterMm} mm wheels reaches about ${r2(topMps)} m/s at ${pack.nominalV} V under load (${SPEED_LOAD_DERATE} of no-load), short of the ${motion.speedMps} m/s target: pick a lower gear ratio or bigger wheels`)

	// Stopping: braking distance plus one sensor period of travel must fit between the sensor's range and the wall
	// distance the brief allows.
	const rangeMm = sensor?.rangeMm ?? 0, updateMs = sensor?.updateMs ?? 0
	if (sensor && rangeMm > 0) {
		const decel = est("floorMu") * G * onWheels
		const brakeMm = ((motion.speedMps ** 2) / (2 * decel)) * 1000 + motion.speedMps * updateMs
		const roomMm = rangeMm - motion.stopBeforeWallMm
		fig("Stopping distance", `${r1(brakeMm)} mm`, `at most ${r1(roomMm)} mm`, brakeMm <= roomMm, `braking plus one ${updateMs} ms sensor period ${estNote("floorMu")}`)
		if (brakeMm > roomMm)
			push("mech-stopping", `from ${motion.speedMps} m/s the rover needs ${r1(brakeMm)} mm to stop (braking plus one ${updateMs} ms sensor period, ${estNote("floorMu")}), but the ${sensor.chip} sees ${rangeMm} mm and must stop ${motion.stopBeforeWallMm} mm from the wall, leaving ${r1(roomMm)} mm: slow down, or use a longer-range sensor`, ["mechanics", "architect"])
	}

	// Current: a motor at stall on a full cell, per driver channel and for the pack.
	if (driver?.data) {
		const peakA = Number(driver.data.peakA ?? 0)
		fig("Motor stall current", `${r2(full.stallA)} A`, `at most ${peakA} A per channel`, full.stallA <= peakA, `full ${pack.fullV} V cell, ${driver.part.mpn}`)
		if (full.stallA > peakA)
			push("mech-current", `${d.motor} draws ${r2(full.stallA)} A at stall on a full ${pack.fullV} V cell, over the ${driver.part.mpn}'s ${peakA} A peak per channel: pick a motor with a lower stall current or a stronger driver`, ["mechanics", "parts"])
		const supplyMin = Number(driver.data.supplyMinV ?? 0), supplyMax = Number(driver.data.supplyMaxV ?? Infinity)
		if (pack.cutoffV < supplyMin || pack.fullV > supplyMax)
			push("mech-voltage", `the ${driver.part.mpn} runs from ${supplyMin}–${supplyMax} V but the cell spans ${pack.cutoffV}–${pack.fullV} V: pick a driver that covers it`, ["mechanics", "parts"])
	}
	const boardMa = boards.reduce((t, b) => t + (b.snapshot.values.rails ?? []).reduce((s, rail) => s + ((rail as { averageMa?: number }).averageMa ?? rail.loadMa), 0), 0)
	const packNeedA = 2 * full.stallA + boardMa / 1000
	fig("Pack peak current", `${r2(packNeedA)} A`, `at most ${pack.peakA} A`, packNeedA <= pack.peakA, "both motors at stall plus the electronics")
	if (packNeedA > pack.peakA)
		push("mech-current", `both motors at stall plus the electronics draw ${r2(packNeedA)} A from a full cell, over the ${mech.battery.pack}'s ${pack.peakA} A peak: pick a pack rated higher or a gentler motor`)

	// Runtime at cruise: rolling resistance only (flat floors), plus the electronics.
	const rollNmPerWheel = (est("rollingCrr") * massKg * G * r) / 2
	const cruiseA = 2 * (motor.noLoadA + (nominal.kt > 0 ? rollNmPerWheel / nominal.kt : 0)) + boardMa / 1000
	const runtimeMin = ((pack.mAh / 1000) * USABLE_ENERGY) / cruiseA * 60
	fig("Runtime", `${Math.round(runtimeMin)} min`, `at least ${motion.runtimeMin} min`, runtimeMin >= motion.runtimeMin, `${r2(cruiseA)} A at cruise ${estNote("rollingCrr")}`)
	if (runtimeMin < motion.runtimeMin)
		push("mech-runtime", `${mech.battery.pack} (${pack.mAh} mAh, ${USABLE_ENERGY * 100} % usable) lasts about ${Math.round(runtimeMin)} min at cruise (${r2(cruiseA)} A: motors ${r2(cruiseA - boardMa / 1000)} A, electronics ${r2(boardMa / 1000)} A, ${estNote("rollingCrr")}), short of the ${motion.runtimeMin} min target: pick a bigger pack`)

	// Voltage: a full cell on the motor.
	const over = pack.fullV / motor.ratedV
	fig("Motor voltage", `${r2(over)}× rated`, `at most ${est("motorOvervoltMax")}×`, over <= est("motorOvervoltMax"), `full cell ${pack.fullV} V on a ${motor.ratedV} V motor ${estNote("motorOvervoltMax")}`)
	if (over > est("motorOvervoltMax"))
		push("mech-voltage", `a full cell puts ${pack.fullV} V on the ${motor.ratedV} V-rated ${d.motor}: ${r2(over)}× its rating, over ${est("motorOvervoltMax")}× ${estNote("motorOvervoltMax")}: pick a motor rated closer to the cell`)

	// Tipping: the centre of mass inside the support triangle with margin, still, braking and accelerating. The floor's
	// grip caps both: braking moves it forward by h·a/g, accelerating (or braking in reverse) back by as much, toward the
	// caster, where the triangle is narrowest.
	const poly = supportPolygon(mech, cat.mech)
	const decel = est("floorMu") * G * onWheels
	const still = insideMargin([com[0], com[1]], poly)
	const braking = insideMargin([com[0] + (com[2] * decel) / G, com[1]], poly)
	const accelerating = insideMargin([com[0] - (com[2] * decel) / G, com[1]], poly)
	const worst = Math.min(still, braking, accelerating)
	fig("Tipping margin", `${r1(worst)} mm`, `at least ${TIP_MARGIN_MM} mm`, worst >= TIP_MARGIN_MM, `centre of mass to the support triangle's edge, still, braking and accelerating ${estNote("floorMu")}`)
	if (worst < TIP_MARGIN_MM) {
		const when = worst === still ? "" : worst === braking ? "when braking hard " : "when accelerating hard (or braking in reverse) "
		const fix = worst === accelerating && worst < still ? "lengthen the wheelbase, or move weight (the battery) forward and down" : "lengthen the wheelbase, or move weight (the battery) back and down"
		push("mech-tipping", `the centre of mass (${r1(com[0])}, ${r1(com[1])}, ${r1(com[2])} mm) is ${r1(worst)} mm from the edge of the wheels-and-caster triangle ${when}(at least ${TIP_MARGIN_MM} mm needed, ${estNote("floorMu")}): ${fix}`)
	}

	// Fit: everything on the plate, nothing colliding, the plate level and above the edge, within the size and mass.
	const [L, Wd] = mech.chassis.plateMm
	const onPlate = (m: Mount) => mountOnPlate(m, L, Wd)
	for (const m of ms) if (m.what.startsWith("board:") || m.what === "battery" || m.what === "caster" || m.what === "sensor")
		if (!onPlate(m)) push("mech-fit", `${m.what.replace(/^board:/, "board ")} (${r1(m.sizeMm[0])} × ${r1(m.sizeMm[1])} mm at ${r1(m.xMm)}, ${r1(m.yMm)}) doesn't fit on the ${L} × ${Wd} mm plate: ${m.what === "caster" ? casterWindow(m, L, Wd, d) : fitWindow(m, L, Wd)}`)
	// A motor hangs under the plate's edge out to its wheel: at least half its body must be under the plate to bolt on.
	for (const m of ms.filter((x) => x.what.startsWith("motor:"))) {
		const under = motorUnderPlateMm(Wd, m)
		if (!motorHalfUnder(Wd, m)) push("mech-fit", `${m.what.replace(":", " ")} reaches only ${r1(Math.max(0, under))} mm under the plate (half its ${m.sizeMm[1]} mm body needed for the bracket): widen the plate or narrow the track`)
	}
	const boardsM = ms.filter((m) => m.what.startsWith("board:"))
	for (let i = 0; i < boardsM.length; i++)
		for (let j = i + 1; j < boardsM.length; j++) {
			const a = boardsM[i], b = boardsM[j]
			if (Math.abs(a.xMm - b.xMm) < (a.sizeMm[0] + b.sizeMm[0]) / 2 && Math.abs(a.yMm - b.yMm) < (a.sizeMm[1] + b.sizeMm[1]) / 2)
				push("mech-fit", `${a.what.slice(6)} and ${b.what.slice(6)} overlap on the chassis: move one`)
		}
	if (pack.sizeMm[2] > est("standoffMm") - 1 && boardsM.length)
		push("mech-fit", `the ${pack.sizeMm[2]} mm-thick battery doesn't fit under boards on ${est("standoffMm")} mm standoffs ${estNote("standoffMm")}: pick a thinner pack or put it beside the boards`)
	const wheelInner = d.trackMm / 2 - wheel.widthMm / 2
	if (wheelsRubPlate(Wd, d.trackMm, wheel.widthMm)) push("mech-fit", `the wheels' inner faces (${r1(wheelInner)} mm from the centre) rub the ${Wd} mm-wide plate (2 mm clearance needed): make trackMm at least ${r1(Wd + 4 + wheel.widthMm)} (the plate's width + 4 + the ${wheel.widthMm} mm wheel), or the plate at most ${r1(plateMaxWidthMm(d.trackMm, wheel.widthMm))} mm wide`)
	// Level: the caster sets the plate's height; the motors hang from it on brackets, at least half their body below
	// it (they can drop lower on a spacer, not rise into the plate).
	const axleLevel = wheel.diameterMm / 2 + motor.bodyMm[2] / 2
	if (mech.chassis.clearanceMm < axleLevel - LEVEL_TOLERANCE_MM || Math.abs(caster.heightMm - mech.chassis.clearanceMm) > LEVEL_TOLERANCE_MM)
		push("mech-fit", `the plate isn't level: its underside is ${mech.chassis.clearanceMm} mm up, the motors need at least ${r1(axleLevel)} mm and the ${d.caster} holds it at ${caster.heightMm} mm (within ${LEVEL_TOLERANCE_MM} mm): set the clearance to the caster's height, or pick a caster that matches`)
	// The sensor looks forward: nothing may stand in front of it across its width.
	const sm = ms.find((m) => m.what === "sensor")
	if (sm) for (const m of ms) if (m !== sm && !m.what.startsWith("wheel:") && blocksSensor(m, sm))
		push("mech-fit", `${m.what.replace(":", " ")} stands in front of the distance sensor: move the sensor to the front edge`)
	if (mech.chassis.clearanceMm < motion.edgeMm)
		push("mech-fit", `the plate is ${mech.chassis.clearanceMm} mm off the floor, under the ${motion.edgeMm} mm edge the rover must cross: raise it (bigger wheels)`)
	const outerW = Math.max(Wd, d.trackMm + wheel.widthMm)
	if (L > motion.maxSizeMm[0] || outerW > motion.maxSizeMm[1])
		push("mech-fit", `the rover is ${L} × ${outerW} mm with its wheels, over the ${motion.maxSizeMm[0]} × ${motion.maxSizeMm[1]} mm the brief allows: the plate at most ${motion.maxSizeMm[0]} mm long, trackMm at most ${r1(motion.maxSizeMm[1] - wheel.widthMm)} (the width less one ${wheel.widthMm} mm wheel), so the plate at most ${r1(motion.maxSizeMm[1] - 2 * wheel.widthMm - 4)} mm wide`)
	fig("Mass", `${Math.round(massG)} g`, `at most ${motion.maxMassG} g`, massG <= motion.maxMassG, `plate PLA ${estNote("plaDensityGcm3")}, boards ${estNote("boardMassGPerCm2")}`)
	fig("Size with wheels", `${L} × ${outerW} mm`, `at most ${motion.maxSizeMm[0]} × ${motion.maxSizeMm[1]} mm`, L <= motion.maxSizeMm[0] && outerW <= motion.maxSizeMm[1])
	if (massG > motion.maxMassG) push("mech-fit", `the rover weighs about ${Math.round(massG)} g, over the ${motion.maxMassG} g the brief allows`)

	// Wiring: a driver with its inputs on GPIOs, the sensor on the I2C bus, a battery connector.
	if (!driver) push("mech-wiring", "no board carries a motor driver (role motor-driver): add one with its four inputs on GPIOs", ["parts"], ["parts"])
	else {
		const missing = ["MOT_AIN1", "MOT_AIN2", "MOT_BIN1", "MOT_BIN2"].filter((s) => !pins.some((p) => p.signal === s && p.partRef === driver.part.ref))
		if (missing.length) push("mech-wiring", `the motor driver ${driver.part.ref}'s inputs ${missing.join(", ")} have no GPIO: assign them`, ["architect"], ["pins"])
	}
	// A motor on a GPIO: the pin can't source a motor's current and the motor's back-EMF reaches the MCU (real rover run
	// 2, 15 Nov: the architect put MOTOR_A_P on GPIO0 through a 2-pin connector, with no driver). The board generator
	// wires the driver's outputs to the 2-pin motor connectors; the pins field never touches them.
	const motorPlugs = new Set(parts.filter((p) => p.role === "connector" && p.pins.length === 2 && p.pins[0] === "1" && p.pins[1] === "2").map((p) => p.ref))
	const onMotor = pins.filter((p) => motorPlugs.has(p.partRef) && typeof p.gpio === "number" && p.gpio >= 0)
	if (onMotor.length)
		push("mech-wiring", `${onMotor.map((p) => `${p.signal} (GPIO${p.gpio}) goes to motor connector ${p.partRef}`).join("; ")}: a motor never connects to a GPIO. Remove these pins: the board generator wires the motor driver's outputs to the 2-pin motor connectors, and the GPIOs drive the driver's inputs MOT_AIN1, MOT_AIN2, MOT_BIN1, MOT_BIN2`, ["architect"], ["pins"])
	// Each motor's two wires need a 2-pin connector on the driver's outputs (real rover run 5, 15 Nov: nothing asked for
	// them, so the motors were never connected). The generator wires the driver's AOUT/BOUT to them, in ref order.
	if (driver && motorPlugs.size < 2) {
		// The refs to use: header connectors the board already places with no part (the architect named them), then JM1, JM2.
		const partRefs = new Set(parts.map((p) => p.ref))
		const placed = boards.flatMap((b) => b.snapshot.values.connectors ?? []).filter((k) => k.kind === "header" && !partRefs.has(k.ref) && k.ref !== mech.sensor?.connector).map((k) => k.ref)
		const refs = [...placed, ...["JM1", "JM2"].filter((r) => !partRefs.has(r) && !placed.includes(r))].slice(0, 2 - motorPlugs.size)
		push("mech-wiring", `the motors need ${2 - motorPlugs.size} more 2-pin connector${motorPlugs.size === 1 ? "" : "s"} (role connector, pins ["1", "2"], the JST PH B2B-PH-K-S in the catalog), one per motor, as ${refs.join(" and ")}${placed.length ? " (the connectors the board already places)" : ""}: the board generator wires the driver's outputs to them`, ["parts"], ["parts"])
	}
	const plug = mech.sensor ? parts.find((p) => p.ref === mech.sensor.connector && p.role === "connector" && p.pins.length === 4) : undefined
	// The sensor's connector ref taken by another part (real rover run 5: "J2", the battery connector): no part can be
	// added under it, so the ref itself is what to change.
	const taken = mech.sensor ? parts.find((p) => p.ref === mech.sensor.connector && !(p.role === "connector" && p.pins.length === 4)) : undefined
	if (!mech.sensor) push("mech-wiring", "no distance sensor in the mechanics design: the rover avoids walls with one at the front", ["mechanics"])
	else if (taken) push("mech-wiring", `mechanics.sensor.connector is ${taken.ref}, but ${taken.ref} is already the ${taken.role} ${taken.mpn}: name a free ref for the sensor's 4-pin connector (JT1)`, ["mechanics"], ["mechanics"])
	else if (!plug) push("mech-wiring", `the distance sensor's cable needs a 4-pin connector ${mech.sensor.connector} (role connector, JST SH) on a board: add it`, ["parts"], ["parts"])
	// The board generator joins the plug's IO1/IO2 to the bus (linkBusTraces): the bus must exist on its board.
	else if (!["I2C_SDA", "I2C_SCL"].every((sig) => boards.some((b) => (b.snapshot.values.parts ?? []).some((p) => p.ref === plug.ref) && (b.snapshot.values.pins ?? []).some((p) => p.signal === sig))))
		push("mech-wiring", `the sensor connector ${plug.ref} needs an I2C bus on its board: assign I2C_SDA and I2C_SCL`, ["architect"], ["pins"])
	if (!parts.some((p) => p.role === "battery")) push("mech-wiring", "no battery connector on any board: the cell needs one", ["parts"], ["parts"])
	return out
}
