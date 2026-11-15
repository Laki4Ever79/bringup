// tscircuit's autorouter can drop a via closer to the board edge than the fab's copper-to-edge clearance (the rover at
// 42×29 mm with its motor driver turned, 15 Nov 2026: 0.287 mm against 0.3 mm). <board minBoardEdgeClearance> reaches
// the router, but the stage that places that via ignores it. So after routing, each such via is moved straight inward
// until its copper clears the edge, and the ends of its own net's traces that sat on it move with it. A move of a
// fraction of a millimetre; KiCad's DRC then checks the board as before, so a move that hits something else shows up
// there and the build keeps the layout with the fewest errors.

export interface ViaMove {
	net: number
	from: [number, number]
	to: [number, number]
}

const NUM = String.raw`(-?[\d.]+(?:e-?\d+)?)`
const SAME = 1e-4 // mm: a trace end on the via's centre, as the router writes it
const MARGIN = 0.01 // mm past the clearance, so float rounding can't leave it at 0.2999

// Every top-level block that starts with "(name": its text and where it is.
function blocks(pcb: string, name: string): { start: number; end: number; text: string }[] {
	const out: { start: number; end: number; text: string }[] = []
	const re = new RegExp(String.raw`\(${name}\b`, "g")
	for (let m = re.exec(pcb); m; m = re.exec(pcb)) {
		let depth = 0
		let i = m.index
		for (; i < pcb.length; i++) {
			if (pcb[i] === "(") depth++
			else if (pcb[i] === ")" && --depth === 0) break
		}
		out.push({ start: m.index, end: i + 1, text: pcb.slice(m.index, i + 1) })
		re.lastIndex = i + 1
	}
	return out
}

const point = (text: string, key: string): [number, number] | null => {
	const m = new RegExp(String.raw`\(${key} ${NUM} ${NUM}`).exec(text)
	return m ? [Number(m[1]), Number(m[2])] : null
}
const value = (text: string, key: string): number | null => {
	const m = new RegExp(String.raw`\(${key} ${NUM}\)`).exec(text)
	return m ? Number(m[1]) : null
}
const near = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < SAME && Math.abs(a[1] - b[1]) < SAME

// The board's outline as a box, from its Edge.Cuts lines and rectangles; null when it has none.
function outlineBox(pcb: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
	const pts: [number, number][] = []
	for (const kind of ["gr_line", "gr_rect"])
		for (const b of blocks(pcb, kind)) {
			if (!/\(layer "?Edge\.Cuts"?\)/.test(b.text)) continue
			for (const key of ["start", "end"]) {
				const p = point(b.text, key)
				if (p) pts.push(p)
			}
		}
	if (pts.length < 2) return null
	const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
	return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6)

// Moves every via whose copper is nearer the outline than clearanceMm inward, with its net's trace ends on it.
export function nudgeEdgeVias(pcb: string, clearanceMm: number): { pcb: string; moved: ViaMove[] } {
	const box = outlineBox(pcb)
	if (!box) return { pcb, moved: [] }
	const moved: ViaMove[] = []
	const edits: { start: number; end: number; text: string }[] = []
	const vias = blocks(pcb, "via")
	for (const v of vias) {
		const at = point(v.text, "at"), size = value(v.text, "size"), net = value(v.text, "net")
		if (!at || size === null || net === null) continue
		const need = clearanceMm + size / 2 + MARGIN
		const x = Math.min(Math.max(at[0], box.minX + need), box.maxX - need)
		const y = Math.min(Math.max(at[1], box.minY + need), box.maxY - need)
		const keep = (a: number, b: number) => Math.abs(a - b) < 1e-9
		if (keep(x, at[0]) && keep(y, at[1])) continue
		moved.push({ net, from: at, to: [x, y] })
		edits.push({ start: v.start, end: v.end, text: v.text.replace(new RegExp(String.raw`\(at ${NUM} ${NUM}`), `(at ${fmt(x)} ${fmt(y)}`) })
	}
	if (!moved.length) return { pcb, moved }
	for (const s of blocks(pcb, "segment")) {
		const net = value(s.text, "net")
		let text = s.text
		for (const key of ["start", "end"]) {
			const p = point(text, key)
			const m = p && moved.find((mv) => mv.net === net && near(mv.from, p))
			if (m) text = text.replace(new RegExp(String.raw`\(${key} ${NUM} ${NUM}`), `(${key} ${fmt(m.to[0])} ${fmt(m.to[1])}`)
		}
		if (text !== s.text) edits.push({ start: s.start, end: s.end, text })
	}
	let out = ""
	let i = 0
	for (const e of edits.sort((a, b) => a.start - b.start)) {
		out += pcb.slice(i, e.start) + e.text
		i = e.end
	}
	return { pcb: out + pcb.slice(i), moved }
}
