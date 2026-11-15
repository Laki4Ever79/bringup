// The edit model of a system's Top view (pure): moves, rotations, the plate, standoffs and cables, with the code checks
// run on every change, undo and redo. No model is called: agents run only after Apply. The geometry and the I2C cable
// limit come from assembly-geom.js, the same module the server's checks import, so the page and the run agree.
// Frame: +x forward, +y left, origin at the plate centre; rotDeg is counter-clockwise from above; edges are the
// board's own (left/right/top/bottom, before it is turned), as in top-layout.js.
import { blocksSensor, boardsOverlap, cableLength, CABLE_SLACK_MM, footprint, i2cCableLimit, motorHalfUnder, motorUnderPlateMm, mountOnPlate, offPlate, plateMaxWidthMm, STANDOFF_DEFAULT_MM, STANDOFF_RANGE_MM, STANDOFF_USUAL_MM, wheelsRubPlate } from "./assembly-geom.js"

export const SNAP_MM = 0.5
export { STANDOFF_DEFAULT_MM, STANDOFF_RANGE_MM, STANDOFF_USUAL_MM }
const NORMAL = { left: [-1, 0], right: [1, 0], top: [0, 1], bottom: [0, -1] }
const snap = (v) => Math.round(v / SNAP_MM) * SNAP_MM
const r1 = (n) => Math.round(n * 10) / 10
const clone = (v) => JSON.parse(JSON.stringify(v))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function turn([x, y], deg) {
	const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t)
	return [x * c - y * s, x * s + y * c]
}

// The edge of the board (its own frame) whose outward direction, once turned, is the dominant direction of (dx, dy).
function edgeToward(b, dx, dy) {
	const n = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1]
	for (const e of Object.keys(NORMAL)) {
		const [nx, ny] = turn(NORMAL[e], b.rotDeg)
		if (Math.round(nx) === n[0] && Math.round(ny) === n[1]) return e
	}
	return "right"
}

// The middle of the board's edge, in the assembly frame.
function edgePoint(b, edge) {
	const { widthMm: W, heightMm: H } = b.outline
	const local = { left: [-W / 2, 0], right: [W / 2, 0], top: [0, H / 2], bottom: [0, -H / 2] }[edge] ?? [0, 0]
	const [px, py] = turn(local, b.rotDeg)
	return { xMm: r1(b.xMm + px), yMm: r1(b.yMm + py) }
}

// True when a cable can leave the board's edge toward p: p is not behind that edge.
function reaches(b, edge, p) {
	const [nx, ny] = turn(NORMAL[edge], b.rotDeg)
	const q = edgePoint(b, edge)
	return nx * (p.xMm - q.xMm) + ny * (p.yMm - q.yMm) >= -1e-9
}
// The edge a cable leaves from toward p: its own (the board's real connector) while it can still reach p, else the edge
// facing p. Moving a connector to another edge is a board change, so the real edge is kept whenever it works.
function edgeFor(b, edge, p) {
	return edge && NORMAL[edge] && reaches(b, edge, p) ? edge : edgeToward(b, p.xMm - b.xMm, p.yMm - b.yMm)
}

const rectsOverlap = (b, r) => {
	const f = footprint(b)
	return Math.abs(b.xMm - r.xMm) < (f.xMm + r.wMm) / 2 && Math.abs(b.yMm - r.yMm) < (f.yMm + r.hMm) / 2
}

// What a board may not sit over, from the chassis spec (src/tools/chassis.ts ChassisSpec): the two wheels and the battery.
// The caster is not one: it hangs under the plate (src/mechanics/model.ts), and the boards stand on standoffs above it.
export function keepOuts(chassis) {
	if (!chassis) return []
	const out = []
	const d = chassis.drive
	if (d) for (const s of [1, -1]) out.push({ what: "a wheel", xMm: d.axleXMm, yMm: s * d.trackMm / 2, wMm: d.wheelDiameterMm, hMm: d.wheelWidthMm })
	// The battery lies on the plate: a board on standoffs may stand over it when they clear its thickness (thickMm), the
	// rule src/mechanics/checks.ts applies (the pack fits when it is at most the standoff height less 1 mm).
	if (chassis.battery) out.push({ what: "the battery", xMm: chassis.battery.xMm, yMm: chassis.battery.yMm, wMm: chassis.battery.sizeMm[0], hMm: chassis.battery.sizeMm[1], ...(chassis.battery.sizeMm[2] > 0 ? { thickMm: chassis.battery.sizeMm[2] } : {}) })
	return out
}

// The chassis parts the plate carries, as mounts (src/mechanics/model.ts mounts, from the chassis spec's numbers): the
// motors (across the plate their body's long side), the battery, the caster and the forward-looking sensor.
export function chassisMounts(chassis) {
	if (!chassis) return []
	const out = []
	for (const m of chassis.motors ?? []) out.push({ what: `motor ${m.side}`, xMm: m.xMm, yMm: m.yMm, sizeMm: [m.bodyMm[1], m.bodyMm[0], m.bodyMm[2]] })
	if (chassis.battery) out.push({ what: "battery", xMm: chassis.battery.xMm, yMm: chassis.battery.yMm, sizeMm: chassis.battery.sizeMm })
	if (chassis.caster?.wheelMm) out.push({ what: "caster", xMm: chassis.caster.xMm, yMm: 0, sizeMm: [chassis.caster.wheelMm, chassis.caster.wheelMm, chassis.caster.heightMm ?? 0] })
	const s = chassis.sensor
	if (s?.sizeMm) out.push({ what: "sensor", xMm: s.xMm, yMm: s.yMm, zMm: s.zMm, sizeMm: [s.sizeMm[2], s.sizeMm[0], s.sizeMm[1]] })
	return out
}

// start: {assembly, links, chassis?: ChassisSpec, maxSizeMm?: [length, width], i2cDevicesByBoard?: {[board]: n} (the server's i2cDevices; the link's limit sums its two ends, as checks.ts does)}
export function editor(start) {
	const chassis = start.chassis ?? null
	const maxSizeMm = start.maxSizeMm ?? null
	const devices = start.i2cDevicesByBoard ?? {}
	// Each link end starts from its board's real connector edge (the link's connector is J + its id, src/system/derive.ts)
	// when the system leaves the edge unset: the editor never makes up an edge the board doesn't have.
	const connectors = start.connectors ?? {}
	const startLinks = clone(start.links).map((l) => {
		for (const end of ["a", "b"]) {
			const real = l[end].edge ? null : (connectors[l[end].board] ?? []).find((k) => k.ref === `J${l.id}`)?.edge
			if (real && NORMAL[real]) l[end] = { ...l[end], edge: real }
		}
		return l
	})
	// A snapshot is the editable part: the assembly, the links, and which cables the user routed by hand.
	const snapshot = (assembly, links, custom = [], pinned = []) => ({ assembly: clone(assembly), links: clone(links), custom: [...custom], pinned: [...pinned] })
	const applied0 = snapshot(start.assembly, startLinks)
	// ops[i] is the edit that made history[i] (pending() replays them on a newer design).
	let history = [applied0], ops = [null], at = 0, floor = 0
	let applied = applied0
	const cur = () => history[at]

	const board = (s, name) => {
		const b = s.assembly.boards.find((x) => x.name === name)
		if (!b) throw new Error(`no board named ${name}`)
		return b
	}
	const link = (s, id) => {
		const l = s.links.find((x) => x.id === id)
		if (!l) throw new Error(`no link ${id}`)
		return l
	}
	const cables = (s) => (s.assembly.cables ??= [])
	const setRoute = (s, l, points, hand) => {
		const list = cables(s)
		const c = list.find((x) => x.link === l.id)
		if (c) c.points = points; else list.push({ link: l.id, points })
		l.cable = { ...l.cable, lengthMm: Math.round(cableLength(points) + CABLE_SLACK_MM) }
		s.custom = s.custom.filter((x) => x !== l.id)
		if (hand) s.custom.push(l.id)
	}
	// The straight route between the two edges the link leaves from.
	const autoRoute = (s, l) => {
		const a = board(s, l.a.board), b = board(s, l.b.board)
		setRoute(s, l, [edgePoint(a, l.a.edge ?? edgeToward(a, b.xMm - a.xMm, b.yMm - a.yMm)), edgePoint(b, l.b.edge ?? edgeToward(b, a.xMm - b.xMm, a.yMm - b.yMm))], false)
	}
	// After a board moves or turns, each cable on it keeps its edge while it can still reach the cable's next point (a
	// hand-routed cable's next bend, else the peer board), and otherwise leaves from the edge facing it; an end the user
	// pinned with cable-edge stays. A hand-routed cable's end on the board moves onto the edge when it changed or turned.
	const reroute = (s, name, turned = false) => {
		for (const l of s.links) {
			const c = cables(s).find((x) => x.link === l.id)
			if ((l.a.board !== name && l.b.board !== name) || !c) continue
			const a = board(s, l.a.board), b = board(s, l.b.board)
			if (s.custom.includes(l.id)) {
				const pts = c.points
				if (pts.length < 2) continue
				for (const [end, bd, i, j] of [["a", a, 0, 1], ["b", b, pts.length - 1, pts.length - 2]]) {
					if (bd.name !== name) continue
					const was = l[end].edge
					const e = s.pinned.includes(`${l.id}.${end}`) ? was : edgeFor(bd, was, pts[j])
					if (!e) continue
					if (e !== was || turned) { l[end] = { ...l[end], edge: e }; pts[i] = edgePoint(bd, e) }
				}
				l.cable = { ...l.cable, lengthMm: Math.round(cableLength(pts) + CABLE_SLACK_MM) }
				continue
			}
			if (!s.pinned.includes(`${l.id}.a`)) l.a = { ...l.a, edge: edgeFor(a, l.a.edge, b) }
			if (!s.pinned.includes(`${l.id}.b`)) l.b = { ...l.b, edge: edgeFor(b, l.b.edge, a) }
			autoRoute(s, l)
		}
	}

	function next(op) {
		const s = clone(cur())
		switch (op.kind) {
			case "move": {
				const b = board(s, op.board)
				const dx = snap(op.xMm) - b.xMm, dy = snap(op.yMm) - b.yMm
				b.xMm = snap(op.xMm); b.yMm = snap(op.yMm)
				// A routed cable follows its board: the end on it moves by the same step.
				for (const l of s.links) {
					const c = cables(s).find((x) => x.link === l.id)
					if (!c || !c.points.length || (l.a.board !== b.name && l.b.board !== b.name)) continue
					if (s.custom.includes(l.id)) {
						const i = l.a.board === b.name ? 0 : c.points.length - 1
						c.points[i] = { xMm: r1(c.points[i].xMm + dx), yMm: r1(c.points[i].yMm + dy) }
						l.cable = { ...l.cable, lengthMm: Math.round(cableLength(c.points) + CABLE_SLACK_MM) }
					}
				}
				reroute(s, b.name)
				break
			}
			case "rotate": {
				const b = board(s, op.board)
				b.rotDeg = (b.rotDeg + 90) % 360
				reroute(s, b.name, true)
				break
			}
			case "plate":
				if (s.assembly.body === "separate") throw new Error("a separate body has no plate")
				s.assembly.plate = { lengthMm: snap(op.lengthMm), widthMm: snap(op.widthMm) }
				break
			case "standoff":
				board(s, op.board).standoffMm = snap(op.heightMm)
				break
			case "cable-add": {
				const a = board(s, op.a), b = board(s, op.b)
				if (a === b) throw new Error("a cable joins two different boards")
				const kind = op.cableKind ?? op.linkKind ?? "uart"
				let n = 1
				while (s.links.some((x) => x.id === `L${n}`)) n++
				const l = {
					id: `L${n}`, kind,
					a: { board: a.name, edge: edgeToward(a, b.xMm - a.xMm, b.yMm - a.yMm) },
					b: { board: b.name, edge: edgeToward(b, a.xMm - b.xMm, a.yMm - b.yMm) },
					cable: { lengthMm: 100 },
				}
				if (kind === "i2c") l.i2c = { controller: a.name, targets: { [b.name]: 0x30 }, pullupsOn: a.name }
				s.links.push(l)
				autoRoute(s, l)
				break
			}
			case "cable-remove": {
				link(s, op.link)
				s.links = s.links.filter((x) => x.id !== op.link)
				s.assembly.cables = cables(s).filter((c) => c.link !== op.link)
				s.custom = s.custom.filter((x) => x !== op.link)
				s.pinned = s.pinned.filter((x) => !x.startsWith(`${op.link}.`))
				break
			}
			case "cable-kind": {
				const l = link(s, op.link), kind = op.cableKind ?? op.linkKind
				l.kind = kind
				if (kind === "i2c") l.i2c ??= { controller: l.a.board, targets: { [l.b.board]: 0x30 }, pullupsOn: l.a.board }
				else delete l.i2c
				break
			}
			case "cable-route": {
				const l = link(s, op.link)
				if (!Array.isArray(op.points) || op.points.length < 2) throw new Error("a route needs at least two points")
				const pts = op.points.map((p) => ({ xMm: snap(p.xMm), yMm: snap(p.yMm) }))
				const a = board(s, l.a.board), b = board(s, l.b.board)
				// Each end keeps its edge (the board's real connector) while the first (last) leg can leave from it; otherwise it
				// leaves from the edge the leg points toward, and the route's end moves onto that edge.
				const first = pts[1], last = pts[pts.length - 2]
				const ea = edgeFor(a, l.a.edge, first), eb = edgeFor(b, l.b.edge, last)
				if (ea !== l.a.edge) pts[0] = edgePoint(a, ea)
				if (eb !== l.b.edge) pts[pts.length - 1] = edgePoint(b, eb)
				l.a = { ...l.a, edge: ea }
				l.b = { ...l.b, edge: eb }
				// An end moved onto its edge can land on its neighbouring bend: one point, not two.
				const route = pts.filter((p, i) => i === 0 || p.xMm !== pts[i - 1].xMm || p.yMm !== pts[i - 1].yMm)
				setRoute(s, l, route.length >= 2 ? route : pts, true)
				break
			}
			case "cable-edge": {
				const l = link(s, op.link)
				if (!NORMAL[op.edge]) throw new Error(`no edge ${op.edge}`)
				const end = op.end === "b" ? "b" : "a"
				l[end] = { ...l[end], edge: op.edge }
				if (!s.pinned.includes(`${l.id}.${end}`)) s.pinned.push(`${l.id}.${end}`)
				if (!s.custom.includes(l.id)) autoRoute(s, l)
				break
			}
			default: throw new Error(`unknown edit ${op.kind}`)
		}
		return s
	}

	// The link ends whose edge differs from the applied design's: the board's connector moves, so the board is laid out again.
	function edgeChanges(s) {
		const out = []
		for (const l of s.links) {
			const o = applied.links.find((x) => x.id === l.id)
			if (!o) continue
			for (const end of ["a", "b"]) {
				const from = o[end].edge, to = l[end].edge
				if (from && to && from !== to && o[end].board === l[end].board) out.push({ link: l.id, board: l[end].board, ref: `J${l.id}`, from, to })
			}
		}
		return out
	}

	function checks(s) {
		const out = []
		const a = s.assembly
		const chassisBody = a.body === "chassis"
		const bs = a.boards
		const bad = (target, message, level = "error") => out.push({ target, level, message })
		if (chassisBody) {
			if (a.plate && !(a.plate.lengthMm > 0 && a.plate.widthMm > 0)) bad({ plate: true }, "the plate needs a positive length and width")
			for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) if (boardsOverlap(bs[i], bs[j])) {
				bad({ board: bs[i].name }, `${bs[i].name} overlaps ${bs[j].name}`)
				bad({ board: bs[j].name }, `${bs[j].name} overlaps ${bs[i].name}`)
			}
			if (a.plate) for (const b of bs) if (offPlate(b, a.plate)) bad({ board: b.name }, `${b.name} sticks out of the ${a.plate.lengthMm} × ${a.plate.widthMm} mm plate`)
			for (const b of bs) for (const k of keepOuts(chassis)) {
				if (!rectsOverlap(b, k)) continue
				// The board's own standoffs, else the chassis's (the mechanics' estimate, 10 mm), else the default.
				const standoff = b.standoffMm ?? chassis?.standoffMm ?? STANDOFF_DEFAULT_MM
				if (k.thickMm === undefined) bad({ board: b.name }, `${b.name} is over ${k.what}`)
				else if (k.thickMm > standoff - 1) bad({ board: b.name }, `${b.name} is over ${k.what}: the ${k.thickMm} mm pack needs standoffs of at least ${k.thickMm + 1} mm (now ${standoff} mm)`)
			}
			// The mechanics' fit rules (assembly-geom.js, the same functions mech-fit calls), so a move main's run would
			// refuse after a round is refused here at once.
			if (a.plate && chassis) {
				const L = a.plate.lengthMm, W = a.plate.widthMm
				const d = chassis.drive
				if (d && wheelsRubPlate(W, d.trackMm, d.wheelWidthMm)) bad({ plate: true }, `the wheels rub the ${W} mm-wide plate (${d.trackMm} mm track, ${d.wheelWidthMm} mm wheels, 2 mm clearance): make it at most ${r1(plateMaxWidthMm(d.trackMm, d.wheelWidthMm))} mm wide`)
				const parts = chassisMounts(chassis)
				for (const m of parts.filter((x) => x.what.startsWith("motor ")))
					if (!motorHalfUnder(W, m)) bad({ plate: true }, `${m.what} reaches only ${r1(Math.max(0, motorUnderPlateMm(W, m)))} mm under the plate (half its ${m.sizeMm[1]} mm body needed for the bracket): widen the plate`)
				for (const m of parts.filter((x) => !x.what.startsWith("motor ")))
					if (!mountOnPlate(m, L, W)) bad({ plate: true }, `${m.what} (${r1(m.sizeMm[0])} × ${r1(m.sizeMm[1])} mm at ${r1(m.xMm)}, ${r1(m.yMm)}) doesn't fit on the ${L} × ${W} mm plate`)
				const sensor = parts.find((x) => x.what === "sensor")
				if (sensor && chassis.plate) for (const b of bs) {
					const f = footprint(b)
					const standoff = b.standoffMm ?? chassis.standoffMm ?? STANDOFF_DEFAULT_MM
					const m = { xMm: b.xMm, yMm: b.yMm, zMm: chassis.plate.clearanceMm + chassis.plate.thicknessMm + standoff + 0.8, sizeMm: [f.xMm, f.yMm, 1.6] }
					if (blocksSensor(m, sensor)) bad({ board: b.name }, `${b.name} stands in front of the distance sensor (at x ${r1(sensor.xMm)} mm): move it back or aside`)
				}
			}
			if (maxSizeMm && a.plate) {
				const outerW = Math.max(a.plate.widthMm, chassis?.drive ? chassis.drive.trackMm + chassis.drive.wheelWidthMm : 0)
				if (a.plate.lengthMm > maxSizeMm[0] || outerW > maxSizeMm[1]) bad({ plate: true }, `the robot is ${a.plate.lengthMm} × ${r1(outerW)} mm, over the ${maxSizeMm[0]} × ${maxSizeMm[1]} mm the brief allows`)
			}
		}
		for (const b of bs) {
			const h = b.standoffMm
			if (h === undefined) continue
			if (!(h >= STANDOFF_RANGE_MM[0] && h <= STANDOFF_RANGE_MM[1])) bad({ board: b.name }, `${b.name}'s standoffs are ${h} mm; use ${STANDOFF_RANGE_MM[0]} to ${STANDOFF_RANGE_MM[1]} mm`)
			else if (h < STANDOFF_USUAL_MM[0] || h > STANDOFF_USUAL_MM[1]) bad({ board: b.name }, `${b.name}'s standoffs are ${h} mm; ${STANDOFF_USUAL_MM[0]} to ${STANDOFF_USUAL_MM[1]} mm is the usual range`, "warn")
		}
		for (const x of edgeChanges(s)) bad({ link: x.link }, `moves ${x.ref} on ${x.board} from ${x.from} to ${x.to} edge: a board change`, "warn")
		for (const l of s.links) {
			const c = cables(s).find((x) => x.link === l.id)
			const routed = c && c.points.length >= 2
			const length = routed ? Math.round(cableLength(c.points) + CABLE_SLACK_MM) : l.cable.lengthMm
			if (l.kind === "i2c") {
				const khz = l.i2c?.khz ?? 100
				const { maxMm } = i2cCableLimit(khz, (devices[l.a.board] ?? 0) + (devices[l.b.board] ?? 0))
				if (length > maxMm) bad({ link: l.id }, `${l.id}: this cable is ${length} mm; at ${khz} kHz an I2C bus allows about ${Math.round(maxMm)} mm (estimate). Shorten it, or use UART`)
			}
		}
		return out
	}

	const patch = (from, to) => {
		const asm = {}
		if (!same(from.assembly.boards, to.assembly.boards)) asm.boards = clone(to.assembly.boards)
		if (!same(from.assembly.plate, to.assembly.plate)) asm.plate = clone(to.assembly.plate)
		if (!same(from.assembly.cables ?? [], to.assembly.cables ?? [])) asm.cables = clone(to.assembly.cables ?? [])
		const out = {}
		if (Object.keys(asm).length) out.assembly = asm
		if (!same(from.links, to.links)) out.links = clone(to.links)
		return Object.keys(out).length ? out : null
	}

	return {
		// Applies one edit; returns false (and changes nothing) when it leaves the design as it was.
		apply(op) {
			const s = next(op)
			if (same(s, cur())) return false
			history = history.slice(0, at + 1)
			ops = ops.slice(0, at + 1)
			history.push(s)
			ops.push(clone(op))
			at = history.length - 1
			return true
		},
		// Undo never goes past the last applied state: what Apply sent is not silently reverted.
		undo() { if (at > floor) { at--; return true } return false },
		redo() { if (at < history.length - 1) { at++; return true } return false },
		canUndo: () => at > floor,
		canRedo: () => at < history.length - 1,
		state() { const s = cur(); return { assembly: clone(s.assembly), links: clone(s.links) } },
		// What differs from the last applied state, as a request body; null when nothing does.
		diff: () => patch(applied, cur()),
		markApplied() { applied = cur(); floor = at },
		findings: () => checks(cur()),
		// The connectors the edits move to another edge (a board change), against the last applied state.
		edgeChanges: () => edgeChanges(cur()),
		// The findings an edit would give, without making it (a drag in progress): the history, redo included, is untouched.
		check(op) { try { return checks(next(op)) } catch { return checks(cur()) } },
		// The edits since the last Apply, in order (undone ones left out).
		pending: () => clone(ops.slice(floor + 1, at + 1)),
	}
}
