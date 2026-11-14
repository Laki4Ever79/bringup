// The physical body of a system of boards: where each board sits and how big it is, in one description that the boards,
// the chassis builder and the 3D view all read. Optional on a SystemSpec; a spec without one behaves as before.
import type { SystemSpec } from "./spec.ts"
import type { Mechanics } from "../mechanics/types.ts"

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
}

export interface AssemblyPlate { lengthMm: number; widthMm: number }

export interface SystemAssembly {
	body: BodyKind
	plate?: AssemblyPlate
	boards: AssemblyBoard[]
}

// Size along x and y once the rotation is applied (a quarter turn swaps them).
export function footprint(b: AssemblyBoard): { xMm: number; yMm: number } {
	const turned = b.rotDeg === 90 || b.rotDeg === 270
	return turned ? { xMm: b.outline.heightMm, yMm: b.outline.widthMm } : { xMm: b.outline.widthMm, yMm: b.outline.heightMm }
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
	}
	if (a.body === "chassis") {
		for (const n of specNames) if (!seen.has(n)) out.push(`assembly: board ${n} has no place on the chassis`)
		if (!a.plate) out.push("assembly: a chassis body needs a plate size")
		else {
			const { lengthMm, widthMm } = a.plate
			for (const b of a.boards) {
				const f = footprint(b)
				if (Math.abs(b.xMm) + f.xMm / 2 > lengthMm / 2 || Math.abs(b.yMm) + f.yMm / 2 > widthMm / 2) out.push(`assembly: board ${b.name} sticks out of the ${lengthMm} × ${widthMm} mm plate`)
			}
		}
		// Boards that only touch edge to edge don't overlap.
		for (let i = 0; i < a.boards.length; i++) for (let j = i + 1; j < a.boards.length; j++) {
			const p = a.boards[i], q = a.boards[j], fp = footprint(p), fq = footprint(q)
			if (Math.abs(p.xMm - q.xMm) < (fp.xMm + fq.xMm) / 2 && Math.abs(p.yMm - q.yMm) < (fp.yMm + fq.yMm) / 2) out.push(`assembly: boards ${p.name} and ${q.name} overlap`)
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
	return `assembly: the boards need a ${Math.ceil(n.lengthMm)} × ${Math.ceil(n.widthMm)} mm plate, over the ${maxSizeMm[0]} × ${maxSizeMm[1]} mm the brief allows (motion.maxSizeMm): use smaller boards or fewer of them`
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

// The main board at 0,0; the others alternate +x, -x, each one BOARD_GAP_MM clear of the footprint before it on its side.
// With the brief's size limit, a board that would reach past it starts a new row beside the first (along y, alternating
// +y, -y) instead; if even that doesn't fit, it is placed anyway and assemblyFitError names it.
export function defaultAssembly(spec: SystemSpec, body: BodyKind, outlines: Record<string, Outline> = {}, maxSizeMm?: [number, number]): SystemAssembly {
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
	type Row = { sign: 0 | 1 | -1; inner: number; outer: number; edge: { plus: number; minus: number } }
	const rows: Row[] = [{ sign: 0, inner: 0, outer: footprint(first).yMm / 2, edge: { plus: footprint(first).xMm / 2, minus: footprint(first).xMm / 2 } }]
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
		const side = sides.find((sd) => row.edge[sd] + BOARD_GAP_MM + w <= lim.x + 1e-9)
		if (side) {
			b.xMm = (side === "plus" ? 1 : -1) * (row.edge[side] + BOARD_GAP_MM + w / 2)
			row.edge[side] += BOARD_GAP_MM + w
			if (row.sign !== 0) { b.yMm = row.sign * (row.inner + f.yMm / 2); row.outer = Math.max(row.outer, row.inner + f.yMm); yEdge[row.sign === 1 ? "plus" : "minus"] = Math.max(yEdge[row.sign === 1 ? "plus" : "minus"], row.outer) }
			else row.outer = Math.max(row.outer, f.yMm / 2)
			plus = side === "plus" ? false : true
		} else {
			// A new row on the side with the less reach so far; its boards start at the centre again.
			const sd = yEdge.plus <= yEdge.minus ? "plus" : "minus"
			const sign = sd === "plus" ? 1 : -1
			const inner = yEdge[sd] + BOARD_GAP_MM
			b.xMm = 0
			b.yMm = sign * (inner + f.yMm / 2)
			rows.push({ sign, inner, outer: inner + f.yMm, edge: { plus: w / 2, minus: w / 2 } })
			yEdge[sd] = inner + f.yMm
			plus = true
		}
		boards.push(b)
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
	const overlaps = (p: AssemblyBoard, q: AssemblyBoard) => {
		const fp = footprint(p), fq = footprint(q)
		return Math.abs(p.xMm - q.xMm) < (fp.xMm + fq.xMm) / 2 && Math.abs(p.yMm - q.yMm) < (fp.yMm + fq.yMm) / 2
	}
	const lim = reachLimit(maxSizeMm)
	// Past the plate, or past what the brief's size limit leaves for a board's edge.
	const sticksOut = (b: AssemblyBoard) => {
		const f = footprint(b)
		return Math.abs(b.xMm) + f.xMm / 2 > plate.lengthMm / 2 || Math.abs(b.yMm) + f.yMm / 2 > plate.widthMm / 2 || Math.abs(b.xMm) + f.xMm / 2 > lim.x + 1e-9 || Math.abs(b.yMm) + f.yMm / 2 > lim.y + 1e-9
	}
	// The board nearest the centre is judged first, so the outer ones are the ones that move.
	const byDistance = [...updated].sort((p, q) => Math.abs(p.xMm) - Math.abs(q.xMm))
	const kept: AssemblyBoard[] = []
	for (const b of byDistance) {
		if (kept.every((k) => !overlaps(b, k)) && !sticksOut(b)) { kept.push(b); continue }
		const w = footprint(b).xMm
		const right = b.xMm >= 0
		const reach = kept.reduce((m, k) => Math.max(m, right ? k.xMm + footprint(k).xMm / 2 : -(k.xMm - footprint(k).xMm / 2)), 0)
		const x = (right ? 1 : -1) * (reach + BOARD_GAP_MM + w / 2)
		if (Math.abs(x) + w / 2 <= lim.x + 1e-9) b.xMm = x
		else {
			// Past the limit along x: a new row along y, on the side with less reach, clear of every board kept.
			const f = footprint(b)
			const edge = (sign: 1 | -1) => kept.reduce((m, k) => Math.max(m, sign * k.yMm + footprint(k).yMm / 2), 0)
			const sign = edge(1) <= edge(-1) ? 1 : -1
			b.yMm = sign * (edge(sign) + BOARD_GAP_MM + f.yMm / 2)
			b.xMm = Math.max(-(lim.x - w / 2), Math.min(lim.x - w / 2, b.xMm))
		}
		kept.push(b)
	}
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
