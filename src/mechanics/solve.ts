// The chassis layout solver (the layout_chassis tool): the mechanics engineer picks the parts, code finds a layout that
// passes the robot's checks. Real rover run 3 (15 Nov, $5.34): the model moved the battery and caster a few mm at a
// time for 30+ revisions and never landed on the plate; packing is a search, not a judgement. As with the pin solver
// (src/mcu/solver.ts), the model chooses and code places.
//
// The search runs the robot's own checks (checks.ts) on each candidate, so a layout the solver returns passes exactly
// what the run will check. Wiring findings (driver, pins, connectors) are left out: they belong to the board, not the
// chassis.
import { completeForRules } from "../rules/layout.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { outlinesWithAssembly } from "./assembly.ts"
import { byMpn } from "./catalog.ts"
import { mechanicsChecksWith, type CheckCatalog, type MechViolation } from "./checks.ts"
import type { Mechanics } from "./types.ts"

export interface ChassisChoice {
	motor: string
	wheel: string
	caster: string
	pack: string
	sensor: string
	// The board connector the distance sensor's cable plugs into (role connector, JST SH 4-pin).
	connector: string
}

export interface ChassisSolution {
	mechanics: Mechanics | null
	// The checks the best layout still fails (empty when it passes), and what was tried.
	remaining: MechViolation[]
	tried: number
	why: string
}

const CHASSIS_KINDS = new Set(["mech-fit", "mech-tipping", "mech-climb", "mech-torque", "mech-speed", "mech-stopping", "mech-current", "mech-runtime", "mech-voltage", "mech-drive"])
const range = (from: number, to: number, step: number) => {
	const out: number[] = []
	if (step > 0) for (let x = from; x <= to + 1e-9; x += step) out.push(Math.round(x * 10) / 10)
	else for (let x = from; x >= to - 1e-9; x += step) out.push(Math.round(x * 10) / 10)
	return out
}

export function solveChassis(c: ContractSnapshot, choice: ChassisChoice, cat: CheckCatalog, opts: { budget?: number } = {}): ChassisSolution {
	const motion = c.values.motion
	if (!motion) return { mechanics: null, remaining: [], tried: 0, why: "the design has no motion field: it isn't a robot" }
	const m = cat.mech
	const motor = byMpn(m.motors, choice.motor), wheel = byMpn(m.wheels, choice.wheel), caster = byMpn(m.casters, choice.caster), pack = byMpn(m.batteries, choice.pack), sensor = byMpn(m.sensors ?? [], choice.sensor)
	// Four-wheel skid steer when the brief asks for it (motion.drive): no caster.
	const skid = motion.drive === "skid4"
	const missing = [!motor && `motor ${choice.motor}`, !wheel && `wheel ${choice.wheel}`, !caster && !skid && `caster ${choice.caster}`, !pack && `battery ${choice.pack}`, !sensor && `sensor ${choice.sensor}`].filter(Boolean)
	if (missing.length) return { mechanics: null, remaining: [], tried: 0, why: `${missing.join(", ")} not in catalog/mechanics.json: pick from the design facts' list` }
	// A connector ref another part already has (real rover run 5: "J2", the battery's) can't be the sensor's plug: JT1.
	const clash = (c.values.parts ?? []).find((p) => p.ref === choice.connector && !(p.role === "connector" && p.pins.length === 4))
	if (clash || !choice.connector) choice = { ...choice, connector: "JT1" }
	const [maxL, maxW] = motion.maxSizeMm
	// A system's body fixes the plate and where its boards sit (assembly); otherwise the boards go on the centre line.
	const assembly = c.values.assembly
	const boards = outlinesWithAssembly(c.values)
	// The plate's underside at the caster's height: the level check wants them within a few mm, and the motors hang
	// below it on brackets.
	// Skid steer: both axles hang from the plate, so its underside is where the motors put it (the level check's minimum).
	const clearanceMm = skid ? Math.ceil(wheel!.diameterMm / 2 + motor!.bodyMm[2] / 2) : caster!.heightMm
	const thicknessMm = 3
	const plateTop = clearanceMm + thicknessMm
	const sensorZ = Math.round((plateTop + Math.max(...sensor!.sizeMm) / 2 + 2) * 10) / 10
	const wheelW = wheel!.widthMm
	const budget = opts.budget ?? 40_000
	let tried = 0
	let best: { mech: Mechanics; remaining: MechViolation[] } | null = null
	const score = (v: MechViolation[]) => v.length
	// A competition's rules (motion.rules): every candidate carries what they require (rules/layout.ts), and their
	// findings count, so the layout returned passes them as it is.
	const ruled = Boolean(motion.rules && cat.rules?.[motion.rules])
	const kinds = ruled ? new Set([...CHASSIS_KINDS, "mech-safety", "mech-rules"]) : CHASSIS_KINDS
	const check = (mech: Mechanics): MechViolation[] => {
		tried++
		const s: ContractSnapshot = { ...c, values: { ...c.values, mechanics: mech } }
		// Only what a layout can fix: a plug the parts agent must add (affects parts) isn't the chassis' to solve.
		return mechanicsChecksWith(s, cat).filter((v) => kinds.has(v.kind) && (CHASSIS_KINDS.has(v.kind) || v.affects.includes("mechanics")))
	}
	// Plate: the system's, or the largest the brief allows (a roomier plate is easier to pack and the brief's limit is the
	// only bound on it), then smaller ones.
	const plates: [number, number][] = assembly?.plate
		? [[assembly.plate.lengthMm, assembly.plate.widthMm]]
		: range(maxL, Math.max(60, maxL - 60), -10).flatMap((L) => range(maxW - 2 * wheelW - 4, Math.max(50, maxW - 2 * wheelW - 64), -10).map((W): [number, number] => [L, W]))
	for (const [L, W] of plates) {
		const track = Math.min(maxW - wheelW, W + 4 + wheelW)
		const boardsAt = boards.map((b) => {
			const placed = assembly?.boards.find((x) => x.name === b.name)
			return { name: b.name, at: { xMm: placed?.xMm ?? 0, yMm: placed?.yMm ?? 0 }, rotDeg: (placed?.rotDeg ?? 0) as 0 | 90 | 180 | 270 }
		})
		const sensorX = Math.round((L / 2 - sensor!.sizeMm[2] / 2) * 10) / 10
		const hx = L / 2
		// Skid steer: the front axle near the front, the rear one wheelbaseMm behind, the wheelbase under 0.9 × the track
		// (checks.ts SKID_RATIO_MAX) and both axles' wheels under the plate's length.
		const axles = skid ? range(hx - wheel!.diameterMm / 2, hx * 0.2, -5) : range(hx * 0.6, -hx * 0.2, -5)
		for (const axleXMm of axles)
			for (const wheelbaseMm of skid ? range(Math.min(Math.floor(0.9 * track), axleXMm + hx - wheel!.diameterMm / 2), wheel!.diameterMm + 10, -5) : range(30, axleXMm + hx - caster!.wheelMm / 2, 5))
				for (const bx of range(hx - pack!.sizeMm[0] / 2, -(hx - pack!.sizeMm[0] / 2), -5)) {
					if (tried >= budget) return finish()
					const mech: Mechanics = completeForRules({
						drive: { kind: skid ? "skid4" : "differential", motor: motor!.mpn, wheel: wheel!.mpn, caster: skid ? "" : caster!.mpn, trackMm: track, wheelbaseMm, axleXMm },
						battery: { pack: pack!.mpn, at: { xMm: bx, yMm: 0 } },
						sensor: { module: sensor!.mpn, at: { xMm: sensorX, yMm: 0, zMm: sensorZ }, connector: choice.connector },
						chassis: { plateMm: [L, W], thicknessMm, material: "PLA", clearanceMm, boards: boardsAt, ...(c.values.mechanics?.chassis.gridMm ? { gridMm: c.values.mechanics.chassis.gridMm } : {}) },
					}, c.values, cat)
					const v = check(mech)
					if (!best || score(v) < score(best.remaining)) best = { mech, remaining: v }
					if (v.length === 0) return finish()
				}
	}
	return finish()

	function finish(): ChassisSolution {
		if (!best) return { mechanics: null, remaining: [], tried, why: "no layout to try" }
		return { mechanics: best.mech, remaining: best.remaining, tried, why: best.remaining.length ? `no layout passes with these parts (best of ${tried}): ${best.remaining.map((v) => v.message).join("; ")}; try other parts (a smaller battery, a caster as tall as the wheels' axle)` : `passes every chassis check (layout ${tried} tried)` }
	}
}

// A mechanics proposal whose layout fails the chassis checks gets the solver's layout for the same parts (real rover
// run 5, 15 Nov: the engineer called layout_chassis, then swapped the battery "keeping the layout otherwise unchanged",
// and the new battery didn't fit). Parts are the engineer's choice; where they go is the code's. A layout that passes is
// kept as written, and parts no layout fits are left for the checks to name.
export function laidOut(c: ContractSnapshot, proposed: Mechanics, cat: CheckCatalog): { mechanics: Mechanics; note: string | null } {
	if (!c.values.motion || !proposed?.drive || !proposed.battery || !proposed.sensor) return { mechanics: proposed, note: null }
	const as = { ...c, values: { ...c.values, mechanics: proposed } }
	// Under a competition's rules their findings count too: a plain rover that passes the chassis checks still lacks them.
	const ruled = Boolean(c.values.motion.rules && cat.rules?.[c.values.motion.rules])
	const failing = mechanicsChecksWith(as, cat).filter((v) => CHASSIS_KINDS.has(v.kind) || (ruled && (v.kind === "mech-safety" || v.kind === "mech-rules") && v.affects.includes("mechanics")))
	if (!failing.length) return { mechanics: proposed, note: null }
	const r = solveWithMotorClass(c, { motor: proposed.drive.motor, wheel: proposed.drive.wheel, caster: proposed.drive.caster, pack: proposed.battery.pack, sensor: proposed.sensor.module, connector: proposed.sensor.connector }, cat)
	// No layout passes: the solver's best still goes in when it leaves fewer of these findings than the proposal (it
	// carries the rules' parts too: real run 12's proposal lacked the sticker panel and stood a board in the mast).
	if (r.mechanics && r.remaining.length && r.remaining.length < failing.length)
		return { mechanics: { ...proposed, ...r.mechanics }, note: `no layout passes every check with these parts; the solver's best leaves ${r.remaining.length} of the proposal's ${failing.length} finding(s): ${r.remaining.map((v) => v.message).join("; ")}${r.motorNote ? `; ${r.motorNote}` : ""}` }
	if (!r.mechanics || r.remaining.length) return { mechanics: proposed, note: r.motorNote ?? null }
	// Fields the layout doesn't touch (a compute robot's `regulator`) stay the engineer's.
	return { mechanics: { ...proposed, ...r.mechanics }, note: `the proposed layout failed ${failing.length} chassis check(s) (${failing[0].message}); ${r.motorNote ? `${r.motorNote}; ` : ""}the chassis solver laid out ${r.motorNote ? "those parts" : "the same parts"} instead: plate ${r.mechanics.chassis.plateMm.join(" × ")} mm, axle at ${r.mechanics.drive.axleXMm} mm, wheelbase ${r.mechanics.drive.wheelbaseMm} mm, battery at x ${r.mechanics.battery.at.xMm} mm` }
}

// With a competition's rules (motion.rules), the motor class is part of the layout: when no layout passes with the motor
// picked, the catalog's encoder gearmotors are tried in turn (lowest stall current first) and the first that passes is
// returned with a note (real run 11, 16 Nov 2026: the plain 100:1 12 V motor on a 1.6 kg robot lacked torque).
export function solveWithMotorClass(c: ContractSnapshot, choice: ChassisChoice, cat: CheckCatalog, opts: { budget?: number } = {}): ChassisSolution & { motorNote?: string } {
	const first = solveChassis(c, choice, cat, opts)
	const rules = c.values.motion?.rules
	// Also when the brief asks for wheel encoders (motion.encoders): the agent's plain gearmotor fails that check, and the
	// encoder gearmotors below are the class to pick from (real run 18).
	if ((!rules && !c.values.motion?.encoders) || (first.mechanics && first.remaining.length === 0)) return first
	// The drive class: encoder gearmotors x packs x wheels (real run 12, 16 Nov 2026: the agent's 6 V encoder motor on one
	// cell lacked torque and speed for a 1.6 kg robot, and 5219 needs the two-cell pack). Lowest stall current first, the
	// agent's own parts first within it; the first that passes is returned with what it changed.
	const own = <T extends { mpn: string }>(list: T[], mpn: string) => [...list].sort((a, b) => (a.mpn === byMpn(list, mpn)?.mpn ? -1 : 0) - (b.mpn === byMpn(list, mpn)?.mpn ? -1 : 0))
	const motors = [...cat.mech.motors.filter((m) => m.encoder)].sort((a, b) => a.stallA - b.stallA)
	for (const m of motors)
		for (const p of own(cat.mech.batteries, choice.pack))
			for (const w of own(cat.mech.wheels, choice.wheel)) {
				const next = { ...choice, motor: m.mpn, pack: p.mpn, wheel: w.mpn }
				if (next.motor === byMpn(cat.mech.motors, choice.motor)?.mpn && next.pack === byMpn(cat.mech.batteries, choice.pack)?.mpn && next.wheel === byMpn(cat.mech.wheels, choice.wheel)?.mpn) continue
				const r = solveChassis(c, next, cat, { budget: Math.min(opts.budget ?? 40_000, 8_000) })
				if (r.mechanics && r.remaining.length === 0) {
					const changed = [next.motor !== choice.motor && `motor ${m.mpn}`, next.pack !== choice.pack && `pack ${p.mpn}`, next.wheel !== choice.wheel && `wheels ${w.mpn}`].filter(Boolean).join(", ")
					return { ...r, motorNote: `${choice.motor} on ${choice.pack} gave no passing layout under ${rules}'s rules (${first.remaining[0]?.message ?? first.why}); with ${changed} it passes` }
				}
			}
	return first
}
