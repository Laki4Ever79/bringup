// The physical body of a system of boards: where each board sits and how big it is, in one description that the boards,
// the chassis builder and the 3D view all read. Optional on a SystemSpec; a spec without one behaves as before.
import type { SystemSpec } from "./spec.ts"

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

// The plate that holds every board with a margin all round, never smaller than today's rover plate. The frame is centred
// on the plate, so each axis needs twice the farthest edge.
function plateFor(boards: AssemblyBoard[]): AssemblyPlate {
	let reachX = 0, reachY = 0
	for (const b of boards) {
		const f = footprint(b)
		reachX = Math.max(reachX, Math.abs(b.xMm) + f.xMm / 2)
		reachY = Math.max(reachY, Math.abs(b.yMm) + f.yMm / 2)
	}
	return { lengthMm: Math.max(DEFAULT_PLATE_MM.lengthMm, 2 * reachX + 2 * PLATE_MARGIN_MM), widthMm: Math.max(DEFAULT_PLATE_MM.widthMm, 2 * reachY + 2 * PLATE_MARGIN_MM) }
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
export function defaultAssembly(spec: SystemSpec, body: BodyKind, outlines: Record<string, Outline> = {}): SystemAssembly {
	const centre = centreBoard(spec)
	const make = (name: string, xMm: number): AssemblyBoard => {
		const built = outlines[name]
		return { name, xMm, yMm: 0, rotDeg: 0, outline: built ? { ...built } : { ...ESTIMATED_OUTLINE_MM }, outlineSource: built ? "built" : "estimate" }
	}
	const boards: AssemblyBoard[] = []
	const first = make(centre, 0)
	boards.push(first)
	// The outer edge reached so far on each side.
	const edge = { plus: footprint(first).xMm / 2, minus: footprint(first).xMm / 2 }
	let plus = true
	for (const sb of spec.boards) {
		if (sb.name === centre) continue
		const b = make(sb.name, 0)
		const w = footprint(b).xMm
		const side = plus ? "plus" : "minus"
		b.xMm = (plus ? 1 : -1) * (edge[side] + BOARD_GAP_MM + w / 2)
		edge[side] += BOARD_GAP_MM + w
		boards.push(b)
		plus = !plus
	}
	// Keep the spec's board order in the result.
	const order = new Map(spec.boards.map((b, i) => [b.name, i]))
	boards.sort((p, q) => (order.get(p.name) ?? 0) - (order.get(q.name) ?? 0))
	return body === "separate" ? { body, boards } : { body, plate: plateFor(boards), boards }
}

// Swaps in built outlines. A board keeps its place while it still fits; one that now overlaps another or sticks out of
// the plate moves outwards along x, to the side it was on, past the boards already kept. The plate grows to fit.
export function withOutlines(a: SystemAssembly, outlines: Record<string, Outline>): SystemAssembly {
	const updated: AssemblyBoard[] = a.boards.map((b) => outlines[b.name] ? { ...b, outline: { ...outlines[b.name] }, outlineSource: "built" } : { ...b })
	if (a.body === "separate") return { ...a, boards: updated }
	const plate = a.plate ?? DEFAULT_PLATE_MM
	const overlaps = (p: AssemblyBoard, q: AssemblyBoard) => {
		const fp = footprint(p), fq = footprint(q)
		return Math.abs(p.xMm - q.xMm) < (fp.xMm + fq.xMm) / 2 && Math.abs(p.yMm - q.yMm) < (fp.yMm + fq.yMm) / 2
	}
	const sticksOut = (b: AssemblyBoard) => {
		const f = footprint(b)
		return Math.abs(b.xMm) + f.xMm / 2 > plate.lengthMm / 2 || Math.abs(b.yMm) + f.yMm / 2 > plate.widthMm / 2
	}
	// The board nearest the centre is judged first, so the outer ones are the ones that move.
	const byDistance = [...updated].sort((p, q) => Math.abs(p.xMm) - Math.abs(q.xMm))
	const kept: AssemblyBoard[] = []
	for (const b of byDistance) {
		if (kept.every((k) => !overlaps(b, k)) && !sticksOut(b)) { kept.push(b); continue }
		const w = footprint(b).xMm
		const right = b.xMm >= 0
		const reach = kept.reduce((m, k) => Math.max(m, right ? k.xMm + footprint(k).xMm / 2 : -(k.xMm - footprint(k).xMm / 2)), 0)
		b.xMm = (right ? 1 : -1) * (reach + BOARD_GAP_MM + w / 2)
		kept.push(b)
	}
	const grown = plateFor(updated)
	return { ...a, plate: { lengthMm: Math.max(plate.lengthMm, grown.lengthMm), widthMm: Math.max(plate.widthMm, grown.widthMm) }, boards: updated }
}
