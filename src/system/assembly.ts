// The physical body of a system of boards: where each board sits and how big it is, in one description that the boards,
// the chassis builder and the 3D view all read. Optional on a SystemSpec; a spec without one behaves as before.
import type { SystemSpec } from "./spec.ts"

export type BodyKind = "chassis" | "enclosure" | "separate"
export type Rot = 0 | 90 | 180 | 270

export interface AssemblyBoard {
	name: string
	// Position of the board's corner on the plate, and its rotation in the plane.
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
				if (b.xMm < 0 || b.yMm < 0 || b.xMm + f.xMm > lengthMm || b.yMm + f.yMm > widthMm) out.push(`assembly: board ${b.name} sticks out of the ${lengthMm} × ${widthMm} mm plate`)
			}
		}
		// Boards that only touch edge to edge don't overlap.
		for (let i = 0; i < a.boards.length; i++) for (let j = i + 1; j < a.boards.length; j++) {
			const p = a.boards[i], q = a.boards[j], fp = footprint(p), fq = footprint(q)
			if (p.xMm < q.xMm + fq.xMm && q.xMm < p.xMm + fp.xMm && p.yMm < q.yMm + fq.yMm && q.yMm < p.yMm + fp.yMm) out.push(`assembly: boards ${p.name} and ${q.name} overlap`)
		}
	}
	return out
}
