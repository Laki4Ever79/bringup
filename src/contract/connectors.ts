// Connectors on the board's edges (moved from consistency.ts, 17 Nov 2026): each on its edge and clear of the others, the
// checks that say when one isn't, and the packer an outline change uses (agents/contract-tools.ts) and the space model
// judges every size with (space.ts resized), so both put them in the same place.
import { connectorAlongMm, connectorBoxes, connectorExtents, moduleBlocked } from "../codegen/circuit.ts"
import { MIN_WALL_MM, SLOT_MARGIN_MM } from "./case.ts"
import type { Violation } from "./consistency.ts"
import { enclosureMode, type AgentRole, type Connector, type ContractSnapshot, type ContractValues, type FieldName } from "./types.ts"

// Connectors that crowd each other at the board's edge: their footprints overlap, or (with our case) their openings leave
// less than the case's minimum wall between them. Before, only the builds found it ("overlapping slots", "courtyard of
// SW1 overlaps"), and the architect read a build failure instead of the two refs (real system run, 9 Nov).
export function connectorClashes(c: ContractSnapshot): Violation[] {
	const o = c.values.outline
	const connectors = c.values.connectors ?? []
	if (!o || connectors.length < 2) return []
	// By the extent tscircuit judges (connectorExtents), so a corner's two connectors clear by their courtyards.
	const boxes = connectorExtents(c, o.widthMm, o.heightMm)
	const out: Violation[] = []
	for (let i = 0; i < connectors.length; i++)
		for (let j = i + 1; j < connectors.length; j++) {
			const [a, b] = [connectors[i], connectors[j]]
			const [ba, bb] = [boxes.find((x) => x.ref === a.ref), boxes.find((x) => x.ref === b.ref)]
			const footprints = ba && bb && Math.abs(ba.x - bb.x) < (ba.w + bb.w) / 2 && Math.abs(ba.y - bb.y) < (ba.h + bb.h) / 2
			const span = (k: Connector) => [k.offsetMm - k.widthMm / 2 - SLOT_MARGIN_MM, k.offsetMm + k.widthMm / 2 + SLOT_MARGIN_MM]
			const [sa, sb] = [span(a), span(b)]
			const gap = Math.max(sb[0] - sa[1], sa[0] - sb[1])
			const openings = enclosureMode(c.values) === "case" && a.edge === b.edge && gap < MIN_WALL_MM
			if (!footprints && !openings) continue
			out.push({
				kind: "connector-clash",
				message: `${a.ref} (${a.edge}@${a.offsetMm} mm) and ${b.ref} (${b.edge}@${b.offsetMm} mm) ${footprints ? "overlap on the board" : `leave ${Math.max(0, gap).toFixed(1)} mm of case wall between their openings, under the ${MIN_WALL_MM} mm minimum`}: move one along its edge or to another edge`,
				fields: ["connectors"],
				affects: ["architect"],
			})
		}
	return out
}

// A connector past the end of its edge (bringup-lead, 14 Nov 2026: the scripted rover compacted to 44×28 mm with JT1 at
// top@43 mm, and tscircuit refused the board minutes into its build). Along the edge, by the footprint's real extent
// (connectorBoxes), so a turned JST counts its 7 mm, not the 6 mm the contract lists.
export function connectorsOffEdge(c: ContractSnapshot): Violation[] {
	const o = c.values.outline
	if (!o || !c.values.connectors?.length) return []
	const [W, H] = [o.widthMm, o.heightMm]
	const boxes = connectorBoxes(c, W, H)
	return c.values.connectors.flatMap((k) => {
		const b = boxes.find((x) => x.ref === k.ref)
		if (!b) return []
		const alongX = k.edge === "top" || k.edge === "bottom"
		// Along the edge by the courtyard where it is longer than the box (connectorAlongMm): tscircuit judges that.
		const [centre, size, len] = alongX ? [b.x, connectorAlongMm(c, k.ref, b.w), W] : [b.y, connectorAlongMm(c, k.ref, b.h), H]
		const over = Math.abs(centre) + size / 2 - len / 2
		if (over <= 0.05) return []
		const half = Math.round((size / 2) * 10) / 10
		return [{
			kind: "connector-off-edge" as const,
			message: `${k.ref} (${k.edge}@${k.offsetMm} mm) runs ${over.toFixed(1)} mm past the end of the ${len} mm ${k.edge} edge: its footprint is ${size} mm along it, so its offset goes from ${half} to ${Math.round((len - half) * 10) / 10} mm; move it along the edge (a shrunk board keeps each connector's place in proportion)`,
			fields: ["connectors"] as FieldName[],
			affects: ["architect"] as AgentRole[],
		}]
	})
}

// The connectors moved along their edges so none runs past the end of its edge or overlaps another, or null when none
// does (or no packing helps). An outline change follows with this (rover run cc-rover-3, 15 Nov 2026: the architect
// shrank the board from 78x17 to 78x16 mm, left J5 at right@13.5 mm, 1 mm past the edge, and the run ended with it
// open; J5 moved alone then overlapped JM2 on the same 16 mm edge). Per edge, in order along it, each footprint is pushed
// inside the edge and clear of its neighbour (by the case's minimum wall when the openings share a case wall), moving
// each as little as that allows, in half millimetres; the checks themselves judge the result.
// opts.clearModule: also move a connector out of the radio module's strip (clearModule). Only for the architect's own
// connector write: the space model's size search (space.ts resized) judges sizes as they are, and clearing there
// changed which sizes it accepted, so scripted runs stopped settling (agents-scripted, mech-agent, 21 Nov 2026).
export function connectorsOntoEdges(c: ContractSnapshot, opts: { clearModule?: boolean } = {}): ContractValues["connectors"] | null {
	const o = c.values.outline
	if (!o || !c.values.connectors?.length) return null
	const problems = (connectors: Connector[]) => {
		const t = { ...c, values: { ...c.values, connectors } }
		return connectorsOffEdge(t).length + connectorClashes(t).length
	}
	const before = problems(c.values.connectors)
	if (before === 0) return opts.clearModule ? clearModule(c, c.values.connectors) : null
	const gap = enclosureMode(c.values) === "case" ? MIN_WALL_MM : 0
	const boxAt = (connectors: Connector[], ref: string) => {
		const k = connectors.find((x) => x.ref === ref)!
		const b = connectorBoxes({ ...c, values: { ...c.values, connectors } }, o.widthMm, o.heightMm).find((x) => x.ref === ref)!
		const alongX = k.edge === "top" || k.edge === "bottom"
		return { centre: alongX ? b.x : b.y, size: connectorAlongMm(c, ref, alongX ? b.w : b.h) }
	}
	let connectors = c.values.connectors
	for (const edge of ["top", "bottom", "left", "right"] as const) {
		const len = edge === "top" || edge === "bottom" ? o.widthMm : o.heightMm
		// Each footprint as a span in the offset's own direction: p moves 1:1 with offsetMm.
		const spans = connectors.filter((k) => k.edge === edge).map((k) => {
			const a = boxAt(connectors, k.ref)
			const nudged = boxAt(connectors.map((x) => (x.ref === k.ref ? { ...x, offsetMm: x.offsetMm + 1 } : x)), k.ref)
			const dir = nudged.centre >= a.centre ? 1 : -1
			return { ref: k.ref, offset: k.offsetMm, p: dir * a.centre, half: a.size / 2 }
		}).sort((x, y) => x.p - y.p)
		if (spans.length === 0) continue
		const target = spans.map((x) => x.p)
		const up = (v: number) => Math.ceil(v * 2 - 1e-9) / 2
		const down = (v: number) => Math.floor(v * 2 + 1e-9) / 2
		// Right to left: inside the far end and clear of the next one; then left to right: inside the near end and clear.
		for (let i = spans.length - 1; i >= 0; i--) {
			const limit = i === spans.length - 1 ? len / 2 - spans[i].half : target[i + 1] - spans[i + 1].half - gap - spans[i].half
			if (target[i] > limit) target[i] = spans[i].p + down(limit - spans[i].p)
		}
		for (let i = 0; i < spans.length; i++) {
			const limit = i === 0 ? -len / 2 + spans[i].half : target[i - 1] + spans[i - 1].half + gap + spans[i].half
			if (target[i] < limit) target[i] = spans[i].p + up(limit - spans[i].p)
		}
		connectors = connectors.map((k) => {
			const i = spans.findIndex((x) => x.ref === k.ref)
			return i < 0 || target[i] === spans[i].p ? k : { ...k, offsetMm: spans[i].offset + (target[i] - spans[i].p) }
		})
	}
	// Across a corner (rover run cc-rover-4: J1 at bottom@42 mm and JM2 at right@10 mm overlapped on a 54x24 board, which
	// packing each edge alone can't see): the smallest single move along its own edge that leaves fewer problems, repeated.
	let now = problems(connectors)
	for (let round = 0; round < 2 * connectors.length && now > 0; round++) {
		let best: { connectors: Connector[]; step: number; left: number } | null = null
		for (const k of connectors) {
			const len = k.edge === "top" || k.edge === "bottom" ? o.widthMm : o.heightMm
			for (let step = 0.5; step <= len && (best === null || step <= best.step); step += 0.5) {
				for (const at of [k.offsetMm - step, k.offsetMm + step]) {
					if (at < 0 || at > len) continue
					const tried = connectors.map((x) => (x.ref === k.ref ? { ...x, offsetMm: at } : x))
					const left = problems(tried)
					if (left < now && (best === null || step < best.step || left < best.left)) best = { connectors: tried, step, left }
				}
			}
		}
		if (best === null) break
		connectors = best.connectors
		now = best.left
	}
	if (!opts.clearModule) return now < before ? connectors : null
	const packed = now < before ? connectors : c.values.connectors
	return clearModule(c, packed) ?? (now < before ? connectors : null)
}

// The radio module's edge cleared (moduleBlocked): each connector in its way moves along its own edge to the nearest
// offset that leaves the module its spot and adds no off-edge or clash, as module-blocked's message words it (the Rover +
// climate system mock, 20 Nov 2026: the link plug JL1 at right@20 mm sat in the antenna's strip; "right@15.9 mm is the
// nearest spot that clears it" was said every revision, and the board never built). null when nothing changes.
function clearModule(c: ContractSnapshot, connectors: Connector[]): Connector[] | null {
	const o = c.values.outline
	const at = (cs: Connector[]) => ({ ...c, values: { ...c.values, connectors: cs } })
	const m = moduleBlocked(at(connectors))
	if (!o || !m || m.blockers.length === 0) return connectors === c.values.connectors ? null : connectors
	const problems = (cs: Connector[]) => connectorsOffEdge(at(cs)).length + connectorClashes(at(cs)).length
	const base = problems(connectors)
	let out = connectors
	for (const ref of m.blockers) {
		const k = out.find((x) => x.ref === ref)
		if (!k) continue
		const len = k.edge === "left" || k.edge === "right" ? o.heightMm : o.widthMm
		let best: number | null = null
		for (let off = k.widthMm / 2 + 1; off <= len - k.widthMm / 2 - 1; off += 0.5) {
			if (best !== null && Math.abs(off - k.offsetMm) >= Math.abs(best - k.offsetMm)) continue
			const tried = out.map((x) => (x.ref === ref ? { ...x, offsetMm: off } : x))
			if (problems(tried) <= base && !moduleBlocked(at(tried))?.blockers.includes(ref)) best = off
		}
		if (best !== null) out = out.map((x) => (x.ref === ref ? { ...x, offsetMm: best! } : x))
	}
	return out === c.values.connectors ? null : out
}
