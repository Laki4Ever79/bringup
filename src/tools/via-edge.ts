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

// The unplated holes (np_thru_hole pads: a debug plug's alignment holes, mounting holes) in board coordinates: the
// footprint's place plus the pad's, turned by the footprint's angle (KiCad: y down, angles counter-clockwise).
function unplatedHoles(pcb: string): { x: number; y: number; r: number }[] {
	const out: { x: number; y: number; r: number }[] = []
	for (const fp of blocks(pcb, "footprint")) {
		const at = new RegExp(String.raw`\(at ${NUM} ${NUM}(?: ${NUM})?\)`).exec(fp.text)
		if (!at) continue
		const [fx, fy, deg] = [Number(at[1]), Number(at[2]), Number(at[3] ?? 0)]
		const th = (deg * Math.PI) / 180
		for (const pad of blocks(fp.text, "pad")) {
			if (!/np_thru_hole/.test(pad.text)) continue
			const p = point(pad.text, "at"), drill = value(pad.text, "drill")
			if (!p || drill === null) continue
			out.push({ x: fx + p[0] * Math.cos(th) + p[1] * Math.sin(th), y: fy - p[0] * Math.sin(th) + p[1] * Math.cos(th), r: drill / 2 })
		}
	}
	return out
}

// Every pad's centre in board coordinates and the radius that covers it: a trace end on one isn't moved.
function padSpots(pcb: string): { x: number; y: number; r: number }[] {
	const out: { x: number; y: number; r: number }[] = []
	for (const fp of blocks(pcb, "footprint")) {
		const at = new RegExp(String.raw`\(at ${NUM} ${NUM}(?: ${NUM})?\)`).exec(fp.text)
		if (!at) continue
		const [fx, fy, deg] = [Number(at[1]), Number(at[2]), Number(at[3] ?? 0)]
		const th = (deg * Math.PI) / 180
		for (const pad of blocks(fp.text, "pad")) {
			const p = point(pad.text, "at"), size = point(pad.text, "size")
			if (!p || !size) continue
			out.push({ x: fx + p[0] * Math.cos(th) + p[1] * Math.sin(th), y: fy - p[0] * Math.sin(th) + p[1] * Math.cos(th), r: Math.hypot(size[0], size[1]) / 2 })
		}
	}
	return out
}

// Two vias of one net whose drills are nearer than holeToHoleMm (the router drops them side by side: run 17 rev 41's VBAT
// and GND pairs 0.11-0.15 mm apart, under JLCPCB's 0.25 mm, where the drills can break into each other) are one via:
// the first is kept, the others are removed and their trace ends join it. Then every via whose copper is nearer an
// unplated hole than holeMm moves straight away from it, and every via nearer the outline than edgeMm inward, with its
// own net's trace ends on it.
export function nudgeVias(pcb: string, rules: { edgeMm: number; holeMm: number; holeToHoleMm?: number }): { pcb: string; moved: ViaMove[]; merged: ViaMove[] } {
	const box = outlineBox(pcb)
	if (!box) return { pcb, moved: [], merged: [] }
	const holes = unplatedHoles(pcb)
	const moved: ViaMove[] = []
	const edits: { start: number; end: number; text: string }[] = []
	const vias = blocks(pcb, "via")
	// Which via each removed one joins (by index), and where the kept via ends up.
	const into = new Map<number, number>()
	if (rules.holeToHoleMm !== undefined) {
		const spec = vias.map((v) => ({ at: point(v.text, "at"), drill: value(v.text, "drill"), net: value(v.text, "net") }))
		for (let i = 0; i < vias.length; i++) {
			const a = spec[i]
			if (into.has(i) || !a.at || a.drill === null || a.net === null) continue
			for (let j = i + 1; j < vias.length; j++) {
				const b = spec[j]
				if (into.has(j) || !b.at || b.drill === null || b.net !== a.net) continue
				if (Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]) - a.drill / 2 - b.drill / 2 < rules.holeToHoleMm) into.set(j, i)
			}
		}
	}
	const finalAt = new Map<number, [number, number]>()
	for (const [k, v] of vias.entries()) {
		if (into.has(k)) {
			edits.push({ start: v.start, end: v.end, text: "" })
			continue
		}
		const at = point(v.text, "at"), size = value(v.text, "size"), net = value(v.text, "net")
		if (!at || size === null || net === null) continue
		finalAt.set(k, at)
		let [hx, hy] = at
		for (const h of holes) {
			const away = h.r + size / 2 + rules.holeMm + MARGIN
			const d = Math.hypot(hx - h.x, hy - h.y)
			if (d >= away || d < 1e-6) continue
			;[hx, hy] = [h.x + ((hx - h.x) / d) * away, h.y + ((hy - h.y) / d) * away]
		}
		const need = rules.edgeMm + size / 2 + MARGIN
		const x = Math.min(Math.max(hx, box.minX + need), box.maxX - need)
		const y = Math.min(Math.max(hy, box.minY + need), box.maxY - need)
		const keep = (a: number, b: number) => Math.abs(a - b) < 1e-9
		if (keep(x, at[0]) && keep(y, at[1])) continue
		finalAt.set(k, [x, y])
		moved.push({ net, from: at, to: [x, y] })
		edits.push({ start: v.start, end: v.end, text: v.text.replace(new RegExp(String.raw`\(at ${NUM} ${NUM}`), `(at ${fmt(x)} ${fmt(y)}`) })
	}
	// A removed via's trace ends go where the via it joined ends up.
	const merged: ViaMove[] = []
	for (const [j, i] of into) {
		const from = point(vias[j].text, "at"), to = finalAt.get(i), net = value(vias[j].text, "net")
		if (from && to && net !== null) merged.push({ net, from, to })
	}
	// A trace's corner nearer the edge than the clearance (the router ignores it for traces too: the 64×25 rover's
	// JD1.pin2 trace ran along the edge, 0.25 mm off, 15 Nov 2026) moves inward by what's missing; every segment end of
	// that net at the same point moves the same way, so joints stay joined. Ends on a moved via follow the via.
	const segments = blocks(pcb, "segment")
	const pads = padSpots(pcb)
	const onPad = (p: [number, number]) => pads.some((q) => Math.hypot(p[0] - q.x, p[1] - q.y) <= q.r)
	const corner = new Map<string, [number, number]>()
	const keyOf = (net: number, p: [number, number]) => `${net}|${p[0].toFixed(4)}|${p[1].toFixed(4)}`
	for (const s of segments) {
		const net = value(s.text, "net"), width = value(s.text, "width") ?? 0
		if (net === null) continue
		const need = rules.edgeMm + width / 2 + MARGIN
		for (const key of ["start", "end"]) {
			const p = point(s.text, key)
			if (!p || onPad(p)) continue
			const k = keyOf(net, p)
			const [x0, y0] = corner.get(k) ?? p
			corner.set(k, [Math.min(Math.max(x0, box.minX + need), box.maxX - need), Math.min(Math.max(y0, box.minY + need), box.maxY - need)])
		}
	}
	for (const s of segments) {
		const net = value(s.text, "net")
		if (net === null) continue
		let text = s.text
		for (const key of ["start", "end"]) {
			const p = point(text, key)
			if (!p) continue
			const m = [...moved, ...merged].find((mv) => mv.net === net && near(mv.from, p))
			const to = m ? m.to : corner.get(keyOf(net, p))
			if (to && !near(to, p)) text = text.replace(new RegExp(String.raw`\(${key} ${NUM} ${NUM}`), `(${key} ${fmt(to[0])} ${fmt(to[1])}`)
		}
		// A trace that ran between two merged vias is now a point: removed.
		const [a, b] = [point(text, "start"), point(text, "end")]
		if (text !== s.text && a && b && near(a, b)) text = ""
		if (text !== s.text) edits.push({ start: s.start, end: s.end, text })
	}
	if (!edits.length) return { pcb, moved, merged }
	let out = ""
	let i = 0
	for (const e of edits.sort((a, b) => a.start - b.start)) {
		out += pcb.slice(i, e.start) + e.text
		i = e.end
	}
	return { pcb: out + pcb.slice(i), moved, merged }
}

// The edge rule alone (the board build applies both through nudgeVias).
export function nudgeEdgeVias(pcb: string, clearanceMm: number): { pcb: string; moved: ViaMove[]; merged: ViaMove[] } {
	return nudgeVias(pcb, { edgeMm: clearanceMm, holeMm: 0 })
}
