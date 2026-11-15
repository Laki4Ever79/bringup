// The top view's geometry (pure): the plate, the boards and the cables of a system, in SVG millimetres. SVG x is the
// assembly's x (forward = right) and SVG y is minus its y (left = up), so the picture reads like looking down on the
// robot from above. Edge names and offsets follow src/mechanics: offsetMm runs along the edge, from the bottom on a
// left or right edge and from the left on a top or bottom edge, in the board's own frame before it is turned.
import { autoLayout } from "./world3d.js"

const MARGIN = 10
// The planned size of a board with no outline yet; the same as ESTIMATED_OUTLINE_MM in src/system/assembly.ts (this
// module is browser JS and cannot import it).
const FALLBACK = { widthMm: 40, heightMm: 30 }
const r6 = (n) => Math.round(n * 1e6) / 1e6 + 0 // also turns -0 into 0
// Outward normals in the board's own frame (y up).
const NORMAL = { left: [-1, 0], right: [1, 0], top: [0, 1], bottom: [0, -1] }

function turn([x, y], deg) {
	const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t)
	return [x * c - y * s, x * s + y * c]
}

// A board's centre and size in the assembly frame, then in SVG mm.
function place(name, cx, cy, outline, rotDeg, built) {
	const turned = rotDeg === 90 || rotDeg === 270
	const w = turned ? outline.heightMm : outline.widthMm, h = turned ? outline.widthMm : outline.heightMm
	return { name, x: r6(cx - w / 2), y: r6(-cy - h / 2), w, h, rotDeg, built, cx, cy, outline }
}

// The point and outward direction (SVG) where a cable leaves `b` on `edge`, `offsetMm` along it (null: the middle).
function endOn(b, edge, offsetMm) {
	const { widthMm: W, heightMm: H } = b.outline
	const along = edge === "left" || edge === "right" ? H : W
	const off = offsetMm ?? along / 2
	const local = { left: [-W / 2, -H / 2 + off], right: [W / 2, -H / 2 + off], top: [-W / 2 + off, H / 2], bottom: [-W / 2 + off, -H / 2] }[edge]
	const [px, py] = turn(local, b.rotDeg), [nx, ny] = turn(NORMAL[edge], b.rotDeg)
	return { x: r6(b.cx + px), y: r6(-(b.cy + py)), n: [Math.round(nx), Math.round(-ny)] }
}

// The edge of `b` facing `other` (SVG centres): the one along the larger gap.
function facing(b, other) {
	const dx = other.x + other.w / 2 - (b.x + b.w / 2), dy = other.y + other.h / 2 - (b.y + b.h / 2)
	const n = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1]
	return n
}

// The edge of the unturned board whose outward direction, once turned, is the SVG direction n.
function edgeFacing(b, n) {
	for (const e of Object.keys(NORMAL)) {
		const [nx, ny] = turn(NORMAL[e], b.rotDeg)
		if (Math.round(nx) === n[0] && Math.round(-ny) === n[1]) return e
	}
	return "right"
}

const num = (n) => String(r6(n))

function cablePath(from, to) {
	const [fx, fy] = from.n, [tx, ty] = to.n
	if (fx === -tx && fy === -ty) return `M${num(from.x)} ${num(from.y)}L${num(to.x)} ${num(to.y)}`
	let cx, cy
	if (fx * tx + fy * ty === 0) {
		// Perpendicular: bend at the corner where the two straight runs would meet.
		;[cx, cy] = fx !== 0 ? [to.x, from.y] : [from.x, to.y]
	} else {
		// Same direction: swing out past both ends.
		const out = 20
		cx = (from.x + to.x) / 2 + fx * out
		cy = (from.y + to.y) / 2 + fy * out
	}
	return `M${num(from.x)} ${num(from.y)}Q${num(cx)} ${num(cy)} ${num(to.x)} ${num(to.y)}`
}

// The point half way along a polyline.
function halfway(pts) {
	const seg = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y))
	let left = seg.reduce((a, b) => a + b, 0) / 2
	for (let i = 0; i < seg.length; i++) {
		if (left <= seg[i] || i === seg.length - 1) {
			const k = seg[i] > 0 ? Math.min(1, left / seg[i]) : 0
			return { x: r6(pts[i].x + (pts[i + 1].x - pts[i].x) * k), y: r6(pts[i].y + (pts[i + 1].y - pts[i].y) * k) }
		}
		left -= seg[i]
	}
	return { ...pts[0] }
}

export function topLayout(assembly, boards, links) {
	const placed = new Map()
	const given = assembly?.boards ?? []
	// A board's own `built` (the timeline's state at the scrub time, from system.html) wins over the assembly's latest:
	// not built yet, it is its estimate box (its outline then, or the planned box); built, its outline then.
	for (const a of given) {
		const own = (boards ?? []).find((b) => b.name === a.name)
		const built = typeof own?.built === "boolean" ? own.built : a.outlineSource === "built"
		const outline = typeof own?.built === "boolean" ? own.outline ?? (own.built ? a.outline : FALLBACK) : a.outline
		placed.set(a.name, place(a.name, a.xMm, a.yMm, outline, a.rotDeg ?? 0, built))
	}
	// Boards the assembly doesn't place (all of them for a separate body) go through autoLayout; when some are already
	// placed, the group stands to the right of the plate or of the placed boards.
	const missing = (boards ?? []).filter((b) => !placed.has(b.name)).map((b) => ({ name: b.name, outline: b.outline ?? FALLBACK, built: typeof b.built === "boolean" ? b.built : b.outline != null }))
	if (missing.length) {
		const auto = autoLayout(missing, links ?? [])
		let dx = 0
		if (placed.size) {
			const right = assembly?.plate ? assembly.plate.lengthMm / 2 : Math.max(...[...placed.values()].map((b) => b.cx + b.w / 2))
			dx = right + 20 - Math.min(...missing.map((b) => auto[b.name].x - b.outline.widthMm / 2))
		}
		for (const b of missing) placed.set(b.name, place(b.name, auto[b.name].x + dx, auto[b.name].y, b.outline, 0, b.built))
	}
	const plate = assembly?.plate ? { x: -assembly.plate.lengthMm / 2, y: -assembly.plate.widthMm / 2, w: assembly.plate.lengthMm, h: assembly.plate.widthMm } : null
	const out = [...placed.values()].map(({ name, x, y, w, h, rotDeg, built }) => ({ name, x, y, w, h, rotDeg, built }))
	// The plate (when there is one) and every board, so a board beside the plate is inside the picture too.
	const rects = [...(plate ? [plate] : []), ...out]
	const x0 = rects.length ? Math.min(...rects.map((b) => b.x)) : 0, y0 = rects.length ? Math.min(...rects.map((b) => b.y)) : 0
	const box = rects.length ? { x: x0, y: y0, w: Math.max(...rects.map((b) => b.x + b.w)) - x0, h: Math.max(...rects.map((b) => b.y + b.h)) - y0 } : { x: 0, y: 0, w: 0, h: 0 }
	const bounds = { x: box.x - MARGIN, y: box.y - MARGIN, w: box.w + 2 * MARGIN, h: box.h + 2 * MARGIN }

	const cables = []
	for (const l of links ?? []) {
		const A = placed.get(l.a.board), B = placed.get(l.b.board)
		if (!A || !B) continue
		const svgA = { x: A.x, y: A.y, w: A.w, h: A.h }, svgB = { x: B.x, y: B.y, w: B.w, h: B.h }
		const end = (self, other, selfSvg, otherSvg, ref) => {
			const edge = ref.edge ?? edgeFacing(self, facing(selfSvg, otherSvg))
			const info = (boards ?? []).find((x) => x.name === ref.board)
			const c = ref.edge ? info?.connectors?.find((k) => k.edge === ref.edge) : null
			return endOn(self, edge, c ? c.offsetMm : null)
		}
		// A cable routed by hand (assembly.cables, the edit view's route in the chassis frame) follows its points.
		const route = (assembly?.cables ?? []).find((c) => c.link === l.id)?.points
		const routed = Array.isArray(route) && route.length >= 2 ? route.map((p) => ({ x: r6(p.xMm), y: r6(-p.yMm) })) : null
		const from = routed ? routed[0] : end(A, B, svgA, svgB, l.a), to = routed ? routed[routed.length - 1] : end(B, A, svgB, svgA, l.b)
		const points = routed ?? [{ x: from.x, y: from.y }, { x: to.x, y: to.y }]
		const mid = routed ? halfway(routed) : { x: r6((from.x + to.x) / 2), y: r6((from.y + to.y) / 2) }
		cables.push({
			id: l.id, kind: l.kind,
			from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y },
			points,
			path: routed ? `M${routed.map((p) => `${num(p.x)} ${num(p.y)}`).join("L")}` : cablePath(from, to),
			label: [l.id, String(l.kind).toUpperCase(), ...(l.cable?.lengthMm > 0 ? [`${l.cable.lengthMm} mm`] : [])].join(" · "),
			mid,
		})
	}
	return { plate, boards: out, cables, bounds }
}

// A board's top-down shapes from its circuit.json, in mm from the board's top-left with y down. circuit.json is
// centre-origin and y-up (pcb_board.center is the middle), the same reading as world3d.js / pcb-view.js, so the 2D
// and 3D views agree. A part's box is the copper of its pads (its width and height are given before rotation); a
// part with no pads falls back to its own centre and size, swapped on a quarter turn.
export function boardShapes(circuit) {
	const els = Array.isArray(circuit) ? circuit : []
	const of = (type) => els.filter((e) => e.type === type)
	const b = of("pcb_board")[0]
	const w = b?.width ?? 0, h = b?.height ?? 0
	const ox = w / 2 - (b?.center?.x ?? 0), oy = h / 2 + (b?.center?.y ?? 0)
	const X = (x) => r6(x + ox), Y = (y) => r6(oy - y)
	const names = new Map(of("source_component").map((e) => [e.source_component_id, e.name]))
	const pads = [
		...of("pcb_smtpad").map((p) => ({ c: p.pcb_component_id, x: p.x, y: p.y, w: p.width ?? (p.radius ?? 0) * 2, h: p.height ?? (p.radius ?? 0) * 2 })),
		...of("pcb_plated_hole").map((p) => ({ c: p.pcb_component_id, x: p.x, y: p.y, w: p.outer_width ?? p.rect_pad_width ?? p.outer_diameter ?? 1, h: p.outer_height ?? p.rect_pad_height ?? p.outer_diameter ?? 1 })),
	]
	const parts = of("pcb_component").map((c) => {
		const mine = pads.filter((p) => p.c === c.pcb_component_id)
		let x0, x1, y0, y1
		if (mine.length) {
			x0 = Math.min(...mine.map((p) => p.x - p.w / 2)); x1 = Math.max(...mine.map((p) => p.x + p.w / 2))
			y0 = Math.min(...mine.map((p) => p.y - p.h / 2)); y1 = Math.max(...mine.map((p) => p.y + p.h / 2))
		} else {
			const quarter = Math.round((c.rotation ?? 0) / 90) % 2 !== 0
			const cw = quarter ? c.height : c.width, ch = quarter ? c.width : c.height
			x0 = c.center.x - cw / 2; x1 = c.center.x + cw / 2; y0 = c.center.y - ch / 2; y1 = c.center.y + ch / 2
		}
		return { x: X(x0), y: Y(y1), w: r6(x1 - x0), h: r6(y1 - y0), ref: names.get(c.source_component_id) ?? c.pcb_component_id }
	})
	const padOut = pads.map((p) => ({ x: X(p.x - p.w / 2), y: Y(p.y + p.h / 2), w: r6(p.w), h: r6(p.h) }))
	const holes = of("pcb_hole").map((p) => ({ x: X(p.x), y: Y(p.y), r: r6((p.hole_diameter ?? p.hole_width ?? 0) / 2) }))
	return { outline: { w, h }, parts, pads: padOut, holes }
}
