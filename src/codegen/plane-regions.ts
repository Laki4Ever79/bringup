// A 4-layer board's power layer (In2) shared by its wide rails (lead-2, 26 Nov 2026): tscircuit fills each copper pour
// over the whole layer, so several on one layer don't share it (an experiment on the arm: VIN_BRICK filled In2 and the
// servo rails got scraps). Each rail gets its own region instead: every cell of a grid over the board goes to the rail
// whose pad is nearest (a Voronoi partition of the rails' pads), and each rail's connected cells become one outline. A
// region enclosed by another rail's (a hole) is left out: two pours must not overlap.
export interface RailPads {
	net: string
	points: { x: number; y: number }[]
	// A cell goes to the rail with the least distance / weight (1 when absent): a heavier rail takes room from its
	// neighbours (powerPlaneRegions raises it while its neck is under its IPC-2221 width).
	weight?: number
}
export interface PlaneRegion {
	net: string
	outline: { x: number; y: number }[]
	cells: number
	// The narrowest passage that still joins all of this region's pads (mm): the bottleneck of the widest paths between
	// them, a cell's width being twice its distance to the region's edge. A rail's IPC-2221 width is held against it.
	neckMm: number
}

// Board coordinates centred on the board (tscircuit's), widthMm x heightMm, cells of stepMm, kept marginMm inside the edge;
// neighbouring rails' regions keep at least gapMm between them (the cells along a border with another rail are left out).
// within: the outline the regions must stay inside (the board less the antenna's keep-out band, circuit.ts antennaNotch);
// a cell with any corner outside it belongs to no rail.
export function planeRegions(widthMm: number, heightMm: number, rails: RailPads[], stepMm = 0.5, marginMm = 0.5, gapMm = 0.5, within: { x: number; y: number }[] | null = null): PlaneRegion[] {
	const pts = rails.flatMap((r, i) => r.points.map((p) => ({ ...p, i, w: r.weight ?? 1 })))
	if (!pts.length) return []
	const x0 = -widthMm / 2 + marginMm, y0 = -heightMm / 2 + marginMm
	const nx = Math.floor((widthMm - 2 * marginMm) / stepMm), ny = Math.floor((heightMm - 2 * marginMm) / stepMm)
	const owner: number[] = new Array(nx * ny)
	for (let j = 0; j < ny; j++)
		for (let i = 0; i < nx; i++) {
			const cx = x0 + (i + 0.5) * stepMm, cy = y0 + (j + 0.5) * stepMm
			let best = -1, bd = Infinity
			for (const p of pts) {
				const d = ((p.x - cx) ** 2 + (p.y - cy) ** 2) / (p.w * p.w)
				if (d < bd) [bd, best] = [d, p.i]
			}
			const e = stepMm / 2 - 1e-6
			owner[j * nx + i] = within && ![[-e, -e], [e, -e], [e, e], [-e, e]].every(([dx, dy]) => inside(within, cx + dx, cy + dy)) ? -1 : best
		}
	// The gap: each cell beside a cell of another rail is left out (both sides, so at least two cells between regions).
	const erode = Math.max(1, Math.ceil(gapMm / 2 / stepMm))
	const gap = owner.map((o, c) => {
		const i = c % nx, j = Math.floor(c / nx)
		for (let dj = -erode; dj <= erode; dj++)
			for (let di = -erode; di <= erode; di++) {
				const a = i + di, b = j + dj
				if (a >= 0 && b >= 0 && a < nx && b < ny && owner[b * nx + a] !== o) return -1
			}
		return o
	})
	for (let c = 0; c < owner.length; c++) owner[c] = gap[c]
	const seen = new Uint8Array(nx * ny)
	const out: PlaneRegion[] = []
	for (let start = 0; start < nx * ny; start++) {
		if (seen[start] || owner[start] < 0) continue
		const rail = owner[start]
		// The connected cells of this rail (4-neighbour flood fill).
		const comp: number[] = []
		const stack = [start]
		seen[start] = 1
		while (stack.length) {
			const c = stack.pop()!
			comp.push(c)
			const i = c % nx, j = Math.floor(c / nx)
			for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const a = i + di, b = j + dj
				if (a < 0 || b < 0 || a >= nx || b >= ny) continue
				const n = b * nx + a
				if (!seen[n] && owner[n] === rail) {
					seen[n] = 1
					stack.push(n)
				}
			}
		}
		// Its own pads must be inside: a piece holding none of the rail's pads carries nothing.
		const inComp = new Set(comp)
		const padCells = [...new Set(rails[rail].points.map((p) => Math.floor((p.y - y0) / stepMm) * nx + Math.floor((p.x - x0) / stepMm)).filter((c) => inComp.has(c)))]
		if (!padCells.length) continue
		const loops = boundary(comp, nx, x0, y0, stepMm)
		// A piece with a hole (another rail's region inside it) keeps its region: the holes joined to the outer loop by a
		// keyhole cut, one outline as a pour takes it (KiCad's own fills are drawn that way). Dropped before, the rail had
		// no region at all: the arm fixture's VSERVO3 once its buck's bootstrap capacitor sat between BOOT and SW (27 Nov
		// 2026).
		out.push({ net: rails[rail].net, outline: keyhole(loops), cells: comp.length, neckMm: neck(comp, inComp, padCells, nx, ny, stepMm) })
	}
	return out
}

// Even-odd ray test: is (x, y) inside the polygon?
function inside(poly: { x: number; y: number }[], x: number, y: number): boolean {
	let in_ = false
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [a, b] = [poly[i], poly[j]]
		if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) in_ = !in_
	}
	return in_
}

// One outline from a piece's boundary loops: the largest is the outer one, and each other (a hole) is spliced in at the
// pair of vertices nearest each other, walked round and back to the cut.
function keyhole(loops: { x: number; y: number }[][]): { x: number; y: number }[] {
	const area = (l: { x: number; y: number }[]) => Math.abs(l.reduce((a, p, i) => a + p.x * l[(i + 1) % l.length].y - l[(i + 1) % l.length].x * p.y, 0)) / 2
	const sorted = [...loops].sort((a, b) => area(b) - area(a))
	let outer = sorted[0]
	for (const hole of sorted.slice(1)) {
		let best = { d: Infinity, o: 0, h: 0 }
		outer.forEach((p, o) => hole.forEach((q, h) => {
			const d = Math.hypot(p.x - q.x, p.y - q.y)
			if (d < best.d) best = { d, o, h }
		}))
		const round = [...hole.slice(best.h), ...hole.slice(0, best.h), hole[best.h]]
		outer = [...outer.slice(0, best.o + 1), ...round, ...outer.slice(best.o)]
	}
	return outer
}

// The boundary loops of a set of grid cells: the cell edges not shared by two cells of the set, chained, with collinear
// points dropped.
function boundary(cells: number[], nx: number, x0: number, y0: number, step: number): { x: number; y: number }[][] {
	const set = new Set(cells)
	// Directed edges, counter-clockwise around each cell, on integer grid corners.
	const next = new Map<string, string[]>()
	const add = (a: [number, number], b: [number, number]) => {
		const k = `${a[0]},${a[1]}`
		next.set(k, [...(next.get(k) ?? []), `${b[0]},${b[1]}`])
	}
	for (const c of cells) {
		const i = c % nx, j = Math.floor(c / nx)
		const has = (a: number, b: number) => a >= 0 && b >= 0 && a < nx && set.has(b * nx + a)
		if (!has(i, j - 1)) add([i, j], [i + 1, j])
		if (!has(i + 1, j)) add([i + 1, j], [i + 1, j + 1])
		if (!has(i, j + 1)) add([i + 1, j + 1], [i, j + 1])
		if (!has(i - 1, j)) add([i, j + 1], [i, j])
	}
	const loops: { x: number; y: number }[][] = []
	while (next.size) {
		const first = next.keys().next().value!
		const loop: string[] = [first]
		let cur = first
		for (;;) {
			const outs = next.get(cur)!
			const to = outs.shift()!
			if (!outs.length) next.delete(cur)
			if (to === first) break
			loop.push(to)
			cur = to
			if (!next.has(cur)) break
		}
		const pts = loop.map((k) => k.split(",").map(Number) as [number, number])
		// Drop the points that lie on a straight run.
		const keep = pts.filter((p, k) => {
			const a = pts[(k - 1 + pts.length) % pts.length], b = pts[(k + 1) % pts.length]
			return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]))
		})
		loops.push(keep.map(([i, j]) => ({ x: +(x0 + i * step).toFixed(3), y: +(y0 + j * step).toFixed(3) })))
	}
	return loops
}

// The bottleneck width joining all the pad cells: each cell's width is twice its (chessboard) distance to the region's
// edge; cells are added widest first (union-find) until every pad cell is in one set; the width then is the neck.
function neck(comp: number[], inComp: Set<number>, padCells: number[], nx: number, ny: number, step: number): number {
	if (padCells.length < 2) return Infinity
	const dist = new Map<number, number>()
	let frontier = comp.filter((c) => {
		const i = c % nx, j = Math.floor(c / nx)
		return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => { const a = i + di, b = j + dj; return a < 0 || b < 0 || a >= nx || b >= ny || !inComp.has(b * nx + a) })
	})
	for (const c of frontier) dist.set(c, 1)
	for (let d = 2; frontier.length; d++) {
		const nextF: number[] = []
		for (const c of frontier) {
			const i = c % nx, j = Math.floor(c / nx)
			for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const n = (j + dj) * nx + (i + di)
				if (i + di >= 0 && i + di < nx && inComp.has(n) && !dist.has(n)) { dist.set(n, d); nextF.push(n) }
			}
		}
		frontier = nextF
	}
	const parent = new Map<number, number>()
	const find = (c: number): number => { let r = c; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(c, r); return r }
	const order = [...comp].sort((a, b) => dist.get(b)! - dist.get(a)!)
	const pads = new Set(padCells)
	for (const c of order) {
		parent.set(c, c)
		const i = c % nx, j = Math.floor(c / nx)
		for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const n = (j + dj) * nx + (i + di)
			if (i + di >= 0 && i + di < nx && parent.has(n)) parent.set(find(n), find(c))
		}
		// All pad cells in one set: the cell just added is the narrowest on the widest paths.
		const roots = new Set([...pads].filter((p) => parent.has(p)).map(find))
		if ([...pads].every((p) => parent.has(p)) && roots.size === 1) return +(2 * dist.get(c)! * step).toFixed(2)
	}
	return 0
}
