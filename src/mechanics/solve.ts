// The chassis layout solver (the layout_chassis tool): the mechanics engineer picks the parts, code finds a layout that
// passes the robot's checks. Real rover run 3 (15 Nov, $5.34): the model moved the battery and caster a few mm at a
// time for 30+ revisions and never landed on the plate; packing is a search, not a judgement. As with the pin solver
// (src/mcu/solver.ts), the model chooses and code places.
//
// The search runs the robot's own checks (checks.ts) on each candidate, so a layout the solver returns passes exactly
// what the run will check. Wiring findings (driver, pins, connectors) are left out: they belong to the board, not the
// chassis.
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
	const missing = [!motor && `motor ${choice.motor}`, !wheel && `wheel ${choice.wheel}`, !caster && `caster ${choice.caster}`, !pack && `battery ${choice.pack}`, !sensor && `sensor ${choice.sensor}`].filter(Boolean)
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
	const clearanceMm = caster!.heightMm
	const thicknessMm = 3
	const plateTop = clearanceMm + thicknessMm
	const sensorZ = Math.round((plateTop + Math.max(...sensor!.sizeMm) / 2 + 2) * 10) / 10
	const wheelW = wheel!.widthMm
	const budget = opts.budget ?? 40_000
	let tried = 0
	let best: { mech: Mechanics; remaining: MechViolation[] } | null = null
	const score = (v: MechViolation[]) => v.length
	const check = (mech: Mechanics): MechViolation[] => {
		tried++
		const s: ContractSnapshot = { ...c, values: { ...c.values, mechanics: mech } }
		return mechanicsChecksWith(s, cat).filter((v) => CHASSIS_KINDS.has(v.kind))
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
		for (const axleXMm of range(hx * 0.6, -hx * 0.2, -5))
			for (const wheelbaseMm of range(30, axleXMm + hx - caster!.wheelMm / 2, 5))
				for (const bx of range(hx - pack!.sizeMm[0] / 2, -(hx - pack!.sizeMm[0] / 2), -5)) {
					if (tried >= budget) return finish()
					const mech: Mechanics = {
						drive: { kind: "differential", motor: motor!.mpn, wheel: wheel!.mpn, caster: caster!.mpn, trackMm: track, wheelbaseMm, axleXMm },
						battery: { pack: pack!.mpn, at: { xMm: bx, yMm: 0 } },
						sensor: { module: sensor!.mpn, at: { xMm: sensorX, yMm: 0, zMm: sensorZ }, connector: choice.connector },
						chassis: { plateMm: [L, W], thicknessMm, material: "PLA", clearanceMm, boards: boardsAt },
					}
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
	const failing = mechanicsChecksWith(as, cat).filter((v) => CHASSIS_KINDS.has(v.kind))
	if (!failing.length) return { mechanics: proposed, note: null }
	const r = solveChassis(c, { motor: proposed.drive.motor, wheel: proposed.drive.wheel, caster: proposed.drive.caster, pack: proposed.battery.pack, sensor: proposed.sensor.module, connector: proposed.sensor.connector }, cat)
	if (!r.mechanics || r.remaining.length) return { mechanics: proposed, note: null }
	return { mechanics: r.mechanics, note: `the proposed layout failed ${failing.length} chassis check(s) (${failing[0].message}); the chassis solver laid out the same parts instead: plate ${r.mechanics.chassis.plateMm.join(" × ")} mm, axle at ${r.mechanics.drive.axleXMm} mm, wheelbase ${r.mechanics.drive.wheelbaseMm} mm, battery at x ${r.mechanics.battery.at.xMm} mm` }
}
