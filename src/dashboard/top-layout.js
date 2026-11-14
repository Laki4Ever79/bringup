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

export function topLayout(assembly, boards, links) {
	const placed = new Map()
	const given = assembly?.boards ?? []
	for (const a of given) placed.set(a.name, place(a.name, a.xMm, a.yMm, a.outline, a.rotDeg ?? 0, a.outlineSource === "built"))
	// Boards the assembly doesn't place (all of them for a separate body) go through autoLayout; when some are already
	// placed, the group stands to the right of the plate or of the placed boards.
	const missing = (boards ?? []).filter((b) => !placed.has(b.name)).map((b) => ({ name: b.name, outline: b.outline ?? FALLBACK, built: b.outline != null }))
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
		const from = end(A, B, svgA, svgB, l.a), to = end(B, A, svgB, svgA, l.b)
		const mid = { x: r6((from.x + to.x) / 2), y: r6((from.y + to.y) / 2) }
		cables.push({
			id: l.id, kind: l.kind,
			from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y },
			path: cablePath(from, to),
			label: [l.id, String(l.kind).toUpperCase(), ...(l.cable?.lengthMm > 0 ? [`${l.cable.lengthMm} mm`] : [])].join(" · "),
			mid,
		})
	}
	return { plate, boards: out, cables, bounds }
}
