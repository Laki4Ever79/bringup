// The physical body of a system of boards: where each board sits and how big it is, in one description that the boards,
// the chassis builder and the 3D view all read. Optional on a SystemSpec; a spec without one behaves as before.
import type { SystemLink, SystemSpec } from "./spec.ts"
import type { Mechanics } from "../mechanics/types.ts"
import { boughtOutlines, moduleById, moduleHoles } from "./bought.ts"

export type BodyKind = "chassis" | "enclosure" | "separate"
export type Rot = 0 | 90 | 180 | 270

export interface AssemblyBoard {
	name: string
	// The board's CENTRE in the chassis frame (src/mechanics/types.ts): origin at the plate centre, +x forward, +y left,
	// mm. The rotation is in the plane.
	xMm: number
	yMm: number
	rotDeg: Rot
	// The board's size before rotation. "estimate" until the board is built, then the built outline.
	outline: { widthMm: number; heightMm: number }
	outlineSource: "estimate" | "built"
	// The height of the board's standoffs; readers default it (STANDOFF_DEFAULT_MM). Allowed 3-30 mm.
	standoffMm?: number
	// A carrier is a HAT on the bought board it carries (spec boards[].carries): same place, the two never "overlap".
	carries?: string
	// Mounting holes when they aren't at the corners (a bought board's record, and its carrier's): mm from the board's
	// lower-left corner, before the turn.
	holes?: { x: number; y: number; dia: number | null }[]
	// A bought board's module record (catalog/modules/<id>.json), so a board's checks can read its figures: the runtime
	// counts its typical draw from the pack.
	module?: string
}


export interface AssemblyPlate { lengthMm: number; widthMm: number }

// A cable's route in the chassis frame (same origin and axes as the boards), one point per bend, end to end.
export interface AssemblyCable { link: string; points: { xMm: number; yMm: number }[] }

export interface SystemAssembly {
	body: BodyKind
	plate?: AssemblyPlate
	boards: AssemblyBoard[]
	cables?: AssemblyCable[]
}

// The pure geometry lives in the dashboard module, so the design page checks with the same code.
import { boardsOverlap, cableLength, CABLE_SLACK_MM, footprint, offPlate, plateLimitForBrief, SENSOR_BRACKET_WALL_MM, snapCarriers, STANDOFF_DEFAULT_MM, STANDOFF_RANGE_MM } from "../geometry/assembly-geom.js"
import { RAIL_WALL_MM, STANDOFF_OD_MM } from "../tools/chassis.ts"
import { motionFromBrief } from "../mechanics/brief.ts"
export { cableLength, CABLE_SLACK_MM, footprint, STANDOFF_DEFAULT_MM, STANDOFF_RANGE_MM }

// The spec a system request makes: its assembly patch over the current one (boards and plate replaced whole, the rest
// merged), its links replacing the old, and every routed link's cable length set from its route. Pure: the run applies
// it and the dashboard validates it, the same way.
export function mergeRequest(spec: SystemSpec, r: { assembly?: Partial<SystemAssembly>; links?: SystemLink[] }): SystemSpec {
	let out = spec
	const a = spec.assembly
	// A carrier goes wherever the board it carries went (they move as one).
	if (r.assembly && a) out = { ...out, assembly: { ...a, ...r.assembly, boards: snapCarriers(r.assembly.boards ?? a.boards), plate: r.assembly.plate ?? a.plate } }
	if (r.links) out = { ...out, links: r.links }
	const cables = r.assembly && a ? r.assembly.cables : undefined
	if (cables?.length) {
		out = { ...out, links: out.links.map((l) => {
			const c = cables.find((x) => x.link === l.id)
			return c && c.points.length >= 2 ? { ...l, cable: { ...l.cable, lengthMm: Math.round(cableLength(c.points) + CABLE_SLACK_MM) } } : l
		}) }
	}
	return out
}

// Every reason the assembly can't be used, in words; [] when it can (or when the spec has none).
export function assemblyErrors(spec: SystemSpec): string[] {
	const a = spec.assembly
	if (!a) return []
	const out: string[] = []
	const specNames = new Set(spec.boards.map((b) => b.name))
	const seen = new Set<string>()
	for (const b of a.boards) {
		if (seen.has(b.name)) out.push(`assembly: board ${b.name} is placed twice`)
		seen.add(b.name)
		if (!specNames.has(b.name)) out.push(`assembly: board ${b.name} is not in the system`)
		if (![0, 90, 180, 270].includes(b.rotDeg)) out.push(`assembly: board ${b.name} is rotated ${b.rotDeg}°; use 0, 90, 180 or 270`)
		if (b.standoffMm !== undefined && !(b.standoffMm >= STANDOFF_RANGE_MM[0] && b.standoffMm <= STANDOFF_RANGE_MM[1])) out.push(`assembly: board ${b.name} has ${b.standoffMm} mm standoffs; use ${STANDOFF_RANGE_MM[0]} to ${STANDOFF_RANGE_MM[1]} mm`)
	}
	if (a.body === "chassis") {
		for (const n of specNames) if (!seen.has(n)) out.push(`assembly: board ${n} has no place on the chassis`)
		if (!a.plate) out.push("assembly: a chassis body needs a plate size")
		else {
			const { lengthMm, widthMm } = a.plate
			for (const b of a.boards) {
				if (offPlate(b, a.plate)) out.push(`assembly: board ${b.name} sticks out of the ${lengthMm} × ${widthMm} mm plate`)
			}
		}
		// Boards that only touch edge to edge don't overlap.
		for (let i = 0; i < a.boards.length; i++) for (let j = i + 1; j < a.boards.length; j++) {
			const p = a.boards[i], q = a.boards[j]
			if (boardsOverlap(p, q)) out.push(`assembly: boards ${p.name} and ${q.name} overlap`)
		}
		// A HAT carrier sits on its board: the same place and turn.
		for (const c of a.boards) {
			const base = c.carries ? a.boards.find((x) => x.name === c.carries) : undefined
			if (base && (base.xMm !== c.xMm || base.yMm !== c.yMm || base.rotDeg !== c.rotDeg)) out.push(`assembly: board ${c.name} is a HAT on ${base.name} and must have its place and turn (${base.xMm}, ${base.yMm}, ${base.rotDeg}°)`)
		}
	}
	return out
}

type Outline = { widthMm: number; heightMm: number }

export const ESTIMATED_OUTLINE_MM = { widthMm: 40, heightMm: 30 } // estimate until the board is built
export const DEFAULT_PLATE_MM: AssemblyPlate = { lengthMm: 150, widthMm: 110 } // today's rover plate (ROVER_BOARD)
export const PLATE_MARGIN_MM = 10
export const BOARD_GAP_MM = 8

// The plate that holds every board with a margin all round, before the floor of today's rover plate. The frame is
// centred on the plate, so each axis needs twice the farthest edge.
export function neededPlate(boards: AssemblyBoard[]): AssemblyPlate {
	let reachX = 0, reachY = 0
	for (const b of boards) {
		const f = footprint(b)
		reachX = Math.max(reachX, Math.abs(b.xMm) + f.xMm / 2)
		reachY = Math.max(reachY, Math.abs(b.yMm) + f.yMm / 2)
	}
	return { lengthMm: 2 * reachX + 2 * PLATE_MARGIN_MM, widthMm: 2 * reachY + 2 * PLATE_MARGIN_MM }
}

// The plate's limit from the robot's brief text ("about 15 × 12 cm"), for the layouts made before any board has written
// its motion field (a plan's Build, a starter's fork, a run's first relayout). Without the wheels chosen it can't take
// their width off the sides yet; the contract's plateLimitMm does once the mechanics exist. The first brief that asks
// for motion and gives a size wins (the robot's main board).
export function briefPlateLimitMm(briefs: string[]): [number, number] | undefined {
	for (const b of briefs) {
		// Only a brief that asks for motion: a sensor board's brief may give its own size ("about 50 × 30 mm").
		const m = motionFromBrief(b)
		const moves = m.speedMps !== undefined || m.runtimeMin !== undefined || m.stopBeforeWallMm !== undefined || m.edgeMm !== undefined
		if (m.maxSizeMm && moves) return plateLimitForBrief(m.maxSizeMm) as [number, number]
	}
	return undefined
}

// Never smaller than today's rover plate (unless the brief's limit is smaller still: then the limit).
function plateFor(boards: AssemblyBoard[], maxSizeMm?: [number, number]): AssemblyPlate {
	const n = neededPlate(boards)
	const plate = { lengthMm: Math.max(DEFAULT_PLATE_MM.lengthMm, n.lengthMm), widthMm: Math.max(DEFAULT_PLATE_MM.widthMm, n.widthMm) }
	if (!maxSizeMm) return plate
	return { lengthMm: n.lengthMm <= maxSizeMm[0] ? Math.min(plate.lengthMm, maxSizeMm[0]) : plate.lengthMm, widthMm: n.widthMm <= maxSizeMm[1] ? Math.min(plate.widthMm, maxSizeMm[1]) : plate.widthMm }
}

// The farthest a board's edge may reach from the plate centre on each axis within the brief's size limit.
const reachLimit = (maxSizeMm?: [number, number]) => ({ x: maxSizeMm ? (maxSizeMm[0] - 2 * PLATE_MARGIN_MM) / 2 : Infinity, y: maxSizeMm ? (maxSizeMm[1] - 2 * PLATE_MARGIN_MM) / 2 : Infinity })

// In words why the boards can't sit within the brief's size limit; null when they can (or when there is no limit).
export function assemblyFitError(a: SystemAssembly, maxSizeMm?: [number, number]): string | null {
	if (!maxSizeMm || a.body !== "chassis") return null
	const n = neededPlate(a.boards)
	if (n.lengthMm <= maxSizeMm[0] + 1e-9 && n.widthMm <= maxSizeMm[1] + 1e-9) return null
	return `assembly: the boards need a ${Math.ceil(n.lengthMm)} × ${Math.ceil(n.widthMm)} mm plate, over the ${maxSizeMm[0]} × ${maxSizeMm[1]} mm plate the brief's size allows (motion.maxSizeMm, less the wheels beside the plate): use smaller boards or fewer of them`
}

// The board that sits at the centre: `main`, else the one with the most links (a tie goes to the first in the spec).
function centreBoard(spec: SystemSpec): string {
	if (spec.boards.some((b) => b.name === "main")) return "main"
	let best = spec.boards[0]?.name ?? "", most = -1
	for (const b of spec.boards) {
		const n = spec.links.filter((l) => l.a.board === b.name || l.b.board === b.name).length
		if (n > most) { best = b.name; most = n }
	}
	return best
}

// A bought board and its HAT carrier take the larger of the two outlines (they share their centre).
const unitOutline = (o: Outline, c?: Outline): Outline => (c ? { widthMm: Math.max(o.widthMm, c.widthMm), heightMm: Math.max(o.heightMm, c.heightMm) } : { ...o })
const boughtHoles = (b: { kind?: string; module?: string }) => {
	const m = b.kind === "bought" && b.module ? moduleById(b.module) : undefined
	const h = m ? moduleHoles(m) : []
	return h.length ? h.map((x) => ({ ...x })) : undefined
}

// The main board at 0,0; the others alternate +x, -x, each one BOARD_GAP_MM clear of the footprint before it on its side.
// With the brief's size limit, a board that would reach past it starts a new row beside the first (along y, alternating
// +y, -y) instead; if even that doesn't fit, it is placed anyway and assemblyFitError names it.
export function defaultAssembly(spec: SystemSpec, body: BodyKind, outlines: Record<string, Outline> = {}, maxSizeMm?: [number, number]): SystemAssembly {
	// A bought board's outline is its record's from the start. Bought boards (each with its carrier, a HAT on top: one
	// unit) stand behind the designed boards (-x), clear of the distance sensor at the front; the designed boards are laid
	// out as before.
	outlines = { ...boughtOutlines(spec.boards), ...outlines }
	const bought = spec.boards.filter((b) => b.kind === "bought")
	const carriers = spec.boards.filter((b) => b.carries && bought.some((x) => x.name === b.carries))
	if (bought.length) {
		const designed = spec.boards.filter((b) => !bought.includes(b) && !carriers.includes(b))
		const rest = designed.length ? defaultAssembly({ ...spec, boards: designed }, body, outlines, maxSizeMm).boards : []
		let rear = rest.length ? Math.min(...rest.map((b) => b.xMm - footprint(b).xMm / 2)) : null
		const placed: AssemblyBoard[] = []
		for (const b of bought) {
			const o = outlines[b.name] ?? { ...ESTIMATED_OUTLINE_MM }
			const c = carriers.find((x) => x.carries === b.name)
			const unit = unitOutline(o, c ? outlines[c.name] : undefined)
			const xMm = rear === null ? 0 : rear - BOARD_GAP_MM - unit.widthMm / 2
			rear = xMm - unit.widthMm / 2
			const holes = boughtHoles(b)
			placed.push({ name: b.name, xMm, yMm: 0, rotDeg: 0, outline: { ...o }, outlineSource: outlines[b.name] ? "built" : "estimate", ...(holes ? { holes } : {}), ...(b.module ? { module: b.module } : {}) })
			if (c) placed.push({ name: c.name, xMm, yMm: 0, rotDeg: 0, outline: outlines[c.name] ? { ...outlines[c.name] } : { ...o }, outlineSource: outlines[c.name] ? "built" : "estimate", carries: b.name, ...(holes ? { holes } : {}) })
		}
		// A carrier whose board isn't bought (a spec error) still gets a place: with the designed boards' rule.
		const all = [...rest, ...placed]
		const boards = spec.boards.map((sb) => all.find((x) => x.name === sb.name) ?? { name: sb.name, xMm: 0, yMm: 0, rotDeg: 0 as Rot, outline: { ...ESTIMATED_OUTLINE_MM }, outlineSource: "estimate" as const })
		return body === "separate" ? { body, boards } : { body, plate: plateFor(boards, maxSizeMm), boards }
	}
	const centre = centreBoard(spec)
	const lim = reachLimit(maxSizeMm)
	const make = (name: string, xMm: number): AssemblyBoard => {
		const built = outlines[name]
		return { name, xMm, yMm: 0, rotDeg: 0, outline: built ? { ...built } : { ...ESTIMATED_OUTLINE_MM }, outlineSource: built ? "built" : "estimate" }
	}
	const boards: AssemblyBoard[] = []
	const first = make(centre, 0)
	boards.push(first)
	// Each row's outer x edge on each side; row 0 is the centre row (y 0). yEdge: the outer y edge reached on each side.
	type Row = { sign: 0 | 1 | -1; inner: number; outer: number; edge: { plus: number; minus: number }; boards: AssemblyBoard[] }
	const rows: Row[] = [{ sign: 0, inner: 0, outer: footprint(first).yMm / 2, edge: { plus: footprint(first).xMm / 2, minus: footprint(first).xMm / 2 }, boards: [first] }]
	const yEdge = { plus: footprint(first).yMm / 2, minus: footprint(first).yMm / 2 }
	let plus = true
	for (const sb of spec.boards) {
		if (sb.name === centre) continue
		const b = make(sb.name, 0)
		const f = footprint(b)
		const w = f.xMm
		// The newest row first, then the one before: the next side in turn, then the other.
		const row = rows[rows.length - 1]
		const sides: ("plus" | "minus")[] = plus ? ["plus", "minus"] : ["minus", "plus"]
		// A row fits while its whole length does, once centred (below): the first board sitting at the centre would leave
		// half the plate unused (the forked Rover + climate: main at 0 and the climate board beside it reached 68 mm of a
		// 65 mm half, so it wrapped to a second row and the plate went 126 mm wide on a 120 mm brief).
		const side = sides.find((sd) => row.edge.plus + row.edge.minus + BOARD_GAP_MM + w <= 2 * lim.x + 1e-9)
		if (side) {
			row.boards.push(b)
			b.xMm = (side === "plus" ? 1 : -1) * (row.edge[side] + BOARD_GAP_MM + w / 2)
			row.edge[side] += BOARD_GAP_MM + w
			if (row.sign !== 0) { b.yMm = row.sign * (row.inner + f.yMm / 2); row.outer = Math.max(row.outer, row.inner + f.yMm); yEdge[row.sign === 1 ? "plus" : "minus"] = Math.max(yEdge[row.sign === 1 ? "plus" : "minus"], row.outer) }
			else {
				// A centre-row board reaches half its height both ways; new rows start past it, not only past main.
				row.outer = Math.max(row.outer, f.yMm / 2)
				yEdge.plus = Math.max(yEdge.plus, f.yMm / 2)
				yEdge.minus = Math.max(yEdge.minus, f.yMm / 2)
			}
			plus = side === "plus" ? false : true
		} else {
			// A new row on the side with the less reach so far; its boards start at the centre again.
			const sd = yEdge.plus <= yEdge.minus ? "plus" : "minus"
			const sign = sd === "plus" ? 1 : -1
			const inner = yEdge[sd] + BOARD_GAP_MM
			b.xMm = 0
			b.yMm = sign * (inner + f.yMm / 2)
			rows.push({ sign, inner, outer: inner + f.yMm, edge: { plus: w / 2, minus: w / 2 }, boards: [b] })
			yEdge[sd] = inner + f.yMm
			plus = true
		}
		boards.push(b)
	}
	// A row reaching past the limit on one side is centred along x; one within it keeps its first board at the centre.
	for (const r of rows) {
		if (Math.max(r.edge.plus, r.edge.minus) <= lim.x + 1e-9) continue
		const shift = (r.edge.minus - r.edge.plus) / 2
		for (const b of r.boards) b.xMm += shift
	}
	// Keep the spec's board order in the result.
	const order = new Map(spec.boards.map((b, i) => [b.name, i]))
	boards.sort((p, q) => (order.get(p.name) ?? 0) - (order.get(q.name) ?? 0))
	return body === "separate" ? { body, boards } : { body, plate: plateFor(boards, maxSizeMm), boards }
}

// Swaps in built outlines. A board keeps its place while it still fits; one that now overlaps another or sticks out of
// the plate moves outwards along x, to the side it was on, past the boards already kept. The plate grows to fit.
export function withOutlines(a: SystemAssembly, outlines: Record<string, Outline>, maxSizeMm?: [number, number]): SystemAssembly {
	const updated: AssemblyBoard[] = a.boards.map((b) => outlines[b.name] ? { ...b, outline: { ...outlines[b.name] }, outlineSource: "built" } : { ...b })
	if (a.body === "separate") return { ...a, boards: updated }
	const plate = a.plate ?? DEFAULT_PLATE_MM
	const overlaps = boardsOverlap
	const lim = reachLimit(maxSizeMm)
	// Past the plate, or past what the brief's size limit leaves for a board's edge.
	const sticksOut = (b: AssemblyBoard) => {
		const f = footprint(b)
		return Math.abs(b.xMm) + f.xMm / 2 > plate.lengthMm / 2 || Math.abs(b.yMm) + f.yMm / 2 > plate.widthMm / 2 || Math.abs(b.xMm) + f.xMm / 2 > lim.x + 1e-9 || Math.abs(b.yMm) + f.yMm / 2 > lim.y + 1e-9
	}
	// A carrier and the board it carries are one unit: judged and moved together, as the larger of their outlines. The
	// carrier follows its board afterwards.
	const isCarrier = (b: AssemblyBoard) => Boolean(b.carries && updated.some((x) => x.name === b.carries))
	const units = updated.filter((b) => !isCarrier(b)).map((b) => {
		const c = updated.find((x) => x.carries === b.name)
		return { b, p: c ? { ...b, outline: unitOutline(b.outline, c.outline) } : b }
	})
	// The board nearest the centre is judged first, so the outer ones are the ones that move.
	const byDistance = units.map((u) => u.p).sort((p, q) => Math.abs(p.xMm) - Math.abs(q.xMm))
	const kept: AssemblyBoard[] = []
	for (const b of byDistance) {
		if (kept.every((k) => !overlaps(b, k)) && !sticksOut(b)) { kept.push(b); continue }
		const w = footprint(b).xMm
		const right = b.xMm >= 0
		const reach = kept.reduce((m, k) => Math.max(m, right ? k.xMm + footprint(k).xMm / 2 : -(k.xMm - footprint(k).xMm / 2)), 0)
		const x = (right ? 1 : -1) * (reach + BOARD_GAP_MM + w / 2)
		// The row it joins, shifted along x as a whole so it sits centred: main need not stay at the plate's centre when the
		// row fits the limit's length but not around main (the scripted rover + climate, 16 Nov: two 40 mm estimates need
		// 88 of the 130 mm, but 68 mm on main's side, so climate went to a second row and the plate grew to 126 mm wide
		// against the brief's 96; main, handed that plate, never settled).
		const row = kept.filter((k) => Math.abs(k.yMm - b.yMm) < (footprint(k).yMm + footprint(b).yMm) / 2)
		const lo = Math.min(x - w / 2, ...row.map((k) => k.xMm - footprint(k).xMm / 2)), hi = Math.max(x + w / 2, ...row.map((k) => k.xMm + footprint(k).xMm / 2))
		const shift = -(lo + hi) / 2
		const fitsCentred = Math.abs(x) + w / 2 > lim.x + 1e-9 && hi - lo <= 2 * lim.x + 1e-9 && (() => {
			const moved = [...row.map((k) => ({ ...k, xMm: k.xMm + shift })), { ...b, xMm: x + shift }]
			const others = kept.filter((k) => !row.includes(k))
			return moved.every((m) => others.every((o) => !overlaps(m, o)))
		})()
		if (Math.abs(x) + w / 2 <= lim.x + 1e-9) b.xMm = x
		else if (fitsCentred) {
			for (const k of row) k.xMm = Math.round((k.xMm + shift) * 10) / 10
			b.xMm = Math.round((x + shift) * 10) / 10
		} else {
			// Past the limit along x: a new row along y, on the side with less reach, clear of every board kept.
			const f = footprint(b)
			const edge = (sign: 1 | -1) => kept.reduce((m, k) => Math.max(m, sign * k.yMm + footprint(k).yMm / 2), 0)
			const sign = edge(1) <= edge(-1) ? 1 : -1
			b.yMm = sign * (edge(sign) + BOARD_GAP_MM + f.yMm / 2)
			b.xMm = Math.max(-(lim.x - w / 2), Math.min(lim.x - w / 2, b.xMm))
		}
		kept.push(b)
	}
	for (const u of units) if (u.p !== u.b) { u.b.xMm = u.p.xMm; u.b.yMm = u.p.yMm }
	// A carrier stays on the board it carries, wherever that one went.
	updated.splice(0, updated.length, ...snapCarriers(updated))
	const grown = plateFor(updated, maxSizeMm)
	let lengthMm = Math.max(plate.lengthMm, grown.lengthMm), widthMm = Math.max(plate.widthMm, grown.widthMm)
	// An old plate larger than the limit shrinks to it when the boards fit (else assemblyFitError names it).
	if (maxSizeMm) {
		const n = neededPlate(updated)
		if (n.lengthMm <= maxSizeMm[0]) lengthMm = Math.min(lengthMm, maxSizeMm[0])
		if (n.widthMm <= maxSizeMm[1]) widthMm = Math.min(widthMm, maxSizeMm[1])
	}
	return { ...a, plate: { lengthMm, widthMm }, boards: updated }
}

// Where main's pack must lie on the plate, from its chassis (tools/chassis.ts chassisSpec): its length plus a standoff's
// width, ending just behind the distance sensor's bracket, across the pack's width with its rails and a standoff. The
// system lays out the boards, so it keeps this stretch free; main's mechanics then put the pack there (bringup-cad, 19
// Nov 2026: the Rover + climate system put main at x 24 and climate at -24 on its 150 mm plate, no 65 mm gap was left
// behind the bracket, and the pack ran onto main's standoffs and into the bracket: mech-fit and part-interference).
export type PackSlot = { xLo: number; xHi: number; yHalf: number }
export function packSlotOf(spec: { battery: { sizeMm: [number, number, number] }; sensor?: { xMm: number; sizeMm: [number, number, number] } | null; plate: { lengthMm: number } }): PackSlot {
	const front = spec.sensor ? spec.sensor.xMm - spec.sensor.sizeMm[0] / 2 - SENSOR_BRACKET_WALL_MM - 1 : spec.plate.lengthMm / 2
	const [len, wid] = spec.battery.sizeMm
	return { xLo: front - len - STANDOFF_OD_MM, xHi: front, yHalf: wid / 2 + RAIL_WALL_MM + STANDOFF_OD_MM / 2 }
}

// The boards moved off the pack's slot: the boards over it (within its width) keep their order along x and are packed
// behind it, the front one BOARD_GAP_MM behind the slot. Only when that row still fits the plate and the brief's limit;
// otherwise the assembly is returned as it was (the mechanics checks then say what doesn't fit). A carrier moves with
// the board it carries.
export function clearPackSlot(a: SystemAssembly, slot: PackSlot | null | undefined, maxSizeMm?: [number, number]): SystemAssembly {
	if (!slot || a.body === "separate") return a
	const plate = a.plate ?? DEFAULT_PLATE_MM
	const lim = reachLimit(maxSizeMm)
	const boards = a.boards.map((b) => ({ ...b }))
	const isCarrier = (b: AssemblyBoard) => Boolean(b.carries && boards.some((x) => x.name === b.carries))
	const units = boards.filter((b) => !isCarrier(b)).map((b) => {
		const c = boards.find((x) => x.carries === b.name)
		return { b, p: c ? { ...b, outline: unitOutline(b.outline, c.outline) } : { ...b } }
	})
	const inBand = (u: AssemblyBoard) => Math.abs(u.yMm) < slot.yHalf + footprint(u).yMm / 2
	const onSlot = (u: AssemblyBoard) => inBand(u) && u.xMm + footprint(u).xMm / 2 > slot.xLo && u.xMm - footprint(u).xMm / 2 < slot.xHi
	if (!units.some((u) => onSlot(u.p))) return a
	// Behind the slot: rows along x, front board first; a board that doesn't fit the row's length starts a new row, and
	// the rows stand side by side across the plate, centred on its middle line (two 40 mm boards and the 65 mm slot don't
	// fit one 150 mm row with the gaps).
	const moving = units.filter((u) => inBand(u.p)).sort((p, q) => q.p.xMm - p.p.xMm)
	const xMax = slot.xLo - BOARD_GAP_MM, xMin = Math.max(-plate.lengthMm / 2, -lim.x)
	const rows: { units: typeof moving; height: number; edge: number }[] = []
	for (const u of moving) {
		const f = footprint(u.p)
		if (f.xMm > xMax - xMin + 1e-9) return a
		let row = rows.find((r) => r.edge - f.xMm >= xMin - 1e-9)
		if (!row) rows.push((row = { units: [], height: 0, edge: xMax }))
		u.p.xMm = Math.round((row.edge - f.xMm / 2) * 10) / 10
		row.edge -= f.xMm + BOARD_GAP_MM
		row.height = Math.max(row.height, f.yMm)
		row.units.push(u)
	}
	const total = rows.reduce((t, r) => t + r.height, 0) + BOARD_GAP_MM * (rows.length - 1)
	if (total / 2 > Math.min(plate.widthMm / 2, lim.y) + 1e-9) return a
	let y = total / 2
	for (const r of rows) {
		for (const u of r.units) u.p.yMm = Math.round((y - r.height / 2) * 10) / 10
		y -= r.height + BOARD_GAP_MM
	}
	if (units.some((u) => !moving.includes(u) && moving.some((m) => boardsOverlap(m.p, u.p)))) return a
	for (const u of units) { u.b.xMm = u.p.xMm; u.b.yMm = u.p.yMm }
	return { ...a, boards: snapCarriers(boards) }
}

// The assembly of a run that predates assemblies, read from what it has (never stored, so an old run stays as it was):
// a robot's mechanics give a chassis body with its plate and its places; anything else is separate devices with no
// positions, so the 3D view keeps its automatic layout. `mainName` is the system board that owns `mainMechanics`
// (inside its contract it is "main"); by default the board called "main", else the first.
export function derivedAssembly(spec: SystemSpec, mainMechanics?: Mechanics, outlines: Record<string, Outline> = {}, mainName?: string): SystemAssembly & { derived: true } {
	const chassis = mainMechanics?.chassis
	if (!chassis) return { body: "separate", boards: [], derived: true }
	const own = mainName ?? (spec.boards.some((b) => b.name === "main") ? "main" : spec.boards[0]?.name ?? "main")
	const boards: AssemblyBoard[] = chassis.boards.map((p) => {
		const name = p.name === "main" ? own : p.name
		const built = outlines[name]
		return { name, xMm: p.at.xMm, yMm: p.at.yMm, rotDeg: p.rotDeg, outline: built ? { ...built } : { ...ESTIMATED_OUTLINE_MM }, outlineSource: built ? "built" : "estimate" }
	})
	return { body: "chassis", plate: { lengthMm: chassis.plateMm[0], widthMm: chassis.plateMm[1] }, boards, derived: true }
}

// In words why a request body is not the shape it must be (types and finiteness only; the rules are assemblyErrors'). [] when it is.
const EDGES = ["left", "right", "top", "bottom"]
const FIELD_TYPES = ["u8", "u16", "i16", "u32", "f32"]
export function requestShapeErrors(b: { assembly?: unknown; links?: unknown }): string[] {
	const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
	const num = (v: unknown) => typeof v === "number" && Number.isFinite(v)
	const out: string[] = []
	if (b.links !== undefined) {
		if (!Array.isArray(b.links)) out.push("links must be a list")
		else b.links.forEach((l, i) => {
			if (!obj(l) || typeof l.id !== "string" || typeof l.kind !== "string" || !obj(l.a) || typeof l.a.board !== "string" || !obj(l.b) || typeof l.b.board !== "string" || !obj(l.cable) || !num(l.cable.lengthMm)) return out.push(`links[${i}] needs id, kind, a.board, b.board and cable.lengthMm`)
			// The rest of a link, so the spec checks never meet a value of the wrong shape (a 400, never a 500).
			for (const end of ["a", "b"] as const) {
				const e = (l[end] as Record<string, unknown>).edge
				if (e !== undefined && !EDGES.includes(e as string)) out.push(`links[${i}].${end}.edge must be ${EDGES.join(", ")}`)
			}
			if (l.baud !== undefined && !num(l.baud)) out.push(`links[${i}].baud must be a number`)
			if (l.power !== undefined && !(obj(l.power) && typeof l.power.from === "string")) out.push(`links[${i}].power needs from (a board)`)
			if (l.i2c !== undefined) {
				const c = l.i2c
				if (!obj(c) || typeof c.controller !== "string" || typeof c.pullupsOn !== "string" || !obj(c.targets) || !Object.values(c.targets).every(num) || (c.khz !== undefined && !num(c.khz)))
					out.push(`links[${i}].i2c needs controller, pullupsOn, targets {board: address} and an optional khz`)
			}
			if (l.messages !== undefined) {
				if (!Array.isArray(l.messages)) out.push(`links[${i}].messages must be a list`)
				else l.messages.forEach((m, j) => {
					if (!obj(m) || typeof m.name !== "string" || typeof m.from !== "string" || !Array.isArray(m.fields) || !m.fields.every((f) => obj(f) && typeof f.name === "string" && FIELD_TYPES.includes(f.type as string)))
						out.push(`links[${i}].messages[${j}] needs name, from and fields [{name, type: ${FIELD_TYPES.join("|")}}]`)
				})
			}
		})
	}
	if (b.assembly !== undefined) {
		const a = b.assembly
		if (!obj(a)) return [...out, "assembly must be an object"]
		if (a.body !== undefined && !["chassis", "enclosure", "separate"].includes(a.body as string)) out.push("assembly.body must be chassis, enclosure or separate")
		if (a.boards !== undefined) {
			if (!Array.isArray(a.boards)) out.push("assembly.boards must be a list")
			else a.boards.forEach((x, i) => {
				if (!obj(x) || typeof x.name !== "string" || !num(x.xMm) || !num(x.yMm) || !num(x.rotDeg) || !obj(x.outline) || !num(x.outline.widthMm) || !num(x.outline.heightMm)) out.push(`assembly.boards[${i}] needs name, xMm, yMm, rotDeg and outline {widthMm, heightMm}`)
				else if (x.standoffMm !== undefined && !num(x.standoffMm)) out.push(`assembly.boards[${i}].standoffMm must be a number`)
			})
		}
		if (a.plate !== undefined && (!obj(a.plate) || !num(a.plate.lengthMm) || !num(a.plate.widthMm))) out.push("assembly.plate needs lengthMm and widthMm")
		if (a.cables !== undefined) {
			if (!Array.isArray(a.cables)) out.push("assembly.cables must be a list")
			else a.cables.forEach((c, i) => {
				if (!obj(c) || typeof c.link !== "string" || !Array.isArray(c.points) || !c.points.every((p) => obj(p) && num(p.xMm) && num(p.yMm))) out.push(`assembly.cables[${i}] needs link and points [{xMm, yMm}]`)
			})
		}
	}
	return out
}
