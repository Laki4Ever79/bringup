// The dashboard's 3D view, on a plain 2D canvas with no libraries: the printed case from case.stl (flat-shaded,
// translucent, with its feature edges) around the board as a slab with one box per part. Painter's algorithm with
// back-face culling; drag to orbit, slow idle spin, setExplode(t) lifts the case off. Served at /scene3d.js; the
// pure helpers at the top are tested in Node.

import { circuitIndex, PCB_COLORS } from "./pcb-view.js"
import { featureEdges, parseStl } from "./stl.js"

// Part heights in mm by role; without a role, by reference prefix.
const HEIGHTS = { mcu: 2.4, sensor: 0.8, ldo: 1.1, "usb-c": 3.2, connector: 3.2, button: 1.5, led: 0.5, resistor: 0.5, capacitor: 0.5 }
const PREFIX = { J: 3.2, SW: 1.5, R: 0.5, C: 0.5, D: 0.5, L: 0.5, U: 1.1 }

export function heightFor(ref, role) {
	if (role && HEIGHTS[role] !== undefined) return HEIGHTS[role]
	const prefix = /^[A-Z]+/.exec(ref ?? "")?.[0] ?? ""
	return PREFIX[prefix] ?? 1
}

// Fills by role, in sRGB: the module's metal can, dark plastic, the USB-C shell, ceramic tan, LED red.
const BODY = { mcu: [178, 182, 191], sensor: [46, 46, 54], ldo: [36, 36, 42], "usb-c": [205, 209, 216], connector: [205, 209, 216], button: [70, 70, 80], led: [248, 113, 113], resistor: [32, 32, 38], capacitor: [176, 138, 90] }
const BOARD_RGB = [22, 74, 50]
const PAD_RGB = [232, 194, 122]
const CASE_RGB = [212, 212, 222]

// Axis-aligned box as 12 triangles, counter-clockwise seen from outside.
export function boxTris(min, max) {
	const [x0, y0, z0] = min, [x1, y1, z1] = max
	const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
	const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
	const out = []
	for (const [a, b, c, d] of quads) out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d])
	return out
}

// Board slab, top pads and one box per part, in the circuit frame (board centred on the origin, bottom at z 0).
export function boardMesh(circuit, parts = []) {
	const ix = circuitIndex(circuit)
	const roleOf = new Map(parts.map((p) => [p.ref, p.role]))
	const positions = [], colors = [], refs = [], kinds = []
	const add = (tris, color, ref, kind) => {
		for (let i = 0; i < tris.length; i += 9) {
			positions.push(...tris.slice(i, i + 9))
			colors.push(color)
			refs.push(ref)
			kinds.push(kind)
		}
	}
	const b = ix.board ?? { cx: 0, cy: 0, w: 20, h: 20, thickness: 1.6 }
	const t = b.thickness
	const min = [b.cx - b.w / 2, b.cy - b.h / 2, 0], max = [b.cx + b.w / 2, b.cy + b.h / 2, t]
	add(boxTris(min, max), BOARD_RGB, null, "slab")
	for (const p of ix.pads) {
		if (p.layer === "bottom") continue
		const z = t + 0.02
		const xa = p.x - p.w / 2, xb = p.x + p.w / 2, ya = p.y - p.h / 2, yb = p.y + p.h / 2
		add([xa, ya, z, xb, ya, z, xb, yb, z, xa, ya, z, xb, yb, z, xa, yb, z], PAD_RGB, null, "pad")
	}
	let top = t
	for (const c of ix.components) {
		const role = roleOf.get(c.ref)
		const h = heightFor(c.ref, role)
		top = Math.max(top, t + h)
		add(boxTris([c.x0 + 0.3, c.y0 + 0.3, t], [c.x1 - 0.3, c.y1 - 0.3, t + h]), BODY[role] ?? [60, 60, 70], c.ref, "part")
	}
	return { positions: new Float32Array(positions), colors, refs, kinds, bounds: { min, max: [max[0], max[1], top] } }
}

const WALL_MM = 2

// Where to move the board so it sits centred in the case, resting on its floor (the enclosure spec's 2 mm wall).
export function placeBoardInCase(caseTris, board) {
	let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity
	for (let i = 0; i < caseTris.length; i += 3) {
		minX = Math.min(minX, caseTris[i]); maxX = Math.max(maxX, caseTris[i])
		minY = Math.min(minY, caseTris[i + 1]); maxY = Math.max(maxY, caseTris[i + 1])
		minZ = Math.min(minZ, caseTris[i + 2])
	}
	const bx = (board.min[0] + board.max[0]) / 2, by = (board.min[1] + board.max[1]) / 2
	return [(minX + maxX) / 2 - bx, (minY + maxY) / 2 - by, minZ + WALL_MM - board.min[2]]
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => {
	const l = Math.hypot(a[0], a[1], a[2]) || 1
	return [a[0] / l, a[1] / l, a[2] / l]
}

// The board's attitude as a rotation: roll about x, then pitch about y (z up, the board flat in xy).
export function tiltMatrix(pitch, roll) {
	const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll)
	// Ry(pitch) · Rx(roll), row-major.
	return [cp, sp * sr, sp * cr, 0, cr, -sr, -sp, cp * sr, cp * cr]
}

// p rotated by m about centre c.
export function applyTilt(m, p, c) {
	const x = p[0] - c[0], y = p[1] - c[1], z = p[2] - c[2]
	return [c[0] + m[0] * x + m[1] * y + m[2] * z, c[1] + m[3] * x + m[4] * y + m[5] * z, c[2] + m[6] * x + m[7] * y + m[8] * z]
}

// Orbit camera around `target`, z up: yaw about z, pitch above the horizon.
export function orbitCamera({ yaw, pitch, distance, target, fov = 0.62 }) {
	const eye = [
		target[0] + distance * Math.cos(pitch) * Math.cos(yaw),
		target[1] + distance * Math.cos(pitch) * Math.sin(yaw),
		target[2] + distance * Math.sin(pitch),
	]
	const forward = norm(sub(target, eye))
	const right = norm(cross(forward, [0, 0, 1]))
	const up = cross(right, forward)
	return { eye, forward, right, up, fov }
}

// World point → [screen x, screen y, depth along the view]. Larger depth is farther away.
export function project(cam, p, width, height) {
	const d = sub(p, cam.eye)
	const z = dot(d, cam.forward)
	const f = height / 2 / Math.tan(cam.fov / 2)
	const zz = Math.max(z, 1e-3)
	return [width / 2 + (dot(d, cam.right) * f) / zz, height / 2 - (dot(d, cam.up) * f) / zz, z]
}

export function triNormal(t, i) {
	return norm(cross(sub([t[i + 3], t[i + 4], t[i + 5]], [t[i], t[i + 1], t[i + 2]]), sub([t[i + 6], t[i + 7], t[i + 8]], [t[i], t[i + 1], t[i + 2]])))
}

const AMBIENT = 0.35

// Flat shading: ambient plus Lambert from one directional light.
export function shade(rgb, normal, light) {
	const k = AMBIENT + (1 - AMBIENT) * Math.max(0, dot(normal, light))
	return rgb.map((c) => Math.round(c * k))
}

// ---------------------------------------------------------------------------------------------------------------
// DOM view

const LIGHT = norm([-0.45, -0.6, 0.75])
const CASE_ALPHA = 0.34
const IDLE_AFTER_MS = 3000
const IDLE_SPEED = 0.12 // rad/s

export function mountScene(host, opts = {}) {
	if (getComputedStyle(host).position === "static") host.style.position = "relative"
	const canvas = document.createElement("canvas")
	canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:none"
	host.appendChild(canvas)
	const ctx = canvas.getContext("2d")
	const reduced = matchMedia?.("(prefers-reduced-motion: reduce)").matches

	let parts = opts.parts ?? []
	let circuit = null, caseTris = null, caseEdges = []
	let circuitKey = "", caseKey = null
	let board = null // boardMesh() result
	let offset = [0, 0, 0]
	let tris = null // { pos: Float32Array, color[], alpha[], ref[], kind[], normal[] }
	let caseCount = 0
	let caseLift = 0
	let explode = 0, explodeTarget = 0
	let yaw = -2.2, pitch = 0.62, distance = 120, target = [0, 0, 0]
	// The bench board's attitude (setOrientation), eased toward the latest reading; null when no board is tilting it.
	let tilt = null, tiltTarget = null, tiltAt = -Infinity
	let lastInteraction = -Infinity
	let focused = null, hovered = null
	let drawn = [] // visible triangles of the last frame, far to near, for hit testing
	let dirty = true
	let w = 0, h = 0, dpr = 1

	function rebuild() {
		const pos = [], color = [], alpha = [], ref = [], kind = []
		caseCount = 0
		if (caseTris) {
			for (let i = 0; i < caseTris.length; i++) pos.push(caseTris[i])
			caseCount = caseTris.length / 9
			for (let i = 0; i < caseCount; i++) { color.push(CASE_RGB); alpha.push(CASE_ALPHA); ref.push(null); kind.push("case") }
		}
		if (board) {
			offset = caseTris ? placeBoardInCase(caseTris, board.bounds) : [0, 0, 0]
			const p = board.positions
			for (let i = 0; i < p.length; i += 3) pos.push(p[i] + offset[0], p[i + 1] + offset[1], p[i + 2] + offset[2])
			for (let i = 0; i < board.refs.length; i++) { color.push(board.colors[i]); alpha.push(1); ref.push(board.refs[i]); kind.push(board.kinds[i]) }
		}
		const P = new Float32Array(pos)
		const normal = []
		for (let i = 0; i < P.length; i += 9) normal.push(triNormal(P, i))
		tris = { pos: P, color, alpha, ref, kind, normal }

		// Frame the whole scene.
		let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
		for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]) }
		if (P.length === 0) { lo = [-10, -10, 0]; hi = [10, 10, 5] }
		target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
		caseLift = (hi[2] - lo[2]) * 1.5 + 6
		const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2
		distance = (radius / Math.sin(0.62 / 2)) * 0.95
		dirty = true
	}

	function resize() {
		dpr = Math.min(2, window.devicePixelRatio || 1)
		w = host.clientWidth || 400
		h = host.clientHeight || 300
		canvas.width = Math.round(w * dpr)
		canvas.height = Math.round(h * dpr)
		dirty = true
	}

	function frame(now, dt) {
		// While a real board tilts the model, the idle spin stops so the two motions don't mix.
		const tilting = now - tiltAt < IDLE_AFTER_MS
		if (!reduced && !tilting && now - lastInteraction > IDLE_AFTER_MS) { yaw += IDLE_SPEED * dt; dirty = true }
		if (tiltTarget) {
			tilt ??= { pitch: 0, roll: 0 }
			const k = reduced ? 1 : Math.min(1, dt * 10)
			if (Math.abs(tiltTarget.pitch - tilt.pitch) + Math.abs(tiltTarget.roll - tilt.roll) > 1e-4) {
				tilt = { pitch: tilt.pitch + (tiltTarget.pitch - tilt.pitch) * k, roll: tilt.roll + (tiltTarget.roll - tilt.roll) * k }
				dirty = true
			}
		}
		if (Math.abs(explodeTarget - explode) > 1e-3) {
			explode += (explodeTarget - explode) * (reduced ? 1 : Math.min(1, dt * 8))
			dirty = true
		}
		if (!dirty || !tris) return
		dirty = false
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, w, h)
		// Soft floor glow under the model.
		const g = ctx.createRadialGradient(w / 2, h * 0.62, 0, w / 2, h * 0.62, Math.max(w, h) * 0.55)
		g.addColorStop(0, "rgba(30,41,59,0.35)")
		g.addColorStop(1, "rgba(10,10,10,0)")
		ctx.fillStyle = g
		ctx.fillRect(0, 0, w, h)

		const cam = orbitCamera({ yaw, pitch, distance, target })
		const lift = explode * caseLift
		const P = tris.pos
		// Model space → world: the bench tilt, about the scene's centre.
		const m = tilt && (tilt.pitch !== 0 || tilt.roll !== 0) ? tiltMatrix(tilt.pitch, tilt.roll) : null
		const W = m ? (p) => applyTilt(m, p, target) : (p) => p
		const list = []
		for (let t = 0, i = 0; i < P.length; t++, i += 9) {
			const isCase = t < caseCount
			const dz = isCase ? lift : 0
			const n = m ? applyTilt(m, tris.normal[t], [0, 0, 0]) : tris.normal[t]
			const a = W([P[i], P[i + 1], P[i + 2] + dz])
			// Back-face culling in world space.
			if (dot(n, sub(cam.eye, a)) <= 0) continue
			const pa = project(cam, a, w, h)
			const pb = project(cam, W([P[i + 3], P[i + 4], P[i + 5] + dz]), w, h)
			const pc = project(cam, W([P[i + 6], P[i + 7], P[i + 8] + dz]), w, h)
			list.push({ t, pa, pb, pc, depth: (pa[2] + pb[2] + pc[2]) / 3 })
		}
		list.sort((x, y) => y.depth - x.depth)
		for (const d of list) {
			const t = d.t
			const isHot = (focused && tris.ref[t] === focused) || (hovered && tris.ref[t] === hovered)
			const [r, gg, b] = shade(tris.color[t], m ? applyTilt(m, tris.normal[t], [0, 0, 0]) : tris.normal[t], LIGHT)
			ctx.beginPath()
			ctx.moveTo(d.pa[0], d.pa[1])
			ctx.lineTo(d.pb[0], d.pb[1])
			ctx.lineTo(d.pc[0], d.pc[1])
			ctx.closePath()
			ctx.fillStyle = `rgba(${r},${gg},${b},${tris.alpha[t]})`
			ctx.fill()
			// Seal hairline gaps between opaque neighbours.
			if (tris.alpha[t] === 1) {
				ctx.strokeStyle = ctx.fillStyle
				ctx.lineWidth = 0.6
				ctx.stroke()
			}
			if (isHot) {
				ctx.fillStyle = "rgba(245,158,11,0.18)"
				ctx.fill()
			}
		}
		drawn = list

		// The case's folds as fine lines, so its shape reads through the transparency.
		ctx.lineWidth = 1
		ctx.strokeStyle = "rgba(237,237,237,0.32)"
		ctx.beginPath()
		for (const [a, b] of caseEdges) {
			const pa = project(cam, W([a[0], a[1], a[2] + lift]), w, h), pb = project(cam, W([b[0], b[1], b[2] + lift]), w, h)
			ctx.moveTo(pa[0], pa[1])
			ctx.lineTo(pb[0], pb[1])
		}
		ctx.stroke()

		// Outline the highlighted part on top of everything.
		const ref = focused ?? hovered
		if (ref && board) {
			const P2 = tris.pos
			ctx.save()
			ctx.strokeStyle = PCB_COLORS.accent
			ctx.lineWidth = 1.6
			ctx.shadowColor = "rgba(245,158,11,0.8)"
			ctx.shadowBlur = 10
			ctx.beginPath()
			let n = 0
			for (let t = caseCount, i = caseCount * 9; i < P2.length; t++, i += 9) {
				if (tris.ref[t] !== ref) continue
				// Box edges only: each quad is (a,b,c)+(a,c,d), so skip the shared diagonal a–c.
				const first = n++ % 2 === 0
				const pts = [0, 1, 2].map((k) => project(cam, W([P2[i + k * 3], P2[i + k * 3 + 1], P2[i + k * 3 + 2]]), w, h))
				const edges = first ? [[0, 1], [1, 2]] : [[1, 2], [2, 0]]
				for (const [a, b] of edges) { ctx.moveTo(pts[a][0], pts[a][1]); ctx.lineTo(pts[b][0], pts[b][1]) }
			}
			ctx.stroke()
			ctx.restore()
		}
	}

	let last = performance.now()
	const loop = (now) => {
		frame(now, Math.min(0.1, (now - last) / 1000))
		last = now
		requestAnimationFrame(loop)
	}
	requestAnimationFrame(loop)

	// Topmost part triangle under the pointer.
	function pick(x, y) {
		for (let k = drawn.length - 1; k >= 0; k--) {
			const d = drawn[k]
			const ref = tris.ref[d.t]
			if (!ref) continue
			const s = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])
			const s1 = s(d.pa, d.pb), s2 = s(d.pb, d.pc), s3 = s(d.pc, d.pa)
			if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return ref
		}
		return null
	}

	let drag = null
	canvas.addEventListener("pointerdown", (e) => {
		drag = { x: e.clientX, y: e.clientY, yaw, pitch }
		canvas.style.cursor = "grabbing"
		canvas.setPointerCapture?.(e.pointerId)
		lastInteraction = performance.now()
	})
	canvas.addEventListener("pointermove", (e) => {
		if (drag) {
			yaw = drag.yaw - (e.clientX - drag.x) * 0.008
			pitch = Math.max(-0.2, Math.min(1.45, drag.pitch + (e.clientY - drag.y) * 0.006))
			lastInteraction = performance.now()
			dirty = true
			return
		}
		const r = canvas.getBoundingClientRect()
		const ref = pick(e.clientX - r.left, e.clientY - r.top)
		if (ref !== hovered) {
			hovered = ref
			dirty = true
			opts.onHover?.(ref)
		}
	})
	const end = () => {
		drag = null
		canvas.style.cursor = "grab"
	}
	canvas.addEventListener("pointerup", end)
	canvas.addEventListener("pointercancel", end)
	canvas.addEventListener("pointerleave", () => {
		if (hovered !== null) {
			hovered = null
			dirty = true
			opts.onHover?.(null)
		}
	})
	canvas.addEventListener("wheel", (e) => {
		e.preventDefault()
		distance *= Math.exp(e.deltaY * 0.001)
		lastInteraction = performance.now()
		dirty = true
	}, { passive: false })
	new ResizeObserver(resize).observe(host)
	resize()

	return {
		update({ caseStl, circuit: nextCircuit } = {}) {
			let changed = false
			if (caseStl !== undefined && caseStl !== caseKey) {
				caseKey = caseStl
				caseTris = caseStl ? parseStl(caseStl) : null
				caseEdges = caseTris ? featureEdges(caseTris) : []
				changed = true
			}
			if (nextCircuit !== undefined) {
				const key = JSON.stringify(nextCircuit ?? null)
				if (key !== circuitKey) {
					circuitKey = key
					circuit = nextCircuit
					board = circuit ? boardMesh(circuit, parts) : null
					changed = true
				}
			}
			if (changed) rebuild()
		},
		setExplode(t) {
			explodeTarget = Math.max(0, Math.min(1, t))
			lastInteraction = performance.now() - IDLE_AFTER_MS / 2
		},
		highlight(ref) {
			focused = ref
			dirty = true
		},
		// Extension (bench): the board on the desk's attitude in radians, already low-pass filtered by the caller;
		// null levels the model again. Yaw stays the camera's.
		setOrientation(pitchRad, rollRad) {
			if (pitchRad === null || rollRad === null || pitchRad === undefined) {
				tiltTarget = { pitch: 0, roll: 0 }
				tiltAt = -Infinity
			} else {
				tiltTarget = { pitch: pitchRad, roll: rollRad }
				tiltAt = performance.now()
			}
			dirty = true
		},
		// Extension: parts ({ref, role}) so part heights and colours follow their roles.
		setParts(list) {
			parts = list ?? []
			if (circuit) {
				board = boardMesh(circuit, parts)
				rebuild()
			}
		},
	}
}
