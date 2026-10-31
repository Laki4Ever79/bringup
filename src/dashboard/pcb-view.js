// Live vector PCB for the dashboard stage, drawn in SVG straight from tscircuit's circuit.json: board, copper by
// net, pads, vias, part outlines with refs. Hover a part to learn what it is; highlight(ref) dims everything else;
// parts that changed in a revision glow for about 2 s. Plain ES module with no dependencies, served at /pcb-view.js;
// the pure helpers at the top are tested in Node.

export const PCB_COLORS = {
	bg: "#0a0a0a",
	board: "#0f2a1d",
	edge: "#1f4d36",
	copperTop: "#d4a24c",
	copperBottom: "#4c8ed4",
	pad: "#e8c27a",
	silk: "#e5e7eb",
	gnd: "#64748b",
	power: "#ef4444",
	accent: "#f59e0b",
	// Signal nets cycle through the agent colours (no red: red means power).
	signals: ["#3b82f6", "#a855f7", "#14b8a6", "#22c55e", "#ec4899", "#06b6d4", "#eab308", "#f97316", "#f59e0b"],
}

const GND = /^(A|D|P)?GND\w*$|^VSS\w*$/i
const POWER = /^(V(3V3|3V0|1V8|5V0|CC|DD|BUS|BAT|SYS|IN|OUT|REG)\w*|\+?\d+V\d*\w*|\w*3V3\w*)$/i

export function netColor(name, index) {
	if (!name) return PCB_COLORS.copperTop
	if (GND.test(name)) return PCB_COLORS.gnd
	if (POWER.test(name)) return PCB_COLORS.power
	return PCB_COLORS.signals[index % PCB_COLORS.signals.length]
}

const PAD_MARGIN_MM = 0.6

// One pass over circuit.json into what the view draws: refs, nets, outlines from pads (pcb_component's width and
// height are given before rotation, the pads are where the copper really is).
export function circuitIndex(circuit) {
	const els = Array.isArray(circuit) ? circuit : []
	const of = (type) => els.filter((e) => e.type === type)
	const board = of("pcb_board")[0]
	const sourceComponents = new Map(of("source_component").map((e) => [e.source_component_id, e]))
	const sourcePorts = new Map(of("source_port").map((e) => [e.source_port_id, e]))
	const sourceNets = new Map(of("source_net").map((e) => [e.source_net_id, e.name]))
	const sourceTraces = new Map(of("source_trace").map((e) => [e.source_trace_id, e]))
	const pcbPorts = new Map(of("pcb_port").map((e) => [e.pcb_port_id, e]))
	const refByPcbComponent = new Map(of("pcb_component").map((e) => [e.pcb_component_id, sourceComponents.get(e.source_component_id)?.name ?? e.pcb_component_id]))

	// Net of a source port, from the source traces that tie it to a named net.
	const portNet = new Map()
	for (const t of sourceTraces.values()) {
		const net = (t.connected_source_net_ids ?? []).map((id) => sourceNets.get(id)).find(Boolean)
		if (net) for (const p of t.connected_source_port_ids ?? []) portNet.set(p, net)
	}
	const netOfConnection = (name) => {
		if (sourceNets.has(name)) return sourceNets.get(name)
		const t = sourceTraces.get(name)
		const viaNet = (t?.connected_source_net_ids ?? []).map((id) => sourceNets.get(id)).find(Boolean)
		if (viaNet) return viaNet
		return (t?.connected_source_port_ids ?? []).map((p) => portNet.get(p)).find(Boolean) ?? null
	}

	const traces = of("pcb_trace").map((t) => {
		const net = netOfConnection(t.connection_name) ?? (t.connectsTo ?? []).map((p) => portNet.get(pcbPorts.get(p)?.source_port_id)).find(Boolean) ?? null
		const segments = []
		const route = t.route ?? []
		for (let i = 1; i < route.length; i++) {
			const a = route[i - 1], b = route[i]
			if (a.x === b.x && a.y === b.y) continue
			const layer = b.route_type === "wire" ? b.layer : a.layer ?? b.to_layer ?? "top"
			segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: b.width ?? a.width ?? 0.15, layer: layer === "bottom" ? "bottom" : "top" })
		}
		const refs = [...new Set((t.connectsTo ?? []).map((p) => refByPcbComponent.get(pcbPorts.get(p)?.pcb_component_id)).filter(Boolean))]
		return { id: t.pcb_trace_id, net, refs, segments }
	})

	// Pad nets: the source net, else the net of a trace that lands on the pad's port.
	const traceNetByPort = new Map()
	for (const t of of("pcb_trace")) {
		const tr = traces.find((x) => x.id === t.pcb_trace_id)
		for (const p of t.connectsTo ?? []) if (tr?.net && !traceNetByPort.has(p)) traceNetByPort.set(p, tr.net)
	}
	const padNet = (pcbPortId) => {
		const port = pcbPorts.get(pcbPortId)
		return portNet.get(port?.source_port_id) ?? traceNetByPort.get(pcbPortId) ?? null
	}
	const pads = [
		...of("pcb_smtpad").map((p) => ({
			kind: "smt", ref: refByPcbComponent.get(p.pcb_component_id) ?? null, net: padNet(p.pcb_port_id), layer: p.layer === "bottom" ? "bottom" : "top",
			shape: p.shape, x: p.x, y: p.y, w: p.width ?? (p.radius ?? 0) * 2, h: p.height ?? (p.radius ?? 0) * 2,
		})),
		...of("pcb_plated_hole").map((p) => ({
			kind: "pth", ref: refByPcbComponent.get(p.pcb_component_id) ?? null, net: padNet(p.pcb_port_id), layer: "both",
			shape: p.shape, x: p.x, y: p.y, w: p.outer_width ?? p.outer_diameter ?? 1, h: p.outer_height ?? p.outer_diameter ?? 1,
			holeW: p.hole_width ?? p.hole_diameter ?? 0.5, holeH: p.hole_height ?? p.hole_diameter ?? 0.5,
		})),
	]

	const components = of("pcb_component").map((c) => {
		const ref = refByPcbComponent.get(c.pcb_component_id)
		const mine = pads.filter((p) => p.ref === ref)
		let x0, y0, x1, y1
		if (mine.length > 0) {
			x0 = Math.min(...mine.map((p) => p.x - p.w / 2)) - PAD_MARGIN_MM
			x1 = Math.max(...mine.map((p) => p.x + p.w / 2)) + PAD_MARGIN_MM
			y0 = Math.min(...mine.map((p) => p.y - p.h / 2)) - PAD_MARGIN_MM
			y1 = Math.max(...mine.map((p) => p.y + p.h / 2)) + PAD_MARGIN_MM
		} else {
			const quarter = Math.round((c.rotation ?? 0) / 90) % 2 !== 0
			const w = quarter ? c.height : c.width, h = quarter ? c.width : c.height
			x0 = c.center.x - w / 2; x1 = c.center.x + w / 2; y0 = c.center.y - h / 2; y1 = c.center.y + h / 2
		}
		return { id: c.pcb_component_id, ref, layer: c.layer === "bottom" ? "bottom" : "top", x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
	})

	const vias = [
		...of("pcb_via").map((v) => ({ x: v.x, y: v.y, outer: v.outer_diameter ?? 0.6, hole: v.hole_diameter ?? 0.3 })),
	]
	const b = board ?? {}
	const nets = [...new Set([...traces.map((t) => t.net), ...pads.map((p) => p.net)].filter(Boolean))].sort()
	return {
		board: board ? { cx: b.center?.x ?? 0, cy: b.center?.y ?? 0, w: b.width, h: b.height, thickness: b.thickness ?? 1.6, layers: b.num_layers ?? 2 } : null,
		components, pads, traces, vias, nets,
	}
}

export function indexBounds(ix) {
	if (ix.board) return { minX: ix.board.cx - ix.board.w / 2, minY: ix.board.cy - ix.board.h / 2, maxX: ix.board.cx + ix.board.w / 2, maxY: ix.board.cy + ix.board.h / 2 }
	const xs = ix.components.flatMap((c) => [c.x0, c.x1]), ys = ix.components.flatMap((c) => [c.y0, c.y1])
	return xs.length ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } : { minX: -10, minY: -10, maxX: 10, maxY: 10 }
}

// Board millimetres (y up) to container pixels (y down), fitted with `padding` px on every side.
export function fitTransform(bounds, width, height, padding = 24) {
	const bw = bounds.maxX - bounds.minX || 1, bh = bounds.maxY - bounds.minY || 1
	const scale = Math.max(1e-6, Math.min((width - 2 * padding) / bw, (height - 2 * padding) / bh))
	const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2
	return { scale, apply: (x, y) => [width / 2 + (x - cx) * scale, height / 2 - (y - cy) * scale] }
}

// Refs whose outline moved, that appeared, or whose pads now sit on different nets.
export function diffRefs(prev, next) {
	const sig = (circuit) => {
		const ix = circuitIndex(circuit ?? [])
		const out = new Map()
		for (const c of ix.components) {
			const nets = ix.pads.filter((p) => p.ref === c.ref).map((p) => p.net ?? "-")
			const traceNets = ix.traces.filter((t) => t.refs.includes(c.ref)).map((t) => t.net ?? "-")
			out.set(c.ref, [c.x0, c.y0, c.x1, c.y1].map((v) => v.toFixed(2)).join(",") + "|" + [...nets, "/", ...traceNets.sort()].join(","))
		}
		return out
	}
	const a = sig(prev), b = sig(next)
	return [...b.keys()].filter((ref) => a.get(ref) !== b.get(ref))
}

// ---------------------------------------------------------------------------------------------------------------
// DOM view

const SVG = "http://www.w3.org/2000/svg"
const FONT = 'ui-sans-serif, -apple-system, "SF Pro Display", "Inter", "Segoe UI", system-ui, sans-serif'
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace'
const EASE = "cubic-bezier(.2,.8,.2,1)"
const GLOW_MS = 2000

const STYLE = `
.pcb-root { position: absolute; inset: 0; overflow: hidden; font-family: ${FONT}; color: #ededed; user-select: none; }
.pcb-root svg { width: 100%; height: 100%; display: block; cursor: grab; }
.pcb-root svg.pcb-panning { cursor: grabbing; }
.pcb-root .pcb-part, .pcb-root .pcb-trace, .pcb-root .pcb-pad, .pcb-root .pcb-via { transition: opacity 160ms ${EASE}; }
.pcb-root .pcb-dim { opacity: .16; }
.pcb-root .pcb-part .pcb-outline { fill: rgba(237,237,237,.025); stroke: ${PCB_COLORS.silk}; stroke-opacity: .55; transition: stroke-opacity 160ms ${EASE}, fill 160ms ${EASE}; }
.pcb-root .pcb-part:hover .pcb-outline, .pcb-root .pcb-part.pcb-focus .pcb-outline { stroke-opacity: 1; fill: rgba(237,237,237,.07); }
.pcb-root .pcb-part .pcb-ref { fill: ${PCB_COLORS.silk}; fill-opacity: .8; font-family: ${MONO}; font-weight: 600; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
.pcb-root .pcb-pulse { fill: none; stroke: ${PCB_COLORS.accent}; opacity: 0; pointer-events: none; animation: pcb-pulse ${GLOW_MS}ms ${EASE} forwards; }
@keyframes pcb-pulse { 0% { opacity: 0 } 12% { opacity: 1 } 60% { opacity: .85 } 100% { opacity: 0 } }
/* Marks: what the current change added (NEW) or changed, kept while that change is on screen; a slow breath. */
.pcb-root .pcb-mark { fill: rgba(255,74,23,.10); stroke: #ff4a17; pointer-events: none; animation: pcb-breathe 2.4s cubic-bezier(.32,.72,0,1) infinite; }
.pcb-root .pcb-mark.pcb-mark-changed { fill: rgba(245,158,11,.08); stroke: ${PCB_COLORS.accent}; }
.pcb-root .pcb-mark-tag { font-family: ${MONO}; font-weight: 700; letter-spacing: .08em; fill: #ff4a17; pointer-events: none; text-anchor: middle; }
.pcb-root .pcb-mark-tag.pcb-mark-changed { fill: ${PCB_COLORS.accent}; }
@keyframes pcb-breathe { 0%, 100% { stroke-opacity: .55; stroke-width: .25; } 50% { stroke-opacity: 1; stroke-width: .5; } }
.pcb-root.pcb-view-top .pcb-layer-bottom { opacity: .12; }
.pcb-root.pcb-view-bottom .pcb-layer-top { opacity: .12; }
.pcb-tip { position: absolute; pointer-events: none; padding: 8px 10px; border-radius: 8px; background: rgba(22,22,26,.86);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid #2e2e35; box-shadow: 0 8px 24px rgba(0,0,0,.45);
  font-size: 13px; line-height: 1.35; white-space: nowrap; opacity: 0; transform: translateY(4px); transition: opacity 160ms ${EASE}, transform 160ms ${EASE}; }
.pcb-tip.pcb-on { opacity: 1; transform: none; }
.pcb-tip b { font-family: ${MONO}; font-size: 15px; letter-spacing: .02em; }
.pcb-tip .pcb-mpn { font-family: ${MONO}; color: #a1a1aa; }
.pcb-tip .pcb-role { display: inline-block; margin-left: 6px; padding: 0 8px; border-radius: 999px; border: 1px solid #2e2e35; color: #a1a1aa; font-size: 12px; }
.pcb-tip .pcb-nets { color: #6b6b76; margin-top: 2px; }
.pcb-legend { position: absolute; left: 14px; bottom: 12px; display: flex; flex-wrap: wrap; gap: 6px 12px; max-width: 70%;
  font-size: 13px; color: #a1a1aa; pointer-events: none; }
.pcb-legend span { display: inline-flex; align-items: center; gap: 6px; font-family: ${MONO}; font-variant-numeric: tabular-nums; }
.pcb-legend i { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
@media (prefers-reduced-motion: reduce) { .pcb-root .pcb-mark { animation: none; stroke-width: .4; } .pcb-root .pcb-pulse { animation-duration: 1ms; } .pcb-root * { transition: none !important; } }
`

function el(tag, attrs = {}, parent) {
	const e = document.createElementNS(SVG, tag)
	for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v))
	if (parent) parent.appendChild(e)
	return e
}

const html = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

export function mountPcb(host, opts = {}) {
	if (getComputedStyle(host).position === "static") host.style.position = "relative"
	const root = document.createElement("div")
	root.className = "pcb-root pcb-view-both"
	const style = document.createElement("style")
	style.textContent = STYLE
	root.appendChild(style)
	const svg = el("svg", { role: "img", "aria-label": "printed circuit board" }, root)
	const tip = document.createElement("div")
	tip.className = "pcb-tip"
	const legend = document.createElement("div")
	legend.className = "pcb-legend"
	root.append(tip, legend)
	host.appendChild(root)

	let parts = new Map((opts.parts ?? []).map((p) => [p.ref, p]))
	let circuit = null
	let lastKey = ""
	let ix = null
	let base = null // fitted viewBox [x, y, w, h] in mm, svg y = -board y
	let view = null // current viewBox after zoom/pan
	let focused = null
	// A part lit like a light (the bench LED mirrored on the design): its ref and colour, or null.
	let lit = null
	let userMoved = false // set by wheel or drag; a resize refits until then
	const byRef = new Map() // ref -> { group, outline }

	// Extension: opts.onView({ view, width, height, board }) after every zoom, pan or refit (the page's rulers).
	const setViewBox = () => {
		if (!view) return
		svg.setAttribute("viewBox", view.map((v) => v.toFixed(3)).join(" "))
		const r = svg.getBoundingClientRect()
		opts.onView?.({ view: [...view], width: r.width || host.clientWidth, height: r.height || host.clientHeight, board: ix && indexBounds(ix) })
	}

	const fit = () => {
		if (!ix) return
		const b = indexBounds(ix)
		const w = host.clientWidth || 800, h = host.clientHeight || 500
		const f = fitTransform(b, w, h, Math.max(24, Math.min(w, h) * 0.06))
		const vw = w / f.scale, vh = h / f.scale
		const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
		base = [cx - vw / 2, -cy - vh / 2, vw, vh]
		view = [...base]
		userMoved = false
		setViewBox()
	}

	function render() {
		svg.textContent = ""
		byRef.clear()
		const defs = el("defs", {}, svg)
		const glow = el("filter", { id: "pcb-glow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs)
		el("feGaussianBlur", { stdDeviation: 0.45, result: "b" }, glow)
		const merge = el("feMerge", {}, glow)
		el("feMergeNode", { in: "b" }, merge)
		el("feMergeNode", { in: "b" }, merge)
		el("feMergeNode", { in: "SourceGraphic" }, merge)
		const grid = el("pattern", { id: "pcb-grid", width: 2.54, height: 2.54, patternUnits: "userSpaceOnUse" }, defs)
		el("circle", { cx: 1.27, cy: 1.27, r: 0.07, fill: "#ffffff", "fill-opacity": 0.07 }, grid)
		const sheen = el("radialGradient", { id: "pcb-sheen", cx: "18%", cy: "12%", r: "95%" }, defs)
		el("stop", { offset: "0%", "stop-color": "#1e4a35", "stop-opacity": 0.9 }, sheen)
		el("stop", { offset: "100%", "stop-color": PCB_COLORS.board, "stop-opacity": 1 }, sheen)

		const b = indexBounds(ix)
		const W = b.maxX - b.minX, H = b.maxY - b.minY
		const r = Math.min(1.2, Math.min(W, H) * 0.04)
		// Soft shadow under the board, then the board, its sheen and a 2.54 mm dot grid.
		el("rect", { x: b.minX + 0.6, y: -b.maxY + 0.9, width: W, height: H, rx: r, fill: "#000", "fill-opacity": 0.55, filter: "url(#pcb-glow)" }, svg)
		el("rect", { x: b.minX, y: -b.maxY, width: W, height: H, rx: r, fill: "url(#pcb-sheen)", stroke: PCB_COLORS.edge, "stroke-width": 0.35 }, svg)
		el("rect", { x: b.minX, y: -b.maxY, width: W, height: H, rx: r, fill: "url(#pcb-grid)" }, svg)

		const netIndex = new Map(ix.nets.filter((n) => !GND.test(n) && !POWER.test(n)).map((n, i) => [n, i]))
		const colorOf = (net) => netColor(net, netIndex.get(net) ?? 0)
		const colors = opts.colors ?? {}

		for (const layer of ["bottom", "top"]) {
			const g = el("g", { class: `pcb-layer-${layer}` }, svg)
			for (const t of ix.traces) {
				const segs = t.segments.filter((s) => s.layer === layer)
				if (segs.length === 0) continue
				const path = segs.map((s) => `M${s.x1} ${-s.y1}L${s.x2} ${-s.y2}`).join("")
				el("path", {
					class: "pcb-trace", d: path, "data-refs": t.refs.join(" "), "data-net": t.net ?? "",
					stroke: colors[t.net] ?? colorOf(t.net), "stroke-opacity": layer === "bottom" ? 0.7 : 0.95,
					"stroke-width": Math.max(0.15, segs[0].width), "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none",
				}, g)
			}
		}

		const padLayer = el("g", {}, svg)
		for (const p of ix.pads) {
			const g = el("g", { class: `pcb-pad pcb-layer-${p.layer === "bottom" ? "bottom" : "top"}`, "data-ref": p.ref ?? "" }, padLayer)
			const round = p.shape === "circle" || p.shape === "pill" || p.shape === "oval"
			el("rect", {
				x: p.x - p.w / 2, y: -p.y - p.h / 2, width: p.w, height: p.h, rx: round ? Math.min(p.w, p.h) / 2 : Math.min(p.w, p.h) * 0.18,
				fill: p.layer === "bottom" ? PCB_COLORS.copperBottom : PCB_COLORS.pad, "fill-opacity": p.layer === "bottom" ? 0.7 : 1,
			}, g)
			if (p.kind === "pth") {
				el("rect", { x: p.x - p.holeW / 2, y: -p.y - p.holeH / 2, width: p.holeW, height: p.holeH, rx: Math.min(p.holeW, p.holeH) / 2, fill: PCB_COLORS.bg }, g)
			}
		}
		const viaLayer = el("g", {}, svg)
		for (const v of ix.vias) {
			const g = el("g", { class: "pcb-via" }, viaLayer)
			el("circle", { cx: v.x, cy: -v.y, r: v.outer / 2, fill: PCB_COLORS.copperTop }, g)
			el("circle", { cx: v.x, cy: -v.y, r: v.hole / 2, fill: PCB_COLORS.bg }, g)
		}

		const partLayer = el("g", {}, svg)
		for (const c of ix.components) {
			const w = c.x1 - c.x0, h = c.y1 - c.y0
			const g = el("g", { class: `pcb-part pcb-layer-${c.layer}`, "data-ref": c.ref }, partLayer)
			const outline = el("rect", { class: "pcb-outline", x: c.x0, y: -c.y1, width: w, height: h, rx: Math.min(0.6, Math.min(w, h) * 0.15), "stroke-width": 0.14 }, g)
			const size = Math.max(0.7, Math.min(2.2, Math.min(w, h) * 0.32))
			// Small parts get their ref just above the outline; big ones in the middle.
			const inside = Math.min(w, h) > 4
			// Inline style, not the font-size attribute: a page's own CSS would override an attribute.
			const label = el("text", { class: "pcb-ref", x: c.cx, y: inside ? -c.cy : -c.y1 - size * 0.75, style: `font-size:${size}px` }, g)
			label.textContent = c.ref
			byRef.set(c.ref, { group: g, outline })
			g.addEventListener("pointerenter", (e) => showTip(c, e))
			g.addEventListener("pointermove", (e) => moveTip(e))
			g.addEventListener("pointerleave", () => hideTip())
		}

		legend.innerHTML = ix.nets
			.map((n) => `<span><i style="background:${colors[n] ?? colorOf(n)}"></i>${html(n)}</span>`)
			.join("")
		if (focused) applyHighlight(focused)
		applyLit()
	}

	// The lit part's outline filled and glowing in the light's colour, and its pads tinted; dark when lit is null.
	function applyLit() {
		for (const e of svg.querySelectorAll(".pcb-lit")) e.remove()
		const hit = lit && byRef.get(lit.ref)
		if (!hit) return
		const o = hit.outline
		el("rect", {
			class: "pcb-lit", x: o.getAttribute("x"), y: o.getAttribute("y"), width: o.getAttribute("width"), height: o.getAttribute("height"),
			rx: o.getAttribute("rx"), fill: lit.color, "fill-opacity": 0.75, stroke: lit.color, "stroke-width": 0.3, filter: "url(#pcb-glow)", "pointer-events": "none",
		}, hit.group)
		for (const p of svg.querySelectorAll(`.pcb-pad[data-ref="${CSS.escape(lit.ref)}"] rect:first-child`)) {
			el("rect", { class: "pcb-lit", x: p.getAttribute("x"), y: p.getAttribute("y"), width: p.getAttribute("width"), height: p.getAttribute("height"), rx: p.getAttribute("rx"), fill: lit.color, "fill-opacity": 0.6, filter: "url(#pcb-glow)", "pointer-events": "none" }, p.parentNode)
		}
	}

	function showTip(c, e) {
		const p = parts.get(c.ref)
		const nets = [...new Set(ix.pads.filter((x) => x.ref === c.ref && x.net).map((x) => x.net))]
		tip.innerHTML = `<b>${html(c.ref)}</b>${p?.mpn ? ` · <span class="pcb-mpn">${html(p.mpn)}</span>` : ""}${p?.role ? `<span class="pcb-role">${html(p.role)}</span>` : ""}` +
			(nets.length ? `<div class="pcb-nets">${nets.map(html).join(" · ")}</div>` : "")
		tip.classList.add("pcb-on")
		moveTip(e)
		opts.onHover?.(c.ref)
	}
	function moveTip(e) {
		const r = root.getBoundingClientRect()
		const x = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8)
		const y = Math.max(8, e.clientY - r.top - tip.offsetHeight - 14)
		tip.style.left = `${x}px`
		tip.style.top = `${y}px`
	}
	function hideTip() {
		tip.classList.remove("pcb-on")
		opts.onHover?.(null)
	}

	function applyHighlight(ref) {
		const on = ref !== null && byRef.has(ref)
		for (const [r, { group }] of byRef) {
			group.classList.toggle("pcb-dim", on && r !== ref)
			group.classList.toggle("pcb-focus", on && r === ref)
		}
		for (const t of svg.querySelectorAll(".pcb-trace")) t.classList.toggle("pcb-dim", on && !t.getAttribute("data-refs").split(" ").includes(ref))
		for (const p of svg.querySelectorAll(".pcb-pad")) p.classList.toggle("pcb-dim", on && p.getAttribute("data-ref") !== ref)
		for (const v of svg.querySelectorAll(".pcb-via")) v.classList.toggle("pcb-dim", on)
	}

	let marks = { added: [], changed: [] }
	function applyMarks() {
		for (const m of svg.querySelectorAll(".pcb-mark, .pcb-mark-tag")) m.remove()
		// A tag that would sit on one already placed is left out: the glow still says it.
		const placed = []
		const free = (x0, x1, y) => !placed.some((p) => x0 < p.x1 && x1 > p.x0 && Math.abs(y - p.y) < 1.4)
		const area = (ref) => { const o = byRef.get(ref)?.outline; return o ? Number(o.getAttribute("width")) * Number(o.getAttribute("height")) : 0 }
		for (const [refs, kind, label] of [[marks.added, "new", "NEW"], [marks.changed, "changed", "CHANGED"]]) {
			// One tag per kind, on the biggest part (the sensor, not its pull-ups); the rest glow without one.
			const tagged = [...refs].sort((a, b) => area(b) - area(a))[0]
			for (const ref of refs) {
				const hit = byRef.get(ref)
				if (!hit) continue
				const o = hit.outline
				const x = Number(o.getAttribute("x")), y = Number(o.getAttribute("y")), w = Number(o.getAttribute("width"))
				el("rect", { class: `pcb-mark pcb-mark-${kind}`, x: x - 0.5, y: y - 0.5, width: w + 1, height: Number(o.getAttribute("height")) + 1, rx: 0.6, filter: "url(#pcb-glow)" }, hit.group)
				const half = label.length * 0.42, tx = x + w / 2, ty = y - 0.9
				if (ref !== tagged || !free(tx - half, tx + half, ty)) continue
				placed.push({ x0: tx - half, x1: tx + half, y: ty })
				const tag = el("text", { class: `pcb-mark-tag pcb-mark-${kind}`, x: tx, y: ty, "font-size": 1.15 }, hit.group)
				tag.textContent = label
			}
		}
	}

	function pulse(refs) {
		for (const ref of refs) {
			const hit = byRef.get(ref)
			if (!hit) continue
			const o = hit.outline
			const ring = el("rect", {
				class: "pcb-pulse", x: o.getAttribute("x"), y: o.getAttribute("y"), width: o.getAttribute("width"), height: o.getAttribute("height"),
				rx: o.getAttribute("rx"), "stroke-width": 0.35, filter: "url(#pcb-glow)",
			}, hit.group)
			setTimeout(() => ring.remove(), GLOW_MS + 100)
			for (const t of svg.querySelectorAll(".pcb-trace")) {
				if (!t.getAttribute("data-refs").split(" ").includes(ref)) continue
				const copy = t.cloneNode()
				copy.setAttribute("class", "pcb-pulse")
				copy.setAttribute("stroke", PCB_COLORS.accent)
				copy.setAttribute("filter", "url(#pcb-glow)")
				t.parentNode.appendChild(copy)
				setTimeout(() => copy.remove(), GLOW_MS + 100)
			}
		}
	}

	// Wheel zooms about the pointer; drag pans; double-click refits.
	svg.addEventListener("wheel", (e) => {
		if (!view) return
		e.preventDefault()
		const r = svg.getBoundingClientRect()
		const k = Math.exp(e.deltaY * 0.0015)
		const nw = Math.min(base[2] * 4, Math.max(base[2] / 12, view[2] * k))
		const f = nw / view[2]
		const px = view[0] + ((e.clientX - r.left) / r.width) * view[2]
		const py = view[1] + ((e.clientY - r.top) / r.height) * view[3]
		view = [px - (px - view[0]) * f, py - (py - view[1]) * f, view[2] * f, view[3] * f]
		userMoved = true
		setViewBox()
	}, { passive: false })
	let drag = null
	svg.addEventListener("pointerdown", (e) => {
		if (!view || e.button !== 0) return
		drag = { x: e.clientX, y: e.clientY, view: [...view] }
		svg.classList.add("pcb-panning")
		svg.setPointerCapture?.(e.pointerId)
	})
	svg.addEventListener("pointermove", (e) => {
		if (!drag) return
		const r = svg.getBoundingClientRect()
		const k = drag.view[2] / r.width
		view = [drag.view[0] - (e.clientX - drag.x) * k, drag.view[1] - (e.clientY - drag.y) * k, drag.view[2], drag.view[3]]
		if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2) userMoved = true
		setViewBox()
	})
	const endDrag = () => {
		drag = null
		svg.classList.remove("pcb-panning")
	}
	svg.addEventListener("pointerup", endDrag)
	svg.addEventListener("pointercancel", endDrag)
	svg.addEventListener("dblclick", () => fit())
	new ResizeObserver(() => {
		if (!userMoved) fit()
	}).observe(host)

	return {
		update(next, changedRefs) {
			const key = JSON.stringify(next ?? [])
			const changed = changedRefs ?? (circuit ? diffRefs(circuit, next) : [])
			if (key !== lastKey) {
				const before = ix && indexBounds(ix)
				circuit = next
				lastKey = key
				ix = circuitIndex(next)
				render()
				applyMarks()
				const after = indexBounds(ix)
				if (!before || before.maxX - before.minX !== after.maxX - after.minX || before.maxY - before.minY !== after.maxY - after.minY) fit()
				else setViewBox()
			}
			if (changed.length > 0) pulse(changed)
		},
		highlight(ref) {
			focused = ref
			applyHighlight(ref)
		},
		// Extension: the parts the change on screen added ({added}) or changed ({changed}), kept until replaced.
		setMarks(next) {
			const m = { added: next?.added ?? [], changed: next?.changed ?? [] }
			if (JSON.stringify(m) === JSON.stringify(marks)) return
			marks = m
			applyMarks()
		},
		setView(v) {
			root.classList.remove("pcb-view-top", "pcb-view-bottom", "pcb-view-both")
			root.classList.add(`pcb-view-${v === "top" || v === "bottom" ? v : "both"}`)
		},
		// Extension: light a part as if it were emitting (ref, CSS colour), e.g. the bench LED mirrored on D1; null = dark.
		setLit(ref, color) {
			lit = ref && color ? { ref, color } : null
			applyLit()
		},
		// Extension: refit the board to the view (as a double-click does).
		fit() {
			fit()
		},
		// Extension: a part's footprint extent in board mm ({x0, y0, x1, y1}), or null.
		extentOf(ref) {
			const c = ix?.components.find((x) => x.ref === ref)
			return c ? { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 } : null
		},
		// Extension: parts from contract.json or bom.json ({ref, mpn, role}) for the tooltip.
		setParts(list) {
			parts = new Map((list ?? []).map((p) => [p.ref, p]))
		},
	}
}
