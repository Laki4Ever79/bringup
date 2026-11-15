// The Top view: an SVG top-down of a system (plate, mechanical outlines, boards, cables) that zooms onto a board and
// draws only while it moves. The API matches world3d.js's mountWorld. Geometry is top-layout.js's (SVG mm, y down);
// the view is the SVG viewBox, so pan and zoom change one attribute and nothing runs between gestures.
// Edit mode (setEdit): a board drags, the plate's corners resize it, a board's dot drags onto another for a cable, and a
// cable's leg midpoints and corners bend its route. During a drag only the dragged thing's attributes change (one
// group's transform, the plate's rect, one path); the page redraws the whole world on release. Findings (setFindings)
// colour their item's outline, and, at rest, put a message chip on it.
import { topLayout, boardShapes } from "./top-layout.js"

const MARGIN = 10 // the same margin as top-layout.js's bounds
const NS = "http://www.w3.org/2000/svg"
const el = (tag, attrs = {}, text) => {
	const e = document.createElementNS(NS, tag)
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
	if (text !== undefined) e.textContent = text
	return e
}
const INK = "var(--ink, #1c1c1c)", SIGNAL = "var(--signal, #e8590c)", PAPER2 = "var(--paper-2, #ece8df)", OK = "var(--ok, #2f9e44)", ERROR = "var(--error, #c8231a)", WARN = "var(--warn, #b86e00)"
const SNAP = 0.5 // mm, system-edit.js SNAP_MM
const snap = (v) => Math.round(v / SNAP) * SNAP + 0
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
const fmt = (v) => `${v.x} ${v.y} ${v.w} ${v.h}`
const grow = (r, k) => ({ x: r.x - (r.w * (k - 1)) / 2, y: r.y - (r.h * (k - 1)) / 2, w: r.w * k, h: r.h * k })

export function mountTop(host, opts = {}) {
	const svg = el("svg", { width: "100%", height: "100%", preserveAspectRatio: "xMidYMid meet" })
	svg.style.cssText = "display:block;touch-action:none;user-select:none;font:3px/1 var(--mono, ui-monospace, monospace)"
	const gPlate = el("g"), gMech = el("g"), gBoards = el("g"), gCables = el("g"), gLabels = el("g"), gBadges = el("g"), gEdit = el("g"), gChips = el("g")
	svg.append(gPlate, gMech, gBoards, gCables, gLabels, gBadges, gEdit, gChips)
	host.append(svg)

	// edit: the page's edit handlers while edit mode is on; gesture: the edit drag in progress; held: a world that arrived
	// during a drag, drawn on release; findings: the edit checks' findings, drawn on their items.
	let edit = null, gesture = null, held = null, findings = [], chipsOn = true, world = null, rebuilds = 0
	let scene = null, home = null, focusName = null, touched = false, view = { x: 0, y: 0, w: 100, h: 60 }, draws = 0, raf = 0, selected = null, disposed = false, finish = null, badges = {}
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

	// The worst finding on an item: "error", "warn" or null.
	const levelOf = (t) => {
		const mine = findings.filter((f) => (t.board != null && f.target.board === t.board) || (t.link != null && f.target.link === t.link) || (t.plate && f.target.plate))
		return mine.some((f) => f.level === "error") ? "error" : mine.length ? "warn" : null
	}
	// Selection and findings on the outlines: selected is orange, an error red, a warning amber.
	function applySelection() {
		for (const e of svg.querySelectorAll("[data-board],[data-cable]")) {
			const isBoard = e.dataset.board != null
			const on = selected && (e.dataset.board ?? e.dataset.cable) === selected.name && isBoard === (selected.kind === "board")
			const bad = edit ? levelOf(isBoard ? { board: e.dataset.board } : { link: e.dataset.cable }) : null
			if (bad) e.setAttribute("data-bad", bad); else e.removeAttribute("data-bad")
			const shape = e.querySelector(isBoard ? "[data-outline]" : "[data-line]")
			if (!shape) continue
			shape.setAttribute("stroke", on ? SIGNAL : bad === "error" ? ERROR : bad === "warn" ? WARN : isBoard ? INK : OK)
			shape.setAttribute("stroke-width", on || bad ? 1.2 : isBoard ? 0.6 : 0.8)
		}
		const plate = gPlate.querySelector("[data-plate]")
		if (plate) {
			const bad = edit ? levelOf({ plate: true }) : null
			if (bad) plate.setAttribute("data-bad", bad); else plate.removeAttribute("data-bad")
			plate.setAttribute("stroke", bad === "error" ? ERROR : bad === "warn" ? WARN : INK)
			plate.setAttribute("stroke-width", bad ? 1 : 0.4)
			plate.setAttribute("stroke-opacity", bad ? 1 : 0.5)
		}
	}
	const select = (name, kind = "board") => {
		if (!live()) return
		selected = name == null ? null : { name, kind }; applySelection(); draws++ }

	function setWorld(w) {
		if (!live()) return
		// A drag in progress owns its item's attributes: the world is drawn when it ends.
		if (gesture) { held = w; return }
		held = null
		world = w
		rebuilds++
		const boards = w.boards ?? []
		const links = w.cables ?? []
		scene = topLayout(w.assembly ?? null, boards, links)
		draws++
		for (const g of [gPlate, gMech, gBoards, gCables, gLabels]) g.replaceChildren()
		if (scene.plate) {
			const p = scene.plate
			gPlate.append(el("rect", { "data-plate": "", x: p.x, y: p.y, width: p.w, height: p.h, rx: 2, fill: PAPER2, stroke: INK, "stroke-width": 0.4, "stroke-opacity": 0.5 }))
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
			g.style.cursor = edit ? "move" : "pointer"
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
		drawBadges()
		drawEdit()
		drawChips()
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

	// A small status badge over each board's top-left corner (progress.js badgeOf: {text, kind, title}). Drawn in the
	// board's own place, upright; a board with no badge has none. Counts as one draw, and only when it changes.
	const BADGE = { ok: OK, run: SIGNAL, bad: "var(--error, #c8231a)", idle: INK }
	function drawBadges() {
		gBadges.replaceChildren()
		for (const b of scene?.boards ?? []) {
			const bd = badges[b.name]
			if (!bd) continue
			const w = bd.text.length * 1.9 + 2.4
			const g = el("g", { "data-badge": b.name, "data-kind": bd.kind, transform: `translate(${b.x + b.w - w} ${b.y - 4.6})`, "pointer-events": "none" })
			g.append(el("rect", { width: w, height: 4, rx: 1, fill: "#fff", stroke: BADGE[bd.kind] ?? INK, "stroke-width": 0.35 }), el("text", { x: w / 2, y: 2.05, "text-anchor": "middle", "dominant-baseline": "middle", fill: BADGE[bd.kind] ?? INK, "font-size": 2.5 }, bd.text))
			g.append(el("title", {}, bd.title ?? bd.text))
			gBadges.append(g)
		}
	}
	function setBadges(map) {
		if (!live()) return
		if (JSON.stringify(map ?? {}) === JSON.stringify(badges)) return
		badges = map ?? {}
		drawBadges()
		draws++
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

	// ── Edit mode ──
	// The handles: the plate's four corners (a robot's shared plate only), one dot per board (drag it onto another board
	// for a cable), and on each cable a handle at every leg's middle (drag to bend there) and at every bend (drag to move it).
	const CORNERS = { fl: [1, -1], fr: [1, 1], bl: [-1, -1], br: [-1, 1] } // SVG signs: front is +x, left is -y
	function drawEdit() {
		gEdit.replaceChildren()
		if (!edit || !scene) return
		const handle = { fill: "#fff", stroke: SIGNAL, "stroke-width": 0.4 }
		if (scene.plate && world?.assembly?.body === "chassis") {
			const p = scene.plate
			for (const [k, [sx, sy]] of Object.entries(CORNERS)) {
				const r = el("rect", { ...handle, "data-plate-handle": k, x: (sx * p.w) / 2 - 1.6, y: (sy * p.h) / 2 - 1.6, width: 3.2, height: 3.2 })
				r.style.cursor = sx === sy ? "nwse-resize" : "nesw-resize"
				r.append(el("title", {}, "Drag to resize the plate"))
				gEdit.append(r)
			}
		}
		for (const b of scene.boards) {
			const d = el("circle", { "data-dot": b.name, cx: b.x + b.w, cy: b.y + b.h / 2, r: 1.7, fill: SIGNAL, stroke: "#fff", "stroke-width": 0.5 })
			d.style.cursor = "crosshair"
			d.append(el("title", {}, "Drag onto another board for a cable"))
			gEdit.append(d)
		}
		for (const c of scene.cables) {
			const pts = c.points
			for (let i = 0; i + 1 < pts.length; i++) {
				const m = el("circle", { "data-route-handle": `${c.id}:${i}`, cx: (pts[i].x + pts[i + 1].x) / 2, cy: (pts[i].y + pts[i + 1].y) / 2, r: 1.2, fill: "#fff", stroke: OK, "stroke-width": 0.4 })
				m.style.cursor = "move"
				m.append(el("title", {}, "Drag to bend the cable"))
				gEdit.append(m)
			}
			for (let j = 1; j + 1 < pts.length; j++) {
				const v = el("circle", { "data-route-vertex": `${c.id}:${j}`, cx: pts[j].x, cy: pts[j].y, r: 1.2, fill: OK, stroke: "#fff", "stroke-width": 0.3 })
				v.style.cursor = "move"
				gEdit.append(v)
			}
		}
	}
	// A message chip under each item with a finding (its first message, with a count of the others), only at rest.
	function drawChips() {
		gChips.replaceChildren()
		gChips.style.display = chipsOn ? "" : "none"
		if (!edit || !scene || !chipsOn) return
		const groups = new Map()
		for (const f of findings) {
			const key = f.target.board != null ? `board:${f.target.board}` : f.target.link != null ? `link:${f.target.link}` : "plate"
			if (!groups.has(key)) groups.set(key, [])
			groups.get(key).push(f)
		}
		for (const [key, list] of groups) {
			let at = null
			if (key.startsWith("board:")) { const b = scene.boards.find((x) => x.name === key.slice(6)); if (b) at = { x: b.x, y: b.y + b.h + 1 } }
			else if (key.startsWith("link:")) { const c = scene.cables.find((x) => x.id === key.slice(5)); if (c) at = { x: c.mid.x, y: c.mid.y + 1 } }
			else if (scene.plate) at = { x: scene.plate.x + 2, y: scene.plate.y + 2 }
			if (!at) continue
			const worst = list.some((f) => f.level === "error") ? "error" : "warn"
			const first = list.find((f) => f.level === worst) ?? list[0]
			const short = first.message.length > 56 ? `${first.message.slice(0, 55)}…` : first.message
			const text = list.length > 1 ? `${short} (+${list.length - 1})` : short
			const w = text.length * 1.32 + 2.4
			const color = worst === "error" ? ERROR : WARN
			const g = el("g", { "data-chip": key, "data-level": worst, transform: `translate(${at.x} ${at.y})`, "pointer-events": "none" })
			g.append(el("rect", { width: w, height: 3.6, rx: 0.8, fill: "#fff", stroke: color, "stroke-width": 0.3 }), el("text", { x: 1.2, y: 1.85, "dominant-baseline": "middle", fill: color, "font-size": 2.2 }, text))
			g.append(el("title", {}, list.map((f) => f.message).join("\n")))
			gChips.append(g)
		}
	}
	// findings: system-edit.js's {target, level, message}. chips false (during a drag): outlines only.
	function setFindings(list, { chips = true } = {}) {
		if (!live()) return
		list = list ?? []
		if (chips === chipsOn && JSON.stringify(list) === JSON.stringify(findings)) return
		findings = list
		chipsOn = chips
		applySelection()
		drawChips()
		draws++
	}
	// handlers: {onDrag(board, xMm, yMm), onMove(board, xMm, yMm), onPlate(lengthMm, widthMm), onConnect(a, b, {x, y}),
	// onRoute(link, points)} in the chassis frame (+x forward, +y left); null leaves edit mode.
	function setEdit(handlers) {
		if (!live()) return
		edit = handlers ?? null
		if (!edit) { findings = []; chipsOn = true; gesture = null }
		for (const g of gBoards.querySelectorAll("[data-board]")) g.style.cursor = edit ? "move" : "pointer"
		applySelection()
		drawEdit()
		drawChips()
		draws++
	}
	const toSvg = (e) => { const m = svg.getScreenCTM(); if (!m) return { x: 0, y: 0 }; const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()); return { x: p.x, y: p.y } }
	// An edit drag starting on what is under the pointer, or null (empty space pans as always).
	function startGesture(e) {
		const t = e.target
		const corner = t.closest?.("[data-plate-handle]")
		const dot = t.closest?.("[data-dot]")
		const leg = t.closest?.("[data-route-handle],[data-route-vertex]")
		const board = t.closest?.("[data-board]")
		const base = { x: e.clientX, y: e.clientY, at: toSvg(e), moved: false }
		if (corner) return { ...base, kind: "plate", corner: corner.dataset.plateHandle }
		if (dot) return { ...base, kind: "wire", from: dot.dataset.dot, line: null }
		if (leg) {
			const [link, i] = (leg.dataset.routeHandle ?? leg.dataset.routeVertex).split(":")
			const c = scene.cables.find((x) => x.id === link)
			if (!c) return null
			return { ...base, kind: "route", link, leg: leg.dataset.routeHandle != null ? Number(i) : null, vertex: leg.dataset.routeVertex != null ? Number(i) : null, points: c.points.map((p) => ({ ...p })) }
		}
		if (board) {
			const b = scene.boards.find((x) => x.name === board.dataset.board)
			if (!b) return null
			return { ...base, kind: "board", name: b.name, group: board, transform: board.getAttribute("transform"), cx: b.x + b.w / 2, cy: -(b.y + b.h / 2), xMm: b.x + b.w / 2, yMm: -(b.y + b.h / 2) }
		}
		return null
	}
	function moveGesture(e) {
		const g = gesture
		if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) <= 3) return
		g.moved = true
		const p = toSvg(e), dx = p.x - g.at.x, dy = p.y - g.at.y
		if (g.kind === "board") {
			const x = snap(g.cx + dx), y = snap(g.cy - dy)
			if (x === g.xMm && y === g.yMm) return
			g.xMm = x; g.yMm = y
			g.group.setAttribute("transform", `translate(${x - g.cx} ${-(y - g.cy)}) ${g.transform}`)
			draws++
			edit?.onDrag?.(g.name, x, y)
		} else if (g.kind === "plate") {
			const L = Math.max(10, snap(2 * Math.abs(p.x))), W = Math.max(10, snap(2 * Math.abs(p.y)))
			if (L === g.L && W === g.W) return
			g.L = L; g.W = W
			const r = gPlate.querySelector("[data-plate]")
			r?.setAttribute("x", -L / 2); r?.setAttribute("y", -W / 2); r?.setAttribute("width", L); r?.setAttribute("height", W)
			for (const h of gEdit.querySelectorAll("[data-plate-handle]")) {
				const [sx, sy] = CORNERS[h.dataset.plateHandle]
				h.setAttribute("x", (sx * L) / 2 - 1.6); h.setAttribute("y", (sy * W) / 2 - 1.6)
			}
			draws++
			edit?.onPlateDrag?.(L, W)
		} else if (g.kind === "wire") {
			const from = gEdit.querySelector(`[data-dot="${CSS.escape(g.from)}"]`)
			if (!g.line) { g.line = el("path", { fill: "none", stroke: SIGNAL, "stroke-width": 0.6, "stroke-dasharray": "1.5 1.2", "pointer-events": "none" }); gEdit.append(g.line) }
			g.line.setAttribute("d", `M${from?.getAttribute("cx")} ${from?.getAttribute("cy")}L${p.x} ${p.y}`)
			draws++
		} else if (g.kind === "route") {
			// A leg's middle becomes a new bend on the first move; a bend moves.
			if (g.vertex == null) { g.points.splice(g.leg + 1, 0, { x: p.x, y: p.y }); g.vertex = g.leg + 1 }
			const at = { x: snap(p.x), y: snap(p.y) }
			g.points[g.vertex] = at
			const d = `M${g.points.map((q) => `${q.x} ${q.y}`).join("L")}`
			for (const path of gCables.querySelectorAll(`[data-cable="${CSS.escape(g.link)}"] path`)) path.setAttribute("d", d)
			draws++
		}
	}
	function endGesture(e) {
		const g = gesture
		gesture = null
		const before = rebuilds
		if (!g.moved) {
			if (g.kind === "board") opts.onPick?.(g.name, "board")
			else if (g.kind === "route") opts.onPick?.(g.link, "cable")
		} else if (g.kind === "board") edit?.onMove?.(g.name, g.xMm, g.yMm)
		else if (g.kind === "plate" && g.L) edit?.onPlate?.(g.L, g.W)
		else if (g.kind === "route") edit?.onRoute?.(g.link, g.points.map((q) => ({ xMm: q.x + 0, yMm: -q.y + 0 })))
		else if (g.kind === "wire") {
			g.line?.remove()
			const to = document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest?.("[data-board]")).find((n) => n && svg.contains(n))?.dataset.board
			if (to && to !== g.from) edit?.onConnect?.(g.from, to, { x: e.clientX, y: e.clientY })
		}
		// Unless the handler drew the world again: a world that came during the drag is drawn now, and a drag nobody took
		// is put back.
		if (rebuilds === before && (held || (g.moved && world))) setWorld(held ?? world)
	}

	// Pointer: hover by delegation; a click is a press that did not move; a drag pans by changing the viewBox.
	const hit = (e) => {
		const n = e.target.closest?.("[data-board],[data-cable]")
		return n ? (n.dataset.board != null ? { name: n.dataset.board, kind: "board" } : { name: n.dataset.cable, kind: "cable" }) : null
	}
	let hovered = null, press = null
	const onMove = (e) => {
		if (gesture) return moveGesture(e)
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
	const onDown = (e) => {
		if (!live()) return
		if (raf) { touched = true; focusName = null }
		stop()
		if (edit && e.button === 0) {
			const g = startGesture(e)
			if (g) {
				gesture = g
				try { svg.setPointerCapture(e.pointerId) } catch {}
				return
			}
		}
		press = { x: e.clientX, y: e.clientY, view, moved: false, hit: hit(e) }
	}
	const onUp = (e) => {
		if (gesture) return endGesture(e)
		const p = press; press = null; if (p && !p.moved && p.hit) opts.onPick?.(p.hit.name, p.hit.kind)
	}
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
	svg.addEventListener("pointercancel", () => { press = null; if (gesture) { const g = gesture; gesture = null; g.line?.remove(); setWorld(held ?? world) } })
	svg.addEventListener("wheel", onWheel, { passive: false })

	return {
		ready: Promise.resolve(),
		setWorld, focus, select, setBadges, setEdit, setFindings,
		dragging: () => Boolean(gesture),
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
