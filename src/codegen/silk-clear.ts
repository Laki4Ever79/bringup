// A footprint's silkscreen kept off its own pads (lead-2, 27 Nov 2026: the CNC's 24 silkscreen warnings). The generated
// footprints draw the part's body outline on silkscreen, and on a part whose pads reach past the body (an inductor's
// end pads, a module's castellated edge, a buck's leads) the outline ran over them: KiCad's silk_over_copper
// ("Silkscreen clipped by solder mask"), 35 on every ESP32 module, 8 on each TPS54560, 2 on each inductor. The fab clips
// such silk anyway; the warnings hid the ones that matter. Each outline segment is cut where it comes within
// SILK_PAD_CLEAR_MM of a pad (KiCad's own library footprints break their outlines at the pads the same way).

// From the line's centre: half the 0.1 mm line, plus 0.1 mm (the solder mask opens at the pad's edge: margin 0).
export const SILK_PAD_CLEAR_MM = 0.15
// Pieces shorter than this are dropped (a sliver between two pads reads as noise).
const MIN_PIECE_MM = 0.2

type Pt = { x: number; y: number }
type Box = { x0: number; y0: number; x1: number; y1: number }

const num = (attrs: string, name: string): number | undefined => {
	const m = new RegExp(`\\b${name}=(?:"(-?[\\d.]+)(?:mm)?"|\\{(-?[\\d.]+)\\})`).exec(attrs)
	return m ? Number(m[1] ?? m[2]) : undefined
}

// Each pad's copper as a box (a circle or pill by its bounding box: the outline keeps at least the clearance from it).
export function padBoxes(fp: string): Box[] {
	const out: Box[] = []
	for (const m of fp.matchAll(/<(smtpad|platedhole|hole)\b([^>]*?)\/>/g)) {
		const a = m[2]
		const poly = /points=\{\[([^\]]*)\]\}/.exec(a)
		if (poly) {
			const pts = [...poly[1].matchAll(/x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+)/g)].map((p) => ({ x: Number(p[1]), y: Number(p[2]) }))
			if (pts.length) out.push({ x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) })
			continue
		}
		const x = num(a, "pcbX") ?? 0
		const y = num(a, "pcbY") ?? 0
		const r = num(a, "radius")
		const d = num(a, "outerDiameter") ?? num(a, "diameter") ?? (r !== undefined ? 2 * r : undefined)
		const w = num(a, "width") ?? num(a, "outerWidth") ?? d
		const h = num(a, "height") ?? num(a, "outerHeight") ?? d
		if (w === undefined || h === undefined) continue
		out.push({ x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2 })
	}
	return out
}

// The parts of segment a→b (as t in [0, 1]) outside every box (Liang–Barsky clip per box, the inside spans subtracted).
function outside(a: Pt, b: Pt, boxes: Box[]): [number, number][] {
	const cuts: [number, number][] = []
	for (const k of boxes) {
		let t0 = 0, t1 = 1
		const dx = b.x - a.x, dy = b.y - a.y
		const ok = [[-dx, a.x - k.x0], [dx, k.x1 - a.x], [-dy, a.y - k.y0], [dy, k.y1 - a.y]].every(([p, q]) => {
			if (p === 0) return q >= 0
			const t = q / p
			if (p < 0) t0 = Math.max(t0, t)
			else t1 = Math.min(t1, t)
			return t0 <= t1
		})
		if (ok && t1 > t0) cuts.push([t0, t1])
	}
	cuts.sort((p, q) => p[0] - q[0])
	const keep: [number, number][] = []
	let at = 0
	for (const [c0, c1] of cuts) {
		if (c0 > at) keep.push([at, c0])
		at = Math.max(at, c1)
	}
	if (at < 1) keep.push([at, 1])
	return keep
}

// A silkscreen route as the polylines left once every pad (grown by the clearance) is cut out of it.
export function clipRoute(route: Pt[], pads: Box[], clearMm = SILK_PAD_CLEAR_MM): Pt[][] {
	const boxes = pads.map((b) => ({ x0: b.x0 - clearMm, y0: b.y0 - clearMm, x1: b.x1 + clearMm, y1: b.y1 + clearMm }))
	const lines: Pt[][] = []
	let cur: Pt[] = []
	const r = (v: number) => +v.toFixed(3) + 0
	const at = (a: Pt, b: Pt, t: number) => ({ x: r(a.x + (b.x - a.x) * t), y: r(a.y + (b.y - a.y) * t) })
	const flush = () => {
		const len = cur.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - cur[i].x, p.y - cur[i].y), 0)
		if (cur.length >= 2 && len >= MIN_PIECE_MM) lines.push(cur)
		cur = []
	}
	for (let i = 0; i + 1 < route.length; i++) {
		const [a, b] = [route[i], route[i + 1]]
		for (const [t0, t1] of outside(a, b, boxes)) {
			if (t0 > 0 || !cur.length) {
				flush()
				cur.push(at(a, b, t0))
			}
			cur.push(at(a, b, t1))
			if (t1 < 1) flush()
		}
	}
	flush()
	// A closed outline cut nowhere at its start: its first and last runs are one line.
	const closed = route.length > 2 && route[0].x === route[route.length - 1].x && route[0].y === route[route.length - 1].y
	if (closed && lines.length > 1) {
		const [first, last] = [lines[0], lines[lines.length - 1]]
		const [f0, lz] = [first[0], last[last.length - 1]]
		if (f0.x === r(route[0].x) && f0.y === r(route[0].y) && lz.x === f0.x && lz.y === f0.y) lines.splice(0, lines.length, [...last, ...first.slice(1)], ...lines.slice(1, -1))
	}
	return lines
}

// A generated footprint (`{<footprint>…</footprint>}`) with each silkscreen path cut clear of its pads.
export function clearSilk(fp: string, clearMm = SILK_PAD_CLEAR_MM): string {
	const pads = padBoxes(fp)
	if (!pads.length) return fp
	return fp.replace(/<silkscreenpath route=\{\[([^\]]*)\]\} \/>/g, (_all, body: string) => {
		const route = [...body.matchAll(/x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+)/g)].map((p) => ({ x: Number(p[1]), y: Number(p[2]) }))
		return clipRoute(route, pads, clearMm)
			.map((l) => `<silkscreenpath route={[${l.map((p) => `{ x: ${p.x}, y: ${p.y} }`).join(", ")}]} />`)
			.join("")
	})
}
