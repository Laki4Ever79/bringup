// The Top view: an SVG top-down of a system (plate, mechanical outlines, boards, cables) that zooms onto a board and
// draws only while it moves. The API matches world3d.js's mountWorld. Geometry is top-layout.js's (SVG mm, y down);
// the view is the SVG viewBox, so pan and zoom change one attribute and nothing runs between gestures.
import { topLayout, boardShapes } from "./top-layout.js"

const MARGIN = 10 // the same margin as top-layout.js's bounds
const NS = "http://www.w3.org/2000/svg"
const el = (tag, attrs = {}, text) => {
	const e = document.createElementNS(NS, tag)
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
	if (text !== undefined) e.textContent = text
	return e
}
const INK = "var(--ink, #1c1c1c)", SIGNAL = "var(--signal, #e8590c)", PAPER2 = "var(--paper-2, #ece8df)", OK = "var(--ok, #2f9e44)"
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
const fmt = (v) => `${v.x} ${v.y} ${v.w} ${v.h}`
const grow = (r, k) => ({ x: r.x - (r.w * (k - 1)) / 2, y: r.y - (r.h * (k - 1)) / 2, w: r.w * k, h: r.h * k })

export function mountTop(host, opts = {}) {
	const svg = el("svg", { width: "100%", height: "100%", preserveAspectRatio: "xMidYMid meet" })
	svg.style.cssText = "display:block;touch-action:none;user-select:none;font:3px/1 var(--mono, ui-monospace, monospace)"
	const gPlate = el("g"), gMech = el("g"), gBoards = el("g"), gCables = el("g"), gLabels = el("g")
	svg.append(gPlate, gMech, gBoards, gCables, gLabels)
	host.append(svg)

	let scene = null, home = null, focusName = null, touched = false, view = { x: 0, y: 0, w: 100, h: 60 }, draws = 0, raf = 0, selected = null, disposed = false, finish = null
	// draws counts every real update of the drawing: a viewBox change (flight, pan, zoom), a rebuild, a selection.
	const setView = (v) => { const changed = fmt(v) !== fmt(view); view = v; svg.setAttribute("viewBox", fmt(v)); if (changed) draws++ }
	setView(view)

	const live = () => !disposed
	const stop = () => { flight = null; if (raf) cancelAnimationFrame(raf); raf = 0; if (finish) { const f = finish; finish = null; f() } }
	const targetOf = (name) => {
		const b = name == null ? null : scene?.boards.find((x) => x.name === name)
		return b ? grow({ x: b.x, y: b.y, w: b.w, h: b.h }, 1.25) : home
	}
	// The flight in progress: its end rect can be retargeted (a live update moved the board) without restarting.
	let flight = null
	function focus(name, { ms = 600 } = {}) {
		if (!live()) return Promise.resolve()
		stop()
		const to = targetOf(name)
		if (!to) return Promise.resolve()
		// A name that is not a board of the scene leaves the focus alone (targetOf fell back to home).
		const known = name == null || scene.boards.some((x) => x.name === name)
		if (!known) return Promise.resolve()
		focusName = name
		touched = false
		return new Promise((resolve) => {
			finish = resolve
			flight = { from: view, to, t0: performance.now(), ms }
			const step = (now) => {
				const f = flight, t = f.ms > 0 ? Math.min(1, (now - f.t0) / f.ms) : 1, k = ease(t)
				const next = t === 1 ? f.to : { x: f.from.x + (f.to.x - f.from.x) * k, y: f.from.y + (f.to.y - f.from.y) * k, w: f.from.w + (f.to.w - f.from.w) * k, h: f.from.h + (f.to.h - f.from.h) * k }
				if (fmt(next) !== fmt(view)) setView(next)
				if (t < 1) raf = requestAnimationFrame(step)
				else { raf = 0; flight = null; const r = finish; finish = null; r?.() }
			}
			raf = requestAnimationFrame(step)
		})
	}

	function applySelection() {
		for (const e of svg.querySelectorAll("[data-board],[data-cable]")) {
			const on = selected && (e.dataset.board ?? e.dataset.cable) === selected.name && (e.dataset.board != null) === (selected.kind === "board")
			const shape = e.querySelector(e.dataset.board != null ? "[data-outline]" : "[data-line]")
			if (shape) shape.setAttribute("stroke", on ? SIGNAL : e.dataset.board != null ? INK : OK)
			if (shape) shape.setAttribute("stroke-width", on ? 1.2 : e.dataset.board != null ? 0.6 : 0.8)
		}
	}
	const select = (name, kind = "board") => {
		if (!live()) return
		selected = name == null ? null : { name, kind }; applySelection(); draws++ }

	function setWorld(w) {
		if (!live()) return
		const boards = w.boards ?? []
		const links = w.cables ?? []
		scene = topLayout(w.assembly ?? null, boards, links)
		draws++
		for (const g of [gPlate, gMech, gBoards, gCables, gLabels]) g.replaceChildren()
		if (scene.plate) {
			const p = scene.plate
			gPlate.append(el("rect", { x: p.x, y: p.y, width: p.w, height: p.h, rx: 2, fill: PAPER2, stroke: INK, "stroke-width": 0.4, "stroke-opacity": 0.5 }))
			if (w.assembly?.body === "chassis") {
				// Standoff holes at each board's four corners. 3.5 mm is BOARD_HOLE_INSET_MM in src/tools/chassis.ts (the spec's
				// boards[].holeInsetMm); browser JS can't import it.
				for (const b of scene.boards) for (const [hx, hy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
					const inset = 3.5
					gPlate.append(el("circle", { cx: b.x + inset + hx * (b.w - 2 * inset), cy: b.y + inset + hy * (b.h - 2 * inset), r: 1.1, fill: "none", stroke: INK, "stroke-width": 0.3, "stroke-opacity": 0.6, "data-hole": "" }))
				}
			}
		}
		const mech = drawChassis(w.chassis)
		for (const b of scene.boards) {
			const info = boards.find((x) => x.name === b.name) ?? {}
			const turned = b.rotDeg === 90 || b.rotDeg === 270
			const W = turned ? b.h : b.w, H = turned ? b.w : b.h
			const kase = caseOuter(info.caseSpec)
			if (kase) {
				// Home takes the case in too: its footprint in SVG, turned with the board.
				const cw = turned ? kase.h : kase.w, chh = turned ? kase.w : kase.h
				mech.push({ x: b.x + b.w / 2 - cw / 2, y: b.y + b.h / 2 - chh / 2, w: cw, h: chh })
			}
			const g = el("g", { "data-board": b.name, "data-built": String(b.built), transform: `translate(${b.x + b.w / 2} ${b.y + b.h / 2}) rotate(${-b.rotDeg}) translate(${-W / 2} ${-H / 2})` })
			g.style.cursor = "pointer"
			// The board's own case: its outer footprint, dashed like the other mechanical outlines, centred on the board
			// and inside the board's group so it turns with it. It takes no clicks: the board under it does.
			if (kase) g.append(el("rect", { "data-case": "", "data-mech": "case", x: (W - kase.w) / 2, y: (H - kase.h) / 2, width: kase.w, height: kase.h, rx: 1.5, fill: "none", stroke: INK, "stroke-width": 0.35, "stroke-dasharray": "1.5 1", "stroke-opacity": 0.7, "pointer-events": "none" }))
			if (!b.built) {
				g.append(el("rect", { "data-outline": "", width: W, height: H, fill: "none", stroke: INK, "stroke-width": 0.6, "stroke-dasharray": "2 1.5", "pointer-events": "all" }))
				// Upright text inside the (possibly turned) group.
				const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", "dominant-baseline": "middle", fill: INK, "font-size": 3.2, transform: `rotate(${b.rotDeg} ${W / 2} ${H / 2})` })
				t.append(el("tspan", { x: W / 2, dy: "-0.6em" }, b.name), el("tspan", { x: W / 2, dy: "1.4em", "fill-opacity": 0.6 }, `${Math.round(W)} × ${Math.round(H)} mm`))
				g.append(t)
			} else {
				const s = info.circuit ? boardShapes(info.circuit) : null
				g.append(el("rect", { "data-outline": "", width: W, height: H, fill: PAPER2, "fill-opacity": 0.6, stroke: INK, "stroke-width": 0.6, "pointer-events": "all" }))
				for (const p of s?.parts ?? []) g.append(el("rect", { x: p.x, y: p.y, width: p.w, height: p.h, fill: INK, "fill-opacity": 0.18, stroke: INK, "stroke-width": 0.15, "stroke-opacity": 0.5, "data-part": p.ref }))
				for (const p of s?.pads ?? []) g.append(el("rect", { x: p.x, y: p.y, width: p.w, height: p.h, fill: SIGNAL, "fill-opacity": 0.7, "data-pad": "" }))
				const t = el("text", { x: 1.5, y: -1.2, fill: INK, "font-size": 3, transform: `rotate(${b.rotDeg} 0 0)` }, b.name)
				g.append(t)
			}
			gBoards.append(g)
		}
		for (const c of scene.cables) {
			const g = el("g", { "data-cable": c.id })
			g.style.cursor = "pointer"
			g.append(el("path", { "data-line": "", d: c.path, fill: "none", stroke: OK, "stroke-width": 0.8, "stroke-linecap": "round" }))
			// A wider invisible stroke so a cable is easy to hit.
			g.append(el("path", { d: c.path, fill: "none", stroke: "transparent", "stroke-width": 4, "pointer-events": "stroke" }))
			gCables.append(g)
			gLabels.append(el("text", { x: c.mid.x, y: c.mid.y - 1.5, "text-anchor": "middle", fill: INK, "font-size": 2.6, "pointer-events": "none" }, c.label))
		}
		applySelection()
		// Home: the layout's bounds plus the mechanical parts, with the same margin (wheels stand outside the plate).
		const b = scene.bounds
		let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h
		for (const r of mech) { x0 = Math.min(x0, r.x - MARGIN); y0 = Math.min(y0, r.y - MARGIN); x1 = Math.max(x1, r.x + r.w + MARGIN); y1 = Math.max(y1, r.y + r.h + MARGIN) }
		home = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
		// A live update must not undo the user's view: keep a focused board framed (retargeting a flight in progress),
		// leave a panned or zoomed view alone, and fit only while nothing was chosen.
		if (focusName != null && !scene.boards.some((x) => x.name === focusName)) {
			// The focused board is gone: go home once and leave the view alone from then on.
			stop(); focusName = null; touched = true; setView(home)
		} else if (flight) flight.to = targetOf(focusName)
		else if (focusName != null) { const t = targetOf(focusName); if (t) setView(t) }
		else if (!touched) setView(home)
	}

	// A case's outer footprint from its enclosure spec.json (py/enclosure.py): the case board's outline plus clearance and
	// a wall on each side, as src/contract/case.ts caseOuter. null when the spec doesn't give them.
	function caseOuter(spec) {
		const o = spec?.outline, wall = Number(spec?.wallMm), clear = Number(spec?.clearanceMm)
		if (!(o?.widthMm > 0 && o?.heightMm > 0 && wall > 0 && clear >= 0)) return null
		return { w: o.widthMm + 2 * (clear + wall), h: o.heightMm + 2 * (clear + wall) }
	}

	// Mechanical outlines from the chassis spec.json (x forward = SVG x, y left = SVG -y).
	function drawChassis(ch) {
		const rects = []
		if (!ch) return rects
		const line = { fill: "none", stroke: INK, "stroke-width": 0.35, "stroke-dasharray": "1.5 1", "stroke-opacity": 0.7, "pointer-events": "none" }
		const box = (kind, cx, cy, w, h) => { rects.push({ x: cx - w / 2, y: -cy - h / 2, w, h }); gMech.append(el("rect", { ...line, "data-mech": kind, x: cx - w / 2, y: -cy - h / 2, width: w, height: h, rx: 0.8 })) }
		const d = ch.drive
		if (d) for (const s of [1, -1]) box("wheel", d.axleXMm, s * (d.trackMm / 2), d.wheelDiameterMm, d.wheelWidthMm)
		for (const m of ch.motors ?? []) box("motor", m.xMm, m.yMm, m.bodyMm[0], m.bodyMm[1])
		if (ch.caster) { const r = ch.caster.wheelMm / 2; rects.push({ x: ch.caster.xMm - r, y: -r, w: 2 * r, h: 2 * r }); gMech.append(el("circle", { ...line, "data-mech": "caster", cx: ch.caster.xMm, cy: 0, r })) }
		if (ch.battery) box("battery", ch.battery.xMm, ch.battery.yMm, ch.battery.sizeMm[0], ch.battery.sizeMm[1])
		return rects
	}

	// Pointer: hover by delegation; a click is a press that did not move; a drag pans by changing the viewBox.
	const hit = (e) => {
		const n = e.target.closest?.("[data-board],[data-cable]")
		return n ? (n.dataset.board != null ? { name: n.dataset.board, kind: "board" } : { name: n.dataset.cable, kind: "cable" }) : null
	}
	let hovered = null, press = null
	const onMove = (e) => {
		if (press) {
			const r = svg.getBoundingClientRect(), k = Math.max(view.w / r.width, view.h / r.height)
			const dx = e.clientX - press.x, dy = e.clientY - press.y
			if (Math.hypot(dx, dy) > 3) press.moved = true
			if (press.moved) touched = true, focusName = null
			if (press.moved) setView({ ...view, x: press.view.x - dx * k, y: press.view.y - dy * k })
			return
		}
		const h = hit(e), key = h ? `${h.kind}:${h.name}` : null
		if (key !== hovered) { hovered = key; opts.onHover?.(h ? h.name : null, h ? h.kind : "board") }
	}
	const onDown = (e) => { if (!live()) return; if (raf) { touched = true; focusName = null } stop(); press = { x: e.clientX, y: e.clientY, view, moved: false, hit: hit(e) } }
	const onUp = () => { const p = press; press = null; if (p && !p.moved && p.hit) opts.onPick?.(p.hit.name, p.hit.kind) }
	const onLeave = () => { if (hovered) { hovered = null; opts.onHover?.(null, "board") } }
	const onWheel = (e) => {
		e.preventDefault()
		stop()
		touched = true
		focusName = null
		const r = svg.getBoundingClientRect(), k = Math.max(view.w / r.width, view.h / r.height)
		const f = Math.exp(e.deltaY * 0.0015)
		// Zoom about the cursor: the point under it stays put.
		const px = view.x + (e.clientX - (r.left + r.width / 2)) * k + view.w / 2, py = view.y + (e.clientY - (r.top + r.height / 2)) * k + view.h / 2
		setView({ x: px - (px - view.x) * f, y: py - (py - view.y) * f, w: view.w * f, h: view.h * f })
	}
	svg.addEventListener("pointermove", onMove)
	svg.addEventListener("pointerdown", onDown)
	window.addEventListener("pointerup", onUp)
	svg.addEventListener("pointerleave", onLeave)
	svg.addEventListener("pointercancel", () => { press = null })
	svg.addEventListener("wheel", onWheel, { passive: false })

	return {
		ready: Promise.resolve(),
		setWorld, focus, select,
		stats: () => ({ draws, boards: scene?.boards.length ?? 0 }),
		dispose() {
			if (disposed) return
			disposed = true
			stop()
			window.removeEventListener("pointerup", onUp)
			press = null
			svg.remove()
		},
	}
}
