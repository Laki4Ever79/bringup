// The case side of adopt, kept rough on purpose: an STL's bounding box, enough to ask "does the board fit at all".
import { readFileSync } from "node:fs"

export interface Box {
	x: number
	y: number
	z: number
}

export function stlBox(path: string): Box | null {
	const buf = readFileSync(path)
	const pts: number[][] = []
	// Binary STL: 80-byte header, uint32 count, 50 bytes per triangle. Checked by size, since ASCII files can start
	// with "solid" too and so can binary headers.
	const count = buf.length >= 84 ? buf.readUInt32LE(80) : -1
	if (count >= 0 && 84 + count * 50 === buf.length) {
		for (let i = 0; i < count; i++) {
			const o = 84 + i * 50 + 12
			for (let v = 0; v < 3; v++) pts.push([buf.readFloatLE(o + v * 12), buf.readFloatLE(o + v * 12 + 4), buf.readFloatLE(o + v * 12 + 8)])
		}
	} else {
		for (const m of buf.toString("utf8").matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) pts.push([+m[1], +m[2], +m[3]])
	}
	if (!pts.length) return null
	// A loop, not Math.max(...): a big STL has millions of vertices, more than a call's arguments can hold.
	const span = (k: number) => {
		let lo = Infinity
		let hi = -Infinity
		for (const p of pts) {
			if (p[k] < lo) lo = p[k]
			if (p[k] > hi) hi = p[k]
		}
		return +(hi - lo).toFixed(2)
	}
	return { x: span(0), y: span(1), z: span(2) }
}

// Whether a w×h board can lie inside the box (either way round, flat on any face), and the tightest margin.
export function boardFits(w: number, h: number, box: Box): { fits: boolean; marginMm: number } {
	const faces: [number, number][] = [[box.x, box.y], [box.x, box.z], [box.y, box.z]]
	let best = -Infinity
	for (const [a, b] of faces)
		for (const [bw, bh] of [[w, h], [h, w]]) best = Math.max(best, Math.min(a - bw, b - bh))
	return { fits: best >= 0, marginMm: +best.toFixed(2) }
}
