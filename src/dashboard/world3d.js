// One 3D scene for the start screen, the system page and the zoom into a board (spec §4): every board of a system,
// cut open (case without its lid, translucent), the cables between them, one camera that flies between the whole
// system and one board. Plain WebGL2, no library: a system is a few thousand triangles per board (a case STL is ~3k,
// a board's parts ~0.5k), far under what any renderer needs help with; three.js would add ~600 kB for nothing we use.
// Ruling (ledger, Task 8): own renderer chosen by triangle count; `npm run perf` is the measurement that holds it.
//
// It draws only when something changed or moves (camera fly, drag, turntable, pulse), never while the tab is hidden
// or the canvas is off screen, and the turntable runs at 30 fps. Served at /world3d.js; the pure helpers at the top are
// tested in Node (test/world3d.test.ts).

import { boardMesh, boxTris, enclosureFrame, placeBoardInCase } from "./scene3d.js"
import { parseStl } from "./stl.js"

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

// Board centres (mm) in the xy plane: boards in link order (breadth first from the first board), so linked boards sit
// next to each other; one row up to 4 boards, else a grid of ceil(√n) columns; `gap` mm between neighbours; centred.
export function autoLayout(boards, links, gap = 20) {
	const names = boards.map((b) => b.name)
	const next = new Map(names.map((n) => [n, []]))
	for (const l of links ?? []) {
		next.get(l.a.board)?.push(l.b.board)
		next.get(l.b.board)?.push(l.a.board)
	}
	const order = []
	for (const start of names) {
		if (order.includes(start)) continue
		const queue = [start]
		while (queue.length) {
			const n = queue.shift()
			if (order.includes(n)) continue
			order.push(n)
			for (const m of next.get(n) ?? []) if (!order.includes(m)) queue.push(m)
		}
	}
	const byName = new Map(boards.map((b) => [b.name, b]))
	const cols = order.length <= 4 ? Math.max(1, order.length) : Math.ceil(Math.sqrt(order.length))
	const rows = Math.ceil(order.length / cols)
	const colW = Array(cols).fill(0), rowH = Array(rows).fill(0)
	order.forEach((n, i) => {
		const o = byName.get(n).outline ?? { widthMm: 30, heightMm: 30 }
		colW[i % cols] = Math.max(colW[i % cols], o.widthMm)
		rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)], o.heightMm)
	})
	const totalW = colW.reduce((a, b) => a + b, 0) + gap * (cols - 1)
	const totalH = rowH.reduce((a, b) => a + b, 0) + gap * (rows - 1)
	const out = {}
	order.forEach((n, i) => {
		const c = i % cols, r = Math.floor(i / cols)
		const x = colW.slice(0, c).reduce((a, b) => a + b, 0) + gap * c + colW[c] / 2 - totalW / 2
		const y = -(rowH.slice(0, r).reduce((a, b) => a + b, 0) + gap * r + rowH[r] / 2 - totalH / 2)
		out[n] = { x, y }
	})
	return out
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))

// The camera between two views {yaw, pitch, distance, target}: cubic ease in-out, the yaw the short way round.
export function flyCamera(from, to, t) {
	if (t <= 0) return from
	if (t >= 1) return to
	const e = ease(t)
	const lerp = (a, b) => a + (b - a) * e
	return {
		yaw: from.yaw + wrapAngle(to.yaw - from.yaw) * e,
		pitch: lerp(from.pitch, to.pitch),
		distance: lerp(from.distance, to.distance),
		target: from.target.map((v, i) => lerp(v, to.target[i])),
	}
}

// Up to 4 boards every board is drawn in full (a few thousand triangles each); beyond that only the focused one, the
// others as one box each.
export function detailFor(name, focused, count) {
	return count <= 4 || name === focused ? "full" : "box"
}

// The nearest box {name, min, max} a ray hits (slab test), or null.
export function pickBoard(origin, dir, boxes) {
	let best = null, bestT = Infinity
	for (const b of boxes) {
		let t0 = -Infinity, t1 = Infinity
		for (let k = 0; k < 3; k++) {
			if (Math.abs(dir[k]) < 1e-12) {
				if (origin[k] < b.min[k] || origin[k] > b.max[k]) { t0 = Infinity; break }
				continue
			}
			const ta = (b.min[k] - origin[k]) / dir[k], tb = (b.max[k] - origin[k]) / dir[k]
			t0 = Math.max(t0, Math.min(ta, tb))
			t1 = Math.min(t1, Math.max(ta, tb))
		}
		if (t0 <= t1 && t1 >= 0 && t0 < bestT) { bestT = t0; best = b.name }
	}
	return best
}

// ── Geometry ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ORANGE = [255, 74, 23] // the dashboard's --signal
const PART = [40, 40, 44]
const PAD = [214, 214, 214]
const CASE = [200, 200, 206]
const CABLE = [17, 17, 17]

// Triangles (9 floats each) with one RGB per triangle → interleaved position, normal, colour per vertex.
function interleave(tris, colorOf) {
	const n = tris.length / 9
	const out = new Float32Array(n * 3 * 9)
	for (let i = 0; i < n; i++) {
		const p = i * 9
		const ax = tris[p + 3] - tris[p], ay = tris[p + 4] - tris[p + 1], az = tris[p + 5] - tris[p + 2]
		const bx = tris[p + 6] - tris[p], by = tris[p + 7] - tris[p + 1], bz = tris[p + 8] - tris[p + 2]
		let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
		const len = Math.hypot(nx, ny, nz) || 1
		nx /= len; ny /= len; nz /= len
		const c = colorOf(i)
		for (let v = 0; v < 3; v++) {
			const o = (i * 3 + v) * 9
			out.set([tris[p + v * 3], tris[p + v * 3 + 1], tris[p + v * 3 + 2], nx, ny, nz, c[0] / 255, c[1] / 255, c[2] / 255], o)
		}
	}
	return out
}

function shift(tris, [dx, dy, dz]) {
	const out = new Float32Array(tris.length)
	for (let i = 0; i < tris.length; i += 3) { out[i] = tris[i] + dx; out[i + 1] = tris[i + 1] + dy; out[i + 2] = tris[i + 2] + dz }
	return out
}

function bounds(tris) {
	const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
	for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], tris[i + k]); max[k] = Math.max(max[k], tris[i + k]) }
	return { min, max }
}

// One board's meshes centred on its own origin (xy centre 0, bottom at z 0): the solid board with its parts, the
// translucent case (no lid: cut open), and the one-box stand-in.
export function boardGeometry(b) {
	const o = b.outline ?? { widthMm: 30, heightMm: 30 }
	const box = boxTris([-o.widthMm / 2, -o.heightMm / 2, 0], [o.widthMm / 2, o.heightMm / 2, 1.6])
	let solid = null, shell = null
	let extent = { min: [-o.widthMm / 2, -o.heightMm / 2, 0], max: [o.widthMm / 2, o.heightMm / 2, 1.6] }
	if (b.circuit) {
		const m = boardMesh(b.circuit, b.parts ?? [])
		let boardTris = m.positions
		let caseTris = b.caseStl ? parseStl(b.caseStl) : null
		const bb = m.bounds
		let off = [-(bb.min[0] + bb.max[0]) / 2, -(bb.min[1] + bb.max[1]) / 2, -bb.min[2]]
		if (caseTris && caseTris.length) {
			const frame = enclosureFrame(b.caseSpec)
			off = placeBoardInCase(caseTris, bb, frame?.boardZ)
			const cb = bounds(caseTris)
			const centre = [-(cb.min[0] + cb.max[0]) / 2, -(cb.min[1] + cb.max[1]) / 2, -cb.min[2]]
			caseTris = shift(caseTris, centre)
			off = [off[0] + centre[0], off[1] + centre[1], off[2] + centre[2]]
			shell = interleave(caseTris, () => CASE)
			extent = bounds(caseTris)
		}
		boardTris = shift(boardTris, off)
		solid = interleave(boardTris, (i) => (m.kinds[i] === "slab" ? ORANGE : m.kinds[i] === "pad" ? PAD : PART))
		if (!shell) extent = bounds(boardTris)
	}
	return { solid, shell, box: interleave(box, () => ORANGE), extent }
}

// A cable as a flat ribbon on an arch between two points (mm), 1.2 mm wide.
export function cableRibbon(a, b, lift = 12, segments = 24, width = 1.2) {
	const pts = []
	for (let i = 0; i <= segments; i++) {
		const t = i / segments
		pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t + Math.sin(Math.PI * t) * lift])
	}
	const dx = b[0] - a[0], dy = b[1] - a[1]
	const len = Math.hypot(dx, dy) || 1
	const side = [(-dy / len) * width / 2, (dx / len) * width / 2, 0]
	const tris = []
	for (let i = 0; i < segments; i++) {
		const p = pts[i], q = pts[i + 1]
		const p0 = [p[0] - side[0], p[1] - side[1], p[2]], p1 = [p[0] + side[0], p[1] + side[1], p[2]]
		const q0 = [q[0] - side[0], q[1] - side[1], q[2]], q1 = [q[0] + side[0], q[1] + side[1], q[2]]
		tris.push(...p0, ...q0, ...q1, ...p0, ...q1, ...p1)
	}
	return { mesh: interleave(new Float32Array(tris), () => CABLE), mid: pts[segments >> 1] }
}

// ── Matrices ─────────────────────────────────────────────────────────────────────────────────────────────────────

function perspective(fovy, aspect, near, far) {
	const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far)
	return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0])
}
function lookAt(eye, target, up) {
	const z = norm3([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]])
	const x = norm3(cross3(up, z)), y = cross3(z, x)
	return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1])
}
function mul4(a, b) {
	const o = new Float32Array(16)
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s }
	return o
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const eyeOf = (c) => [c.target[0] + c.distance * Math.cos(c.pitch) * Math.sin(c.yaw), c.target[1] - c.distance * Math.cos(c.pitch) * Math.cos(c.yaw), c.target[2] + c.distance * Math.sin(c.pitch)]

// ── Renderer ─────────────────────────────────────────────────────────────────────────────────────────────────────

const VS = `#version 300 es
in vec3 aPos; in vec3 aNor; in vec3 aCol;
uniform mat4 uVP; uniform vec3 uOff;
out vec3 vNor; out vec3 vCol;
void main() { vNor = aNor; vCol = aCol; gl_Position = uVP * vec4(aPos + uOff, 1.0); }`
const FS = `#version 300 es
precision mediump float;
in vec3 vNor; in vec3 vCol;
uniform float uAlpha; uniform float uGlow; uniform vec3 uLight;
out vec4 o;
void main() {
	float d = abs(dot(normalize(vNor), uLight));
	vec3 c = vCol * (0.62 + 0.38 * d);
	o = vec4(mix(c, vec3(1.0, 0.55, 0.2), uGlow), uAlpha);
}`

export function mountWorld(host, opts = {}) {
	host.style.position ||= "relative"
	const canvas = document.createElement("canvas")
	canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;touch-action:none;opacity:0;transition:opacity .35s"
	const overlay = document.createElement("div")
	overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;font:12px/1.3 system-ui,sans-serif"
	let still = null
	if (opts.still) {
		still = document.createElement("img")
		still.src = opts.still
		still.alt = ""
		still.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transition:opacity .35s"
		host.append(still)
	}
	host.append(canvas, overlay)
	const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, powerPreference: "low-power" })
	if (!gl) throw new Error("WebGL2 is not available")

	const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s }
	const prog = gl.createProgram()
	gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog)
	const loc = { pos: gl.getAttribLocation(prog, "aPos"), nor: gl.getAttribLocation(prog, "aNor"), col: gl.getAttribLocation(prog, "aCol") }
	const u = Object.fromEntries(["uVP", "uOff", "uAlpha", "uGlow", "uLight"].map((n) => [n, gl.getUniformLocation(prog, n)]))
	gl.enable(gl.DEPTH_TEST)
	gl.enable(gl.BLEND)
	gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

	const upload = (data) => {
		if (!data || !data.length) return null
		const vao = gl.createVertexArray(), buf = gl.createBuffer()
		gl.bindVertexArray(vao)
		gl.bindBuffer(gl.ARRAY_BUFFER, buf)
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
		for (const [l, off] of [[loc.pos, 0], [loc.nor, 12], [loc.col, 24]]) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 3, gl.FLOAT, false, 36, off) }
		gl.bindVertexArray(null)
		return { vao, buf, count: data.length / 9 }
	}
	const free = (m) => { if (m) { gl.deleteBuffer(m.buf); gl.deleteVertexArray(m.vao) } }

	const S = {
		boards: new Map(), // name → { key, geo meshes, at, extent, alpha, alphaTo, glowUntil }
		cables: [], // { mesh, mid, label, el }
		focused: null,
		cam: { yaw: -0.5, pitch: 0.55, distance: 200, target: [0, 0, 0] },
		fly: null, // { from, to, start, ms, resolve }
		turntable: false,
		dragging: null,
		dirty: true,
		raf: 0,
		lastTurn: 0,
		visible: true,
		firstFrame: null,
	}
	let readyResolve
	const ready = new Promise((r) => (readyResolve = r))

	const fitView = (names) => {
		const ext = names.map((n) => S.boards.get(n)).filter(Boolean).map((b) => ({ min: b.extent.min.map((v, k) => v + (k < 2 ? b.at[k] : 0)), max: b.extent.max.map((v, k) => v + (k < 2 ? b.at[k] : 0)) }))
		if (!ext.length) return { ...S.cam }
		const min = [0, 1, 2].map((k) => Math.min(...ext.map((e) => e.min[k]))), max = [0, 1, 2].map((k) => Math.max(...ext.map((e) => e.max[k])))
		const size = Math.max(max[0] - min[0], max[1] - min[1], 20)
		return { yaw: S.cam.yaw, pitch: names.length === 1 ? 0.75 : 0.55, distance: size * (names.length === 1 ? 2.1 : 1.25), target: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] }
	}

	const request = () => {
		S.dirty = true
		if (!S.raf && S.visible) S.raf = requestAnimationFrame(frame)
	}

	function frame(now) {
		S.raf = 0
		let moving = false
		if (S.fly) {
			const t = Math.min(1, (now - S.fly.start) / S.fly.ms)
			S.cam = flyCamera(S.fly.from, S.fly.to, Math.max(0, t))
			S.dirty = true
			if (t >= 1) { const r = S.fly.resolve; S.fly = null; r() } else moving = true
		}
		for (const b of S.boards.values()) {
			if (Math.abs(b.alpha - b.alphaTo) > 0.01) { b.alpha += (b.alphaTo - b.alpha) * 0.18; moving = S.dirty = true } else if (b.alpha !== b.alphaTo) { b.alpha = b.alphaTo; S.dirty = true }
			if (b.glowUntil > now - 50) moving = S.dirty = true
		}
		if (S.turntable && !S.dragging && !S.fly && !S.focused) {
			// 30 fps is plenty for a slow turn and halves the work.
			if (now - S.lastTurn >= 33) { S.cam = { ...S.cam, yaw: S.cam.yaw + 0.004 * Math.min(4, (now - S.lastTurn) / 16.7) }; S.lastTurn = now; S.dirty = true }
			moving = true
		}
		if (S.dirty) draw(now)
		if (moving && S.visible) S.raf = requestAnimationFrame(frame)
	}

	function viewProj() {
		const w = canvas.clientWidth, h = canvas.clientHeight
		const dpr = Math.min(window.devicePixelRatio || 1, 2)
		if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr) }
		const eye = eyeOf(S.cam)
		return { vp: mul4(perspective(0.6, w / Math.max(1, h), Math.max(1, S.cam.distance / 50), S.cam.distance * 20), lookAt(eye, S.cam.target, [0, 0, 1])), eye, w, h }
	}

	function draw(now) {
		S.dirty = false
		const { vp, eye, w, h } = viewProj()
		gl.viewport(0, 0, canvas.width, canvas.height)
		gl.clearColor(1, 1, 1, 1)
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
		gl.useProgram(prog)
		gl.uniformMatrix4fv(u.uVP, false, vp)
		gl.uniform3fv(u.uLight, norm3([0.3, -0.5, 0.8]))
		const draws = []
		const count = S.boards.size
		for (const [name, b] of S.boards) {
			const full = detailFor(name, S.focused, count) === "full" && b.solid
			const glow = b.glowUntil > now ? 0.45 * (0.5 + 0.5 * Math.sin((b.glowUntil - now) / 90)) : 0
			draws.push({ mesh: full ? b.solid : b.boxMesh, off: [b.at[0], b.at[1], 0], alpha: b.alpha, glow, opaque: b.alpha > 0.99 })
			if (full && b.shell) draws.push({ mesh: b.shell, off: [b.at[0], b.at[1], 0], alpha: 0.22 * b.alpha, glow: 0, opaque: false, shell: true })
		}
		const cableAlpha = S.focused ? 0.15 : 1
		for (const c of S.cables) draws.push({ mesh: c.mesh, off: [0, 0, 0], alpha: cableAlpha, glow: 0, opaque: cableAlpha > 0.99, cable: true })
		const dist = (d) => Math.hypot(d.off[0] - eye[0], d.off[1] - eye[1], d.off[2] - eye[2])
		const run = (d) => {
			if (!d.mesh) return
			gl.uniform3fv(u.uOff, d.off); gl.uniform1f(u.uAlpha, d.alpha); gl.uniform1f(u.uGlow, d.glow)
			gl.bindVertexArray(d.mesh.vao); gl.drawArrays(gl.TRIANGLES, 0, d.mesh.count)
		}
		gl.depthMask(true)
		for (const d of draws) if (d.opaque) run(d)
		gl.depthMask(false)
		for (const d of draws.filter((x) => !x.opaque).sort((a, b) => dist(b) - dist(a))) run(d)
		gl.depthMask(true)
		gl.bindVertexArray(null)
		// Labels: cable labels at their arch tops, captions over pulsing boards.
		for (const c of S.cables) place(c.el, c.mid, vp, w, h, S.focused ? 0 : 1)
		for (const b of S.boards.values()) if (b.caption) place(b.caption, [b.at[0], b.at[1], b.extent.max[2] + 4], vp, w, h, b.glowUntil > now ? 1 : 0)
		if (!S.firstFrame) {
			S.firstFrame = now
			canvas.style.opacity = "1"
			if (still) still.style.opacity = "0"
			readyResolve()
		}
	}

	function place(el, p, vp, w, h, alpha) {
		const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]
		const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]
		const ww = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]
		if (ww <= 0) { el.style.opacity = "0"; return }
		el.style.transform = `translate(${((x / ww) * 0.5 + 0.5) * w}px, ${((-y / ww) * 0.5 + 0.5) * h}px) translate(-50%, -100%)`
		el.style.opacity = String(alpha)
	}

	function setWorld({ boards, cables = [] }) {
		const pos = autoLayout(boards, cables)
		const keep = new Set()
		for (const wb of boards) {
			keep.add(wb.name)
			const key = wb.key ?? wb.name
			let b = S.boards.get(wb.name)
			if (!b || b.key !== key) {
				if (b) { free(b.solid); free(b.shell); free(b.boxMesh) }
				const g = boardGeometry(wb)
				b = { key, solid: upload(g.solid), shell: upload(g.shell), boxMesh: upload(g.box), extent: g.extent, alpha: b?.alpha ?? 1, alphaTo: b?.alphaTo ?? 1, glowUntil: 0, caption: b?.caption ?? null }
				S.boards.set(wb.name, b)
			}
			b.at = wb.at ? [wb.at.x, wb.at.y] : [pos[wb.name].x, pos[wb.name].y]
		}
		for (const [name, b] of S.boards) if (!keep.has(name)) { free(b.solid); free(b.shell); free(b.boxMesh); b.caption?.remove(); S.boards.delete(name) }
		for (const c of S.cables) { free(c.mesh); c.el.remove() }
		S.cables = cables.filter((c) => S.boards.has(c.a.board) && S.boards.has(c.b.board)).map((c) => {
			const A = S.boards.get(c.a.board), B = S.boards.get(c.b.board)
			const r = cableRibbon([A.at[0] + (c.a.xMm ?? 0), A.at[1] + (c.a.yMm ?? 0), A.extent.max[2] * 0.4], [B.at[0] + (c.b.xMm ?? 0), B.at[1] + (c.b.yMm ?? 0), B.extent.max[2] * 0.4], Math.max(8, Math.hypot(A.at[0] - B.at[0], A.at[1] - B.at[1]) * 0.25))
			const el = document.createElement("span")
			el.textContent = c.label ?? c.id
			el.style.cssText = "position:absolute;left:0;top:0;background:#fff;border:1px solid #111;border-radius:4px;padding:1px 6px;white-space:nowrap;transition:opacity .3s"
			overlay.append(el)
			return { mesh: upload(r.mesh), mid: r.mid, el }
		})
		// Keep fitting as boards grow, until the user turns or zooms; then only when boards come or go.
		const names = [...S.boards.keys()].sort().join(",")
		if ((names !== S.fitted || !S.userMoved) && !S.fly && !S.focused) { S.cam = fitView([...S.boards.keys()]); S.fitted = names }
		request()
	}

	function focus(name, { ms = 500 } = {}) {
		S.focused = name && S.boards.has(name) ? name : null
		for (const [n, b] of S.boards) b.alphaTo = S.focused && n !== S.focused ? 0.15 : 1
		const to = fitView(S.focused ? [S.focused] : [...S.boards.keys()])
		if (S.fly) S.fly.resolve()
		return new Promise((resolve) => {
			S.fly = { from: S.cam, to, start: performance.now(), ms: Math.max(1, ms), resolve }
			request()
		})
	}

	function pulse(target, caption) {
		const b = target.board ? S.boards.get(target.board) : null
		if (!b) return
		b.glowUntil = performance.now() + 1800
		if (caption) {
			if (!b.caption) {
				b.caption = document.createElement("span")
				b.caption.style.cssText = "position:absolute;left:0;top:0;max-width:280px;background:#111;color:#fff;border-radius:6px;padding:4px 8px;transition:opacity .3s"
				overlay.append(b.caption)
			}
			b.caption.textContent = caption
		}
		request()
	}

	// Pointer: drag to orbit, wheel to zoom, a click without a drag picks a board, hover names one.
	const rayAt = (cx, cy) => {
		const r = canvas.getBoundingClientRect()
		const { vp, eye } = viewProj()
		const inv = invert4(vp)
		const nx = ((cx - r.left) / r.width) * 2 - 1, ny = -(((cy - r.top) / r.height) * 2 - 1)
		const far = unproject(inv, nx, ny, 1)
		return { origin: eye, dir: norm3([far[0] - eye[0], far[1] - eye[1], far[2] - eye[2]]) }
	}
	const boxes = () => [...S.boards].map(([name, b]) => ({ name, min: [b.extent.min[0] + b.at[0], b.extent.min[1] + b.at[1], b.extent.min[2]], max: [b.extent.max[0] + b.at[0], b.extent.max[1] + b.at[1], b.extent.max[2]] }))
	let hovered = null
	canvas.addEventListener("pointerdown", (e) => { S.dragging = { x: e.clientX, y: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId) })
	canvas.addEventListener("pointermove", (e) => {
		if (S.dragging) {
			const dx = e.clientX - S.dragging.x, dy = e.clientY - S.dragging.y
			S.dragging.moved += Math.abs(dx) + Math.abs(dy)
			S.dragging.x = e.clientX; S.dragging.y = e.clientY
			S.userMoved = true
			S.cam = { ...S.cam, yaw: S.cam.yaw - dx * 0.008, pitch: Math.min(1.45, Math.max(0.05, S.cam.pitch + dy * 0.006)) }
			request()
			return
		}
		const { origin, dir } = rayAt(e.clientX, e.clientY)
		const name = pickBoard(origin, dir, boxes())
		if (name !== hovered) { hovered = name; canvas.style.cursor = name ? "pointer" : "grab"; opts.onHover?.(name) }
	})
	canvas.addEventListener("pointerup", (e) => {
		const click = S.dragging && S.dragging.moved < 5
		S.dragging = null
		if (!click) return
		const { origin, dir } = rayAt(e.clientX, e.clientY)
		const name = pickBoard(origin, dir, boxes())
		if (name) opts.onPick?.(name)
	})
	canvas.addEventListener("wheel", (e) => { e.preventDefault(); S.userMoved = true; S.cam = { ...S.cam, distance: Math.min(3000, Math.max(15, S.cam.distance * Math.exp(e.deltaY * 0.001))) }; request() }, { passive: false })

	// Nothing drawn while hidden or scrolled away.
	const onVisibility = () => { S.visible = !document.hidden; if (S.visible) request() }
	document.addEventListener("visibilitychange", onVisibility)
	const io = typeof IntersectionObserver === "function" ? new IntersectionObserver(([en]) => { S.visible = en.isIntersecting && !document.hidden; if (S.visible) request() }) : null
	io?.observe(canvas)
	const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => request()) : null
	ro?.observe(host)

	return {
		ready,
		setWorld,
		focus,
		pulse,
		setTurntable(on) { S.turntable = Boolean(on); S.lastTurn = performance.now(); request() },
		get focused() { return S.focused },
		stats() { return { boards: S.boards.size, triangles: [...S.boards.values()].reduce((n, b) => n + (b.solid?.count ?? 0) / 3 + (b.shell?.count ?? 0) / 3, 0) } },
		dispose() {
			cancelAnimationFrame(S.raf)
			document.removeEventListener("visibilitychange", onVisibility)
			io?.disconnect(); ro?.disconnect()
			for (const b of S.boards.values()) { free(b.solid); free(b.shell); free(b.boxMesh) }
			for (const c of S.cables) free(c.mesh)
			canvas.remove(); overlay.remove(); still?.remove()
		},
	}
}

function unproject(inv, x, y, z) {
	const v = [x, y, z, 1], o = [0, 0, 0, 0]
	for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[r] += inv[k * 4 + r] * v[k]
	return [o[0] / o[3], o[1] / o[3], o[2] / o[3]]
}

function invert4(m) {
	const inv = new Float32Array(16)
	const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m
	const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11
	const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30
	const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
	const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06)
	inv.set([
		(a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det, (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
		(a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det, (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
		(a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det, (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
		(a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det, (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
	])
	return inv
}
