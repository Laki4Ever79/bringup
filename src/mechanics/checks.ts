import { existsSync } from "node:fs"
import { isEncoderPlug, isMotorPlug } from "./refs.ts"
import { loadRules, RULE_SETS, ruleChecks, type RuleSet } from "../rules/eurobot.ts"
import { safetyChecks, startChecks } from "./safety.ts"
import { resolve } from "node:path"
import type { AgentRole, ContractSnapshot, FieldName, Part, PinAssignment as Pin } from "../contract/types.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import { plateLimitForBrief, blocksSensor, motorHalfUnder, motorUnderPlateMm, mountOnPlate, plateMaxWidthMm, wheelsRubPlate } from "../dashboard/assembly-geom.js"
import { checkBoards, withAssembly } from "./assembly.ts"
import { byMpn, loadMechCatalog, type MechCatalog } from "./catalog.ts"
import { est, estNote } from "./estimates.ts"
import { brakeDecel, brakeMm, drivenDecel, cruiseDuty, edgeForceN, G, loadedSpeedMps, massAndCom, MIN_CRUISE_DUTY, motorAt, mounts, onWheelsShare, payloadMount, supportPolygon, TURN_CLEARANCE_MM, turnStopMm, turnSweepMm } from "./model.ts"
import type { Mechanics, Mount, MotionTargets } from "./types.ts"
import { driveTrainChecks } from "./drivetrain.ts"
import { field, moduleById } from "../system/bought.ts"

// The plain-code mechanics checks: free, instant, run on every contract change. Each states its numbers, the limit,
// the margin and what to change; any estimate it leans on is named "(estimate: <name> <value>)". They never assume
// which board carries the motor driver: mechanicsCheckOver takes every board of the robot (option B, a driver board,
// runs the same checks).

export type MechViolation = {
	kind: "mech-torque" | "mech-speed" | "mech-stopping" | "mech-current" | "mech-runtime" | "mech-voltage" | "mech-tipping" | "mech-climb" | "mech-fit" | "mech-wiring" | "mech-hw-layer" | "mech-drive" | "mech-mate" | "mech-safety" | "mech-rules"
	message: string
	fields: FieldName[]
	affects: AgentRole[]
	// The datasheet numbers the check used, each with where it was read (catalog/mechanics.json's source).
	sources?: Source[]
}

// One catalog number and where it comes from: the datasheet or seller's spec table, and the place on it.
export type Source = { mpn: string; field: string; url: string; where: string }

// Board parts with the numbers the checks read (catalog/parts.json entries carry extra keys).
export type BoardPartData = { mpn: string; role?: string; [k: string]: unknown }
export interface CheckCatalog {
	mech: MechCatalog
	boardParts: BoardPartData[]
	// Competition rule sets by id (catalog/rules), checked when motion.rules names one (rules/eurobot.ts).
	rules?: Record<string, RuleSet>
}

export const TORQUE_MARGIN = 1.5
export const USABLE_ENERGY = 0.85 // of the pack's rated Wh, before the cut-off
export const TIP_MARGIN_MM = 10
export const CLIMB_MARGIN = 1.2 // the drive wheels' grip must push the caster up the edge with this margin (static; the simulation from rest climbs a little more, docs/mechanics.md)
export const LEVEL_TOLERANCE_MM = 3 // caster and wheels must hold the plate level within this

const ROOT = resolve(import.meta.dirname, "../..")
let cached: CheckCatalog | null = null
export function defaultCheckCatalog(): CheckCatalog | null {
	if (cached) return cached
	if (!existsSync(resolve(ROOT, "catalog/mechanics.json"))) return null
	cached = { mech: loadMechCatalog(ROOT), boardParts: loadCatalog(ROOT) as unknown as BoardPartData[], rules: Object.fromEntries(RULE_SETS.flatMap((id) => ((r) => (r ? [[id, r]] : []))(loadRules(ROOT, id)))) }
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
	sources?: Source[]
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
	// One formula with the Top-view editor's (src/dashboard/assembly-geom.js), so the editor and the checks agree.
	return plateLimitForBrief(max, wheel?.widthMm) as [number, number]
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

// A board's 4-pin connector that no link uses and that isn't the sensor's named one: the sensor's plug under another ref.
function spare4Pin(boards: { snapshot: ContractSnapshot }[], named: string): string | undefined {
	for (const b of boards) {
		const v = b.snapshot.values
		const links = new Set((v.links ?? []).map((l) => l.connector))
		const p = (v.parts ?? []).find((x) => x.role === "connector" && x.pins.length === 4 && x.ref !== named && !links.has(x.ref))
		if (p) return p.ref
	}
	return undefined
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

// Which catalog numbers each check reads, by violation kind and by figure name: every finding and figure shows them with
// their datasheet source (the module library's item 5, 15 Nov: "stall current 0.67 A, Pololu specs table @ 6 V").
type PartKey = "motor" | "wheel" | "caster" | "pack" | "sensor"
const MASSES: [PartKey, string[]][] = [["motor", ["massG"]], ["wheel", ["massG"]], ["caster", ["massG"]], ["pack", ["massG"]], ["sensor", ["massG"]]]
const USES: Record<string, [PartKey, string[]][]> = {
	"mech-torque": [["motor", ["stallTorqueNm", "ratedV"]], ["wheel", ["diameterMm"]], ["pack", ["nominalV"]], ...MASSES],
	"Edge torque per wheel": [["motor", ["stallTorqueNm", "ratedV"]], ["wheel", ["diameterMm"]], ["pack", ["nominalV"]], ...MASSES],
	"mech-climb": [["caster", ["wheelMm"]], ...MASSES],
	"Caster climb": [["caster", ["wheelMm"]], ...MASSES],
	"mech-speed": [["motor", ["noLoadRpm", "stallTorqueNm", "stallA", "ratedV"]], ["wheel", ["diameterMm"]], ["pack", ["nominalV", "fullV"]], ...MASSES],
	"Top speed": [["motor", ["noLoadRpm", "stallTorqueNm", "stallA", "ratedV"]], ["wheel", ["diameterMm"]], ["pack", ["nominalV"]], ...MASSES],
	"Cruise duty": [["motor", ["noLoadRpm", "stallTorqueNm", "stallA", "ratedV"]], ["wheel", ["diameterMm"]], ["pack", ["fullV"]], ...MASSES],
	"mech-stopping": [["sensor", ["rangeMm", "updateMs"]]],
	"Stopping distance": [["sensor", ["rangeMm", "updateMs"]]],
	"Turn clearance": [["sensor", ["rangeMm"]], ["wheel", ["diameterMm", "widthMm"]]],
	"mech-current": [["motor", ["stallA", "ratedV"]], ["pack", ["fullV", "peakA"]]],
	"Motor stall current": [["motor", ["stallA", "ratedV"]], ["pack", ["fullV"]]],
	"Pack peak current": [["motor", ["stallA", "ratedV"]], ["pack", ["fullV", "peakA"]]],
	"mech-voltage": [["motor", ["ratedV"]], ["pack", ["fullV", "cutoffV"]]],
	"Motor voltage": [["motor", ["ratedV"]], ["pack", ["fullV"]]],
	"mech-runtime": [["pack", ["mAh", "nominalV"]], ["motor", ["noLoadA", "stallA"]]],
	"Runtime": [["pack", ["mAh", "nominalV"]], ["motor", ["noLoadA", "stallA"]]],
	"mech-tipping": [["caster", ["heightMm"]], ...MASSES],
	"Tipping margin": [["caster", ["heightMm"]], ...MASSES],
	"Mass": MASSES,
	"Size with wheels": [["wheel", ["widthMm"]]],
}

function sourcesFor(key: string, parts: Partial<Record<PartKey, { mpn: string; source: Record<string, { url: string; where: string }> }>>): Source[] {
	const out: Source[] = []
	for (const [k, fields] of USES[key] ?? []) {
		const p = parts[k]
		if (!p) continue
		for (const f of fields) if (p.source?.[f]) out.push({ mpn: p.mpn, field: f, url: p.source[f].url, where: p.source[f].where })
	}
	return out
}

export function mechanicsCheckOver(motion: MotionTargets | undefined, mech: Mechanics | undefined, boards: { name: string; snapshot: ContractSnapshot }[], cat: CheckCatalog, figures: MechFigure[] = []): MechViolation[] {
	const first = figures.length
	const out = mechanicsCheckOverRaw(motion, mech, boards, cat, figures)
	if (!mech) return out
	const parts = {
		motor: byMpn(cat.mech.motors, mech.drive.motor),
		wheel: byMpn(cat.mech.wheels, mech.drive.wheel),
		caster: byMpn(cat.mech.casters, mech.drive.caster),
		pack: byMpn(cat.mech.batteries, mech.battery.pack),
		sensor: mech.sensor ? byMpn(cat.mech.sensors ?? [], mech.sensor.module) : undefined,
	}
	for (const v of out) {
		const s = sourcesFor(v.kind, parts)
		if (s.length) v.sources = s
	}
	for (const f of figures.slice(first)) {
		const s = sourcesFor(f.check, parts)
		if (s.length) f.sources = s
	}
	return out
}

// A bought computer's typical draw (compute.currentA.typical at compute.inputV.nom, its record) as current from the pack:
// through the mechanics' 5 V regulator's efficiency (catalog/mechanics.json regulators) at the pack's nominal voltage.
// A module without a typical figure counts nothing and says so; a regulator not chosen uses ASSUMED_REGULATOR_EFFICIENCY.
export const ASSUMED_REGULATOR_EFFICIENCY = 0.85 // ESTIMATE: a synchronous buck at a few amps
export function boughtComputeA(mech: Mechanics, pack: { nominalV: number; mpn: string }, cat: CheckCatalog): { amps: number; how: string } {
	const regMpn = (mech as Mechanics & { regulator?: string }).regulator
	const reg = regMpn ? byMpn(cat.mech.regulators ?? [], regMpn) : undefined
	const eff = reg?.efficiency ?? ASSUMED_REGULATOR_EFFICIENCY
	let amps = 0
	const how: string[] = []
	for (const b of mech.chassis?.boards ?? []) {
		const m = b.module ? moduleById(b.module) : undefined
		if (!m) continue
		const typ = field<number>(m, "currentA.typical")?.value, v = field<{ nom: number }>(m, "inputV")?.value?.nom
		if (typeof typ !== "number" || typeof v !== "number") { how.push(`${b.name} (${m.id}): no typical current in its record, not counted`); continue }
		const fromPack = (typ * v) / eff / pack.nominalV
		amps += fromPack
		how.push(`${b.name} (${m.id}) ${typ} A at ${v} V typical, through ${reg ? reg.mpn : "a 5 V regulator"} at ${Math.round(eff * 100)} %${reg ? "" : " (ESTIMATE)"}, ${pack.nominalV} V nominal: ${Math.round(fromPack * 100) / 100} A`)
	}
	return { amps, how: how.join("; ") }
}

function mechanicsCheckOverRaw(motion: MotionTargets | undefined, mech: Mechanics | undefined, boards: { name: string; snapshot: ContractSnapshot }[], cat: CheckCatalog, figures: MechFigure[] = []): MechViolation[] {
	if (!motion) return []
	const out: MechViolation[] = []
	const push = (kind: MechViolation["kind"], message: string, affects: AgentRole[] = ["mechanics"], fields: FieldName[] = ALL) => out.push({ kind, message, fields, affects })
	if (!mech) return [{ kind: "mech-fit", message: "the brief asks for a robot (motion targets are set) but there is no mechanics design yet: choose motors, wheels, caster, battery and lay out the chassis", fields: ALL, affects: ["mechanics"] }]

	// Every bought drive-train part fits what it mates with (drivetrain.ts), whatever else the design lacks.
	for (const v of driveTrainChecks(mech.driveTrain ?? [])) push("mech-mate", v.message)

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
	ms.push(payloadMount(mech, motion.payloadG))
	const { massG, com } = massAndCom(ms)
	const fig = (check: string, value: string, limit: string, ok: boolean, note?: string) => figures.push({ check, value, limit, ok, ...(note ? { note } : {}) })
	const massKg = massG / 1000
	const r = wheel.diameterMm / 2 / 1000
	// Share of the weight on the drive wheels (moments about the caster).
	const onWheels = onWheelsShare(d, com[0])
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
	// most μ times their own load. A static bound, for a rover with no momentum (stopped on the edge, or starting against
	// it). Re-measured 15 Nov with the caster at its own friction (docs/mechanics.md, "What the simulation found"): from
	// rest a 38 mm caster climbs 10 mm under up to about 28 % of the weight (this limit: 21 %), 5 mm under about 50 %
	// (35 %), 3 mm under about 70 % (44 %); at cruise momentum carries much more, which the check doesn't count on.
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

	// Top speed: full duty on the motor's load line (model.ts loadedSpeedMps, the model the firmware's cruise duty comes
	// from) at the pack's nominal voltage, the plateau it spends most of its charge on: the speed it can still hold there.
	const topMps = loadedSpeedMps(motor, pack, pack.nominalV, 1, massKg, r)
	fig("Top speed", `${r2(topMps)} m/s`, `at least ${motion.speedMps} m/s`, topMps >= motion.speedMps, `full duty on the load line at ${pack.nominalV} V, ${Math.round(massG)} g rolling ${estNote("rollingCrr")}`)
	if (topMps < motion.speedMps)
		push("mech-speed", `${d.motor} on ${wheel.diameterMm} mm wheels reaches about ${r2(topMps)} m/s at full duty from ${pack.nominalV} V (its load line with ${Math.round(massG)} g rolling, ${estNote("rollingCrr")}), short of the ${motion.speedMps} m/s target: pick a lower gear ratio or bigger wheels`)

	// Cruise duty: what the firmware drives at (firmware.ts, the same cruiseDuty). A motor geared far faster than the
	// target cruises at a sliver of its duty; the firmware used to raise it silently to the floor, overshooting the speed.
	const duty = cruiseDuty(motor, pack, motion.speedMps, massKg, r)
	if (duty <= 1) {
		fig("Cruise duty", `${r2(duty)}`, `at least ${MIN_CRUISE_DUTY}`, duty >= MIN_CRUISE_DUTY, `${motion.speedMps} m/s on the load line from a full ${pack.fullV} V pack ${estNote("rollingCrr")}`)
		if (duty < MIN_CRUISE_DUTY)
			push("mech-speed", `${d.motor} on ${wheel.diameterMm} mm wheels holds ${motion.speedMps} m/s at only ${r2(duty)} duty from a full ${pack.fullV} V pack (at least ${MIN_CRUISE_DUTY} wanted): it is geared about ${r1(MIN_CRUISE_DUTY / duty)}× too fast, with little torque in hand at that duty; pick a higher gear ratio or smaller wheels`)
	}

	// Stopping: braking distance plus one sensor period of travel must fit between the sensor's range and the wall
	// distance the brief allows.
	const rangeMm = sensor?.rangeMm ?? 0, updateMs = sensor?.updateMs ?? 0
	if (sensor && rangeMm > 0) {
		const stopMm = brakeMm(motion.speedMps, onWheels, d.maxAccelMps2) + motion.speedMps * updateMs
		const roomMm = rangeMm - motion.stopBeforeWallMm
		fig("Stopping distance", `${r1(stopMm)} mm`, `at most ${r1(roomMm)} mm`, stopMm <= roomMm, `braking on the wheels' ${Math.round(onWheels * 100)} % of the weight plus one ${updateMs} ms sensor period ${estNote("floorMu")} ${estNote("casterMu")}`)
		if (stopMm > roomMm)
			push("mech-stopping", `from ${motion.speedMps} m/s the rover needs ${r1(stopMm)} mm to stop (braking on the wheels' ${Math.round(onWheels * 100)} % of the weight plus one ${updateMs} ms sensor period, ${estNote("floorMu")} ${estNote("casterMu")}), but the ${sensor.chip} sees ${rangeMm} mm and must stop ${motion.stopBeforeWallMm} mm from the wall, leaving ${r1(roomMm)} mm: slow down, or use a longer-range sensor`, ["mechanics", "architect"])
	}

	// Turning in place: the firmware turns where it stops, so it stops where its sweep clears the wall (model.ts
	// turnStopMm, the firmware's own stop): that reading must be within the sensor's range.
	if (sensor && rangeMm > 0 && mech.sensor) {
		const turnMm = turnStopMm(mech, wheel)
		fig("Turn clearance", `${r1(turnMm)} mm`, `at most ${rangeMm} mm`, turnMm <= rangeMm, `turns in place from this reading: a ${r1(turnSweepMm(mech, wheel))} mm sweep about the axle plus ${TURN_CLEARANCE_MM} mm, less the sensor's ${r1(mech.sensor.at.xMm - d.axleXMm)} mm ahead of the axle`)
		if (turnMm > rangeMm)
			push("mech-stopping", `turning in place, the rover sweeps ${r1(turnSweepMm(mech, wheel))} mm about its axle, so it must start turning ${r1(turnMm)} mm from the wall, beyond the ${sensor.chip}'s ${rangeMm} mm range: move the axle toward the plate's middle, shorten the plate, or use a longer-range sensor`)
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
	// The designed boards' rails the cell feeds, plus each bought computer's typical draw (its record) through the 5 V
	// regulator, as pack current at the nominal voltage (before, a Pi 5's 0.8 A at 5.1 V was left out of the runtime
	// altogether). Not VBUS (USB feeds it, not the cell) and not the cell's own rail (VBAT), whose load on a robot is the
	// motor driver plus those same rails (rover run cc-rover-5 on the Claude subscription, 15 Nov 2026: VBUS 300 + VBAT
	// 1400 + 3V3 190 mA counted 1.89 A of "electronics", the motors twice, so no catalog motor fit the 2 A cell).
	const computeA = boughtComputeA(mech, pack, cat)
	const boardMa = boards.reduce((t, b) => t + cellFedElectronics(b.snapshot.values.rails ?? []).reduce((s, rail) => s + ((rail as { averageMa?: number }).averageMa ?? rail.loadMa), 0), 0) + computeA.amps * 1000
	if (computeA.amps > 0) fig("Computer draw", `${r2(computeA.amps)} A`, "from the pack", true, computeA.how)
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
	const decel = drivenDecel(onWheels, d.maxAccelMps2)
	const still = insideMargin([com[0], com[1]], poly)
	const braking = insideMargin([com[0] + (com[2] * decel) / G, com[1]], poly)
	const accelerating = insideMargin([com[0] - (com[2] * decel) / G, com[1]], poly)
	const worst = Math.min(still, braking, accelerating)
	fig("Tipping margin", `${r1(worst)} mm`, `at least ${TIP_MARGIN_MM} mm`, worst >= TIP_MARGIN_MM, `centre of mass to the support triangle's edge, still, braking and accelerating ${d.maxAccelMps2 && d.maxAccelMps2 < brakeDecel(onWheels) ? `at the firmware's ${d.maxAccelMps2} m/s² ramp` : estNote("floorMu")}`)
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
	// A HAT and the board it sits on stack on the same holes: not an overlap.
	const stacked = (p: string, q: string) => mech.chassis.boards.some((x) => (x.name === p && x.on === q) || (x.name === q && x.on === p))
	for (let i = 0; i < boardsM.length; i++)
		for (let j = i + 1; j < boardsM.length; j++) {
			const a = boardsM[i], b = boardsM[j]
			if (stacked(a.what.slice(6), b.what.slice(6))) continue
			if (Math.abs(a.xMm - b.xMm) < (a.sizeMm[0] + b.sizeMm[0]) / 2 && Math.abs(a.yMm - b.yMm) < (a.sizeMm[1] + b.sizeMm[1]) / 2)
				push("mech-fit", `${a.what.slice(6)} and ${b.what.slice(6)} overlap on the chassis: move one`)
		}
	// Only the boards above the pack matter: one beside every board needs no headroom (the rover-pi run, 15 Nov: a 2S
	// pack 18 mm thick was refused on any plate with a board, so "put it beside the boards" could never be followed).
	const packM = ms.find((m) => m.what === "battery")
	const packUnder = packM ? boardsM.filter((b) => Math.abs(b.xMm - packM.xMm) < (b.sizeMm[0] + packM.sizeMm[0]) / 2 && Math.abs(b.yMm - packM.yMm) < (b.sizeMm[1] + packM.sizeMm[1]) / 2) : []
	if (pack.sizeMm[2] > est("standoffMm") - 1 && packUnder.length)
		push("mech-fit", `the ${pack.sizeMm[2]} mm-thick battery doesn't fit under boards on ${est("standoffMm")} mm standoffs ${estNote("standoffMm")} (it lies under ${packUnder.map((b) => b.what.slice(6)).join(", ")}): pick a thinner pack or put it beside the boards`)
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
	const motorPlugs = new Set(parts.filter(isMotorPlug).map((p) => p.ref))
	// (An encoder gearmotor's plug carries its encoder's A and B to GPIOs: only its motor pins never go to one.)
	const onMotor = pins.filter((p) => motorPlugs.has(p.partRef) && typeof p.gpio === "number" && p.gpio >= 0 && !["ENCA", "ENCB"].includes(p.partPin))
	if (onMotor.length)
		push("mech-wiring", `${onMotor.map((p) => `${p.signal} (GPIO${p.gpio}) goes to motor connector ${p.partRef}`).join("; ")}: a motor never connects to a GPIO. Remove these pins: the board generator wires the motor driver's outputs to the motor plugs' motor pins (1/2, or M1/M2 on an encoder plug), and the GPIOs drive the driver's inputs MOT_AIN1, MOT_AIN2, MOT_BIN1, MOT_BIN2`, ["architect"], ["pins"])
	// Each motor's two wires need a 2-pin connector on the driver's outputs (real rover run 5, 15 Nov: nothing asked for
	// them, so the motors were never connected). The generator wires the driver's AOUT/BOUT to them, in ref order.
	if (driver && motorPlugs.size < 2) {
		// The refs to use: header connectors the board already places with no part (the architect named them), then JM1, JM2.
		const partRefs = new Set(parts.map((p) => p.ref))
		const placed = boards.flatMap((b) => b.snapshot.values.connectors ?? []).filter((k) => k.kind === "header" && !partRefs.has(k.ref) && k.ref !== mech.sensor?.connector).map((k) => k.ref)
		const refs = [...placed, ...["JM1", "JM2"].filter((r) => !partRefs.has(r) && !placed.includes(r))].slice(0, 2 - motorPlugs.size)
		const plug = motor.encoder ? `6-pin connector${motorPlugs.size === 1 ? "" : "s"} (role connector, the JST SH SM06B-SRSS-TB(LF)(SN) in the catalog, pins ["GND", "ENCB", "ENCA", "VCC", "M2", "M1"]: the ${motor.mpn.split(" ")[0]} carries an encoder)` : `2-pin connector${motorPlugs.size === 1 ? "" : "s"} (role connector, pins ["1", "2"], the JST PH B2B-PH-K-S in the catalog)`
		push("mech-wiring", `the motors need ${2 - motorPlugs.size} more ${plug}, one per motor, as ${refs.join(" and ")}${placed.length ? " (the connectors the board already places)" : ""}: the board generator wires the driver's outputs to them`, ["parts"], ["parts"])
	}
	// An encoder gearmotor (catalog encoder): its plugs are the 6-pin ones, and each encoder's channel A reaches a GPIO
	// (ENC_LA on JM1, the left motor; ENC_RA on JM2), whose edges the firmware counts for odometry (rover.h; channel B
	// stays unconnected: the direction is the duty's).
	if (motor.encoder) {
		const plain = parts.filter((p) => isMotorPlug(p) && !isEncoderPlug(p))
		if (plain.length) push("mech-wiring", `${plain.map((p) => p.ref).join(" and ")} ${plain.length === 1 ? "is a 2-pin plug" : "are 2-pin plugs"}, but the ${motor.mpn.split(" ")[0]} carries an encoder on a 6-pin JST SH plug: make ${plain.length === 1 ? "it" : "them"} the SM06B-SRSS-TB(LF)(SN) in the catalog (pins ["GND", "ENCB", "ENCA", "VCC", "M2", "M1"]), keeping the refs`, ["parts"], ["parts"])
		const enc = parts.filter(isEncoderPlug).sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true })).slice(0, 2)
		const missing = enc.flatMap((k, i) => (["A"] as const).map((ch) => ({ k, ch, signal: `ENC_${"LR"[i]}${ch}` }))).filter(({ k, ch, signal }) => !pins.some((p) => p.signal === signal && p.partRef === k.ref && p.partPin === `ENC${ch}` && typeof p.gpio === "number" && p.gpio >= 0))
		if (missing.length) push("mech-wiring", `the encoders' outputs need GPIOs: ${missing.map(({ k, ch, signal }) => `${signal} (partRef ${k.ref}, partPin ENC${ch})`).join(", ")}; the firmware counts them for odometry (the encoders pull up their own outputs)`, ["architect"], ["pins"])
	}
	const plug = mech.sensor ? parts.find((p) => p.ref === mech.sensor.connector && p.role === "connector" && p.pins.length === 4) : undefined
	// The sensor's connector ref taken by another part (real rover run 5: "J2", the battery connector): no part can be
	// added under it, so the ref itself is what to change.
	const taken = mech.sensor ? parts.find((p) => p.ref === mech.sensor.connector && !(p.role === "connector" && p.pins.length === 4)) : undefined
	if (!mech.sensor) push("mech-wiring", "no distance sensor in the mechanics design: the rover avoids walls with one at the front", ["mechanics"])
	else if (taken) push("mech-wiring", `mechanics.sensor.connector is ${taken.ref}, but ${taken.ref} is already the ${taken.role} ${taken.mpn}: name a free ref for the sensor's 4-pin connector (JT1)`, ["mechanics"], ["mechanics"])
	// A 4-pin connector the boards already have under another ref, serving no link: the mechanics points at it (one field)
	// instead of the parts agent adding a second one (real rover run 10, 15 Nov: J5 and JT1 were added and removed in
	// turn for 20 revisions, each a "duplicate" of the other).
	// The plug's name converges on the mechanics' (JT1 from the layout solver), never the other way: pointing the mechanics
	// at the board's name made the solver's next layout flip it back (real rover run 3 on the Claude subscription, 15 Nov:
	// JT1 and J5 swapped six times). So the parts agent and the architect rename their plug, keeping it the only one.
	else if (!plug && spare4Pin(boards, mech.sensor.connector)) push("mech-wiring", `the board's 4-pin connector ${spare4Pin(boards, mech.sensor.connector)} is the distance sensor's plug: rename it ${mech.sensor.connector} (mechanics.sensor.connector) in parts and in connectors, and keep only that one (don't add a second)`, ["parts", "architect"], ["parts", "connectors"])
	else if (!plug) push("mech-wiring", `the distance sensor's cable needs a 4-pin connector ${mech.sensor.connector} (role connector, JST SH) on a board: add it`, ["parts"], ["parts"])
	// The board generator joins the plug's IO1/IO2 to the bus (linkBusTraces): the bus must exist on its board.
	else if (!["I2C_SDA", "I2C_SCL"].every((sig) => boards.some((b) => (b.snapshot.values.parts ?? []).some((p) => p.ref === plug.ref) && (b.snapshot.values.pins ?? []).some((p) => p.signal === sig))))
		push("mech-wiring", `the sensor connector ${plug.ref} needs an I2C bus on its board: assign I2C_SDA and I2C_SCL to two free GPIOs, on another I2C part of the board (its SDA, SCL) or, when the plug is the only one, on the plug itself as I2C_SDA → ${plug.ref}.IO1 and I2C_SCL → ${plug.ref}.IO2`, ["architect"], ["pins"])
	// The sensor's plug takes no pins: the board generator joins its IO1/IO2 to the I2C bus (real rover run 3 on the
	// Claude subscription: the architect wired JT1 to two spare GPIOs as "EXP_IO1/2", which left it on no bus).
	// The bus itself may sit on the plug in the STEMMA QT order (I2C_SDA on IO1, I2C_SCL on IO2), which is where it must go
	// when the plug is the board's only I2C device: "needs an I2C bus" and "the plug takes no pins" then contradicted each
	// other, and the architect moved the bus on and off JT1 six times (run cc-eurobot-11 on the Claude subscription, 16 Nov
	// 2026, revisions 15-29, half its revision budget).
	const busOnPlug = (p: { signal: string; partPin: string }) => (p.signal === "I2C_SDA" && p.partPin === "IO1") || (p.signal === "I2C_SCL" && p.partPin === "IO2")
	const onPlug = mech.sensor ? pins.filter((p) => p.partRef === mech.sensor.connector && !busOnPlug(p)) : []
	if (onPlug.length) push("mech-wiring", `${onPlug.map((p) => `${p.signal} (GPIO${p.gpio}) on ${p.partRef}.${p.partPin}`).join(", ")} go${onPlug.length === 1 ? "es" : ""} to the distance sensor's plug ${mech.sensor.connector}: remove ${onPlug.length === 1 ? "it" : "them"}. The plug takes only the I2C bus, as I2C_SDA → ${mech.sensor.connector}.IO1 and I2C_SCL → ${mech.sensor.connector}.IO2 (or the bus on another I2C part, and the generator joins the plug to it)`, ["architect"], ["pins"])
	// A competition's rules (motion.rules: catalog/rules/<id>.json, rules/eurobot.ts), each finding citing its clause.
	if (motion.rules) {
		const rules = cat.rules?.[motion.rules]
		if (!rules) push("mech-rules", `motion.rules is "${motion.rules}", a rule set Bringup doesn't have (catalog/rules: ${Object.keys(cat.rules ?? {}).join(", ") || "none"})`, ["architect"], ["motion"])
		else for (const f of ruleChecks(rules, motion, mech, ms, pack, cat.mech, figures)) push("mech-rules", `${f.rule}: ${f.message}`, f.affects)
	}
	// The beacon support's mast stands on the plate with its socket: nothing else may stand where it does (the Eurobot
	// base's still, 16 Nov: its battery lay inside the mast's socket, and no check said so).
	if (mech.beacon) {
		const b = mech.beacon, half = b.sizeMm / 2 + 2.2 // the socket's wall and fit (py/chassis.py)
		const inMast = ms.filter((m) => !/^(plate|wheel:|motor:|caster|beacon|payload|estop-deck)/.test(m.what) && Math.abs(m.xMm - b.at.xMm) < half + m.sizeMm[0] / 2 && Math.abs(m.yMm - b.at.yMm) < half + m.sizeMm[1] / 2 && m.zMm - m.sizeMm[2] / 2 < b.topMm)
		if (inMast.length) push("mech-fit", `${inMast.map((m) => m.what.replace(":", " ")).join(", ")} ${inMast.length === 1 ? "stands" : "stand"} where the beacon support's ${b.sizeMm} mm mast and its socket do (centred at ${b.at.xMm}, ${b.at.yMm}): move ${inMast.length === 1 ? "it" : "them"} clear of x ${b.at.xMm - half}..${b.at.xMm + half}, y ${b.at.yMm - half}..${b.at.yMm + half} mm`)
	}
	// The emergency stop (safety.ts): its contact against the motors' current and the pack's voltage, its plug, its mount.
	for (const f of [...safetyChecks(mech, parts, motor, pack, cat.mech, figures, ms), ...startChecks(mech, parts, pins)]) push("mech-safety", f.message, f.affects, f.affects.includes("parts") ? ["parts"] : f.affects.includes("architect") ? ["pins"] : ["mechanics"])
	if (!parts.some((p) => p.role === "battery")) push("mech-wiring", 'no battery connector on any board: the cell plugs into a 2-pin connector whose part has role "battery" (not "connector": a role-"connector" 2-pin part is a motor\'s plug, JM1 or JM2)', ["parts"], ["parts"])
	return out
}

// A board's rails that draw on the cell as electronics: every rail but USB's input and the cell's own rail (when other
// rails hang off it, the cell rail's load is theirs plus the motors').
export function cellFedElectronics<R extends { name: string }>(rails: R[]): R[] {
	const fed = rails.filter((r) => !/VBUS|USB/i.test(r.name))
	const downstream = fed.filter((r) => !/BAT|CELL/i.test(r.name))
	return downstream.length ? downstream : fed
}
