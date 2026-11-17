import { connectorsOntoEdges } from "./connectors.ts"
import { antennaOverhang, boardParts, debugPort, layoutBoard, moduleBlocked, moduleFreedAlongEdges, placeParts, recoveryPads, testPoints } from "../codegen/circuit.ts"
import { caseOf, minCaseHeight } from "./case.ts"
import type { AgentRole, ContractSnapshot, FieldName, SizeReason } from "./types.ts"

// Space rules (docs/space-rules.md), approved by the engineer on 6 Nov 2026:
// 1. Hard limits (manufacturing, printing, keep-outs, connector access) are part of the minimum, never traded away.
// 2. Compact by default: at most SLACK_LIMIT over the computed minimum, for the board's area and the case's height.
// 3. More than that only for a reason from SIZE_REASONS, recorded in the design (outline.sizeReason, case.sizeReason).
// 4. When rules conflict: safety and manufacturability, then the engineer's own words, then function, usability,
//    compactness, cost.
export const SLACK_LIMIT = 0.15
// The routing ceiling: component courtyards over at most this share of the board. Rule of thumb for 2-layer boards
// (J. Watson, "Density Feasibility", I-Connect007, Nov 2020, citing IPC-2221 §3.6.2; PCBWay's glossary puts the
// multilayer threshold at 75-80%). A board packed tighter than this is not counted as a feasible minimum.
export const MAX_DENSITY = 0.7
// IPC-7351 courtyard excess per side at the nominal density level (secondary sources give 0.15-0.25 mm for small
// chips; the larger, so the estimate errs toward a bigger minimum).
export const COURTYARD_MM = 0.25

export const SIZE_REASONS = {
	"engineer-size": "the engineer set the size (in the brief or a request)",
	usability: "room to use it: a reachable button or connector, finger room",
	"standard-fit": "a standard fit: an existing enclosure, a mounting pattern, a rail",
	function: "function: heat or noise kept away from a sensor, RF clearance",
	"assembly-test": "assembly and test: test pads, hand soldering, rework access",
	expansion: "planned expansion: room kept for a part to be added later",
	// The minimum is a placement estimate; the router can still fail at a given size (the logger at 36×21 mm: a VBUS
	// via beside J1's locating hole). A measured failure makes the room a manufacturing need, priority 1.
	routing: "routing: a smaller board was built and failed its checks (measured, not guessed)",
} as const
export type SizeReasonKind = keyof typeof SIZE_REASONS

export interface MinimumBoard {
	widthMm: number
	heightMm: number
	areaMm2: number
	// Courtyards of every part the board carries, generated support parts included.
	courtyardMm2: number
	// What set the minimum: the packed placement, or the routing ceiling.
	limitedBy: "placement" | "density"
	// For each board height, the narrowest width that places every part: the shapes a compact board can take.
	shapes: { widthMm: number; heightMm: number }[]
	// Sizes of this design that were built and failed to route (recordRoutingFailure): no shape sits inside one.
	failed?: { widthMm: number; heightMm: number }[]
}

// The sizes of each design (its parts, connectors, pins and rails) that were built and failed to route. Measured, so the
// smallest board never offers them, or any size inside one, again: placement alone said the 60×21 mm rover fit, the
// build failed after 10 minutes, and nothing stopped the architect shrinking back to it (backlog, 15 Nov 2026). Kept for
// the process (one run); a changed design starts clean, since what crowded the router may be gone.
const failures = new Map<string, { widthMm: number; heightMm: number }[]>()
const designKey = (s: ContractSnapshot) => {
	const { parts, connectors, pins, rails } = s.values
	return JSON.stringify({ parts, connectors, pins, rails, t: s.values.outline?.thicknessMm })
}
// Connectors are stored at their place on the failed board; the same design at another size has them elsewhere, so
// the key keeps only which edge each is on.
const keyOf = (s: ContractSnapshot) => designKey({ ...s, values: { ...s.values, connectors: (s.values.connectors ?? []).map((c) => ({ ...c, offsetMm: 0 })) } })

export function recordRoutingFailure(s: ContractSnapshot, widthMm: number, heightMm: number): void {
	const key = keyOf(s)
	const list = failures.get(key) ?? []
	if (list.some((f) => widthMm <= f.widthMm && heightMm <= f.heightMm)) return
	failures.set(key, [...list.filter((f) => !(f.widthMm <= widthMm && f.heightMm <= heightMm)), { widthMm, heightMm }])
	cache.clear()
}

export function routingFailures(s: ContractSnapshot): { widthMm: number; heightMm: number }[] {
	return failures.get(keyOf(s)) ?? []
}

// Inside a size that failed to route: no bigger in either direction.
const insideFailed = (s: ContractSnapshot, w: number, h: number) => routingFailures(s).some((f) => w <= f.widthMm + 1e-9 && h <= f.heightMm + 1e-9)

// The design with the outline set to w x h, connectors kept at the same relative place along their edges.
// The connectors on a board resized to w × h: each at the same relative place along its edge, on the 0.5 mm grid. The
// space model judges every size this way, and an outline change moves the contract's connectors the same way in the
// same revision (agents/contract-tools.ts), so a size it calls placeable is the one the build gets (run 19b: "e.g.
// 48×29 mm" at rev 33, then "48×29 has no spot for U7" at rev 35, with the connectors left where the 42×28 board had them).
export function scaledConnectors(s: ContractSnapshot, w: number, h: number): ContractSnapshot["values"]["connectors"] {
	const o = s.values.outline!
	return (s.values.connectors ?? []).map((c) => {
		const along = c.edge === "left" || c.edge === "right" ? [o.heightMm, h] : [o.widthMm, w]
		return { ...c, offsetMm: Math.round(((c.offsetMm * along[1]) / along[0]) * 2) / 2 }
	})
}

// The board as an outline change makes it (agents/contract-tools.ts): the connectors scaled along their edges, then
// fitted onto them and clear of each other (connectorsOntoEdges), so a size judged here is the one the contract gets.
// Before (17 Nov 2026), only scaled: the contract packed them and the model didn't, so a size the model called
// placeable could fail (run 20: "the smallest is 31×45", and 46×38 had no room for U8).
function resized(s: ContractSnapshot, w: number, h: number): ContractSnapshot {
	const o = s.values.outline!
	const r = { ...s, values: { ...s.values, outline: { ...o, widthMm: w, heightMm: h }, connectors: scaledConnectors(s, w, h) } }
	const packed = connectorsOntoEdges(r)
	return packed ? { ...r, values: { ...r.values, connectors: packed } } : r
}

const cache = new Map<string, MinimumBoard | null>()

// Every part placed at w x h (connectors kept at the same relative place along their edges), and the bottom pads the
// board must have: the recovery pads of a deep-sleeping board and a production test's pads (space rule 1: hard needs are
// part of the minimum; the compacted beacon left its recovery pads no spot, 13 Nov 2026). Bring-up pads are not: they
// take only the room left.
export function placesAll(s: ContractSnapshot, w: number, h: number): boolean {
	try {
		const r = resized(s, w, h)
		const layout = layoutBoard(r)
		const placed = new Set(layout.parts.map((p) => p.ref))
		return boardParts(s).every((p) => placed.has(p.ref)) && (layout.debug !== null || !debugPort(r).unplaced) && recoveryPads(r).unplaced.length === 0 && testPoints(r).unplaced.length === 0
	} catch {
		return false
	}
}

// The parts the engineer placed (Part.at) that don't fit where they were put, with what is in the way.
export function blockedPins(s: ContractSnapshot): { ref: string; why: string }[] {
	if (!s.values.outline || !s.values.parts?.some((p) => p.at)) return []
	try {
		return layoutBoard(s).blocked
	} catch {
		return []
	}
}

// The parts that find no spot on the board as it is now.
export function unplacedParts(s: ContractSnapshot): string[] {
	if (!s.values.outline) return []
	try {
		const placed = new Set(placeParts(s).map((p) => p.ref))
		// The debug footprint, reserved like a part (layoutBoard): no room for it is no room.
		return [...boardParts(s).map((p) => p.ref).filter((r) => !placed.has(r)), ...(debugPort(s).unplaced ? ["JD1"] : [])]
	} catch {
		return []
	}
}

// The connectors as they would sit on a w x h board: the same relative place along their edges.
export function connectorsAt(s: ContractSnapshot, w: number, h: number): NonNullable<ContractSnapshot["values"]["connectors"]> {
	return resized(s, w, h).values.connectors ?? []
}

// The smallest board outline (1 mm steps) the board generator places every part on, and no smaller than the routing
// ceiling allows. Only placement, which takes milliseconds; routing is proven by building the chosen size. Cached:
// it doesn't depend on the outline's own size, which is what changes most.
export function minimumBoard(s: ContractSnapshot): MinimumBoard | null {
	const o = s.values.outline
	if (!o || !s.values.parts?.length) return null
	const { parts, connectors, pins, rails } = s.values
	const failed = routingFailures(s)
	const key = JSON.stringify({ parts, connectors, pins, rails, t: o.thicknessMm, aspect: [o.widthMm, o.heightMm], failed })
	if (cache.has(key)) return cache.get(key)!
	// A size inside one that failed to route doesn't count, however well it places.
	const fits = (w: number, h: number) => !insideFailed(s, w, h) && placesAll(s, w, h)
	const atSize = placeParts(s)
	const courtyardMm2 = Math.round(atSize.reduce((a, b) => a + (b.w + 2 * COURTYARD_MM) * (b.h + 2 * COURTYARD_MM), 0))
	const floorArea = courtyardMm2 / MAX_DENSITY
	let best: { w: number; h: number } | null = null
	const shapes: { widthMm: number; heightMm: number }[] = []
	// The search runs below the board's own size; when that size itself doesn't hold everything (a part added after the
	// board was compacted), it first grows 2 mm a side at a time, up to 40 mm, so the answer says how big it must be.
	let [W0, H0] = [Math.ceil(o.widthMm), Math.ceil(o.heightMm)]
	for (let k = 0; k < 20 && !fits(W0, H0); k++) [W0, H0] = [W0 + 2, H0 + 2]
	// For each height, the narrowest width that places everything (binary search: a wider board never places fewer).
	for (let h = H0; h >= 10; h--) {
		let lo = 10
		let hi = W0
		if (!fits(hi, h)) continue
		while (lo < hi) {
			const mid = Math.floor((lo + hi) / 2)
			if (fits(mid, h)) hi = mid
			else lo = mid + 1
		}
		shapes.push({ widthMm: hi, heightMm: h })
		if (!best || hi * h < best.w * best.h) best = { w: hi, h }
	}
	if (!best) {
		cache.set(key, null)
		return null
	}
	const packed = best.w * best.h
	const result: MinimumBoard =
		packed >= floorArea
			? { widthMm: best.w, heightMm: best.h, areaMm2: packed, courtyardMm2, limitedBy: "placement", shapes, ...(failed.length ? { failed } : {}) }
			: { widthMm: best.w, heightMm: best.h, areaMm2: Math.round(floorArea), courtyardMm2, limitedBy: "density", shapes, ...(failed.length ? { failed } : {}) }
	cache.set(key, result)
	return result
}

// The compact board closest to the current proportions: of the shapes that place every part within the limit, the
// one whose width-to-height ratio is nearest. The rule judges area; this keeps a 50×30 board from becoming a strip.
// The smallest area a board can have and still meet the engineer's size limit (requirements.size, either way round): the
// base compactness is judged against. Without a limit, or when no shape meets it, the plain minimum. A CAN bus's middle
// board (two connectors and a transceiver) packs smallest at 41 x 31 mm, but "about 50 x 30 mm" caps it at 30 mm tall,
// and no shape within 15 % of 41 x 31 is: so the rule and the limit asked for opposite things and it never settled.
export function compactBase(s: ContractSnapshot, min: MinimumBoard): number {
	const lim = s.values.requirements?.size
	if (!lim || lim.exact) return min.areaMm2
	const within = [...min.shapes, ...limitShapes(s, min, lim)].filter((x) => withinLimit(x, lim)).map((x) => x.widthMm * x.heightMm)
	return within.length ? Math.max(min.areaMm2, Math.min(...within)) : min.areaMm2
}
// The shapes inside the limit, when minimumBoard's (which never grow past the board's own width) has none: for each height
// up to the limit's, the narrowest width within it that places everything.
const limitCache = new Map<string, { widthMm: number; heightMm: number }[]>()
function limitShapes(s: ContractSnapshot, min: MinimumBoard, lim: { widthMm: number; heightMm: number }): { widthMm: number; heightMm: number }[] {
	if (min.shapes.some((x) => withinLimit(x, lim))) return []
	const { parts, connectors, pins, rails, outline } = s.values
	const key = JSON.stringify({ parts, connectors, pins, rails, t: outline?.thicknessMm, lim, failed: routingFailures(s) })
	if (limitCache.has(key)) return limitCache.get(key)!
	const fits = (w: number, h: number) => !insideFailed(s, w, h) && placesAll(s, w, h)
	const out: { widthMm: number; heightMm: number }[] = []
	const [W, H] = [Math.floor(lim.widthMm), Math.floor(lim.heightMm)]
	for (let h = H; h >= 10 && out.length < 6; h--) {
		if (!fits(W, h)) break
		let [lo, hi] = [10, W]
		while (lo < hi) {
			const mid = Math.floor((lo + hi) / 2)
			if (fits(mid, h)) hi = mid
			else lo = mid + 1
		}
		out.push({ widthMm: hi, heightMm: h })
	}
	limitCache.set(key, out)
	return out
}
const withinLimit = (x: { widthMm: number; heightMm: number }, lim: { widthMm: number; heightMm: number }) =>
	(x.widthMm <= lim.widthMm && x.heightMm <= lim.heightMm) || (x.widthMm <= lim.heightMm && x.heightMm <= lim.widthMm)

export function compactOutline(s: ContractSnapshot): { widthMm: number; heightMm: number } | null {
	const o = s.values.outline
	const min = o ? minimumBoard(s) : null
	if (!o || !min) return null
	const ratio = Math.log(o.widthMm / o.heightMm)
	const base = compactBase(s, min)
	const lim0 = s.values.requirements?.size
	const shapes = lim0 && !lim0.exact ? [...min.shapes, ...limitShapes(s, min, lim0)] : min.shapes
	const all = shapes.filter((x) => x.widthMm * x.heightMm <= base * (1 + SLACK_LIMIT) && x.widthMm * x.heightMm >= min.areaMm2)
	// Within the engineer's size limit when any shape is, the closest proportions winning.
	const lim = s.values.requirements?.size
	const fits = lim && !lim.exact ? all.filter((x) => withinLimit(x, lim)) : []
	const ok = fits.length ? fits : all
	ok.sort((a, b) => Math.abs(Math.log(a.widthMm / a.heightMm) - ratio) - Math.abs(Math.log(b.widthMm / b.heightMm) - ratio) || a.widthMm * a.heightMm - b.widthMm * b.heightMm)
	return ok[0] ?? { widthMm: min.widthMm, heightMm: min.heightMm }
}

export interface SpaceViolation {
	kind: "space-slack" | "space-room"
	message: string
	fields: FieldName[]
	affects: AgentRole[]
}

const pct = (x: number) => `${Math.round(x * 100)}%`

// Slack over the minimum, without a recorded reason: the board wakes the architect (the outline is theirs), the case
// the case designer.
// Only a complete design is judged: the minimum depends on the connectors, the rails (the support parts) and the pins,
// so judging it earlier shrank the board against a half-written design, again and again (found in a scripted run).
export const SPACE_INPUTS = ["outline", "parts", "connectors", "rails", "pins"] as const
const complete = (s: ContractSnapshot) => SPACE_INPUTS.every((f) => s.values[f] !== undefined)

// A size given as "about", "at most", "fits in" is a limit, not a reason for extra room (engineer, 13 Nov 2026: the
// demo logger's "about 50 × 30 mm" kept a board 74-82% bigger than its parts need). Without requirements.size, an
// "engineer-size" reason whose own words say so is read the same way.
const LIMIT_WORDS = /\b(about|around|roughly|approx(imately)?|circa|up to|at most|no (bigger|larger|more) than|within|under|max(imum)?|fits? (in|into))\b|~/i
export function sizeReasonHolds(s: ContractSnapshot, r: SizeReason | undefined): boolean {
	if (!r) return false
	if (r.kind !== "engineer-size") return true
	const size = s.values.requirements?.size
	return size ? size.exact : !LIMIT_WORDS.test(r.detail)
}

// quick (the board page, a check per move): only whether everything still has a spot. The smallest-board search, a
// hundred layouts, is skipped: a move doesn't change what the board carries, and a part placed by hand only raises
// the smallest board, which never makes it too big.
export function spaceChecks(s: ContractSnapshot, opts: { quick?: boolean } = {}): SpaceViolation[] {
	const v: SpaceViolation[] = []
	if (!complete(s)) return v
	const o = s.values.outline
	const min = o && !opts.quick ? minimumBoard(s) : null
	// Too small for what it carries: a part with no spot, or a pad the board must have. Caught here, in plain code, not
	// only when a board build fails (a --no-hardware run never builds one).
	if (o && !placesAll(s, o.widthMm, o.heightMm)) {
		// A part the engineer placed where it doesn't fit is part-pinned-blocked's, for the parts owner: a bigger board
		// is not the answer to a part placed on top of another.
		const blocked = new Set(blockedPins(s).map((b) => b.ref))
		// So is a radio module kept off its edge by connectors that can move along their edges: module-blocked says where,
		// and "make it that size" for the same missing spot sent the real rover's architect resizing until its connectors
		// ran off the edge (run 5, 15 Nov 2026). When one can't (no clearing spot on its edge), a bigger board is an
		// answer too, and this check keeps saying so.
		const mod = moduleBlocked(s)
		if (mod && moduleFreedAlongEdges(s)) blocked.add(mod.ref)
		const parts = unplacedParts(s).filter((r) => !blocked.has(r))
		const pads = [...recoveryPads(s).unplaced.map((n) => `recovery pad ${n}`), ...testPoints(s).unplaced.map((n) => `test pad ${n}`)]
		if (blocked.size > 0 && parts.length === 0 && pads.length === 0) return v
		v.push({
			kind: "space-room",
			message: `the ${o.widthMm}×${o.heightMm} mm board has no spot for ${[...parts, ...pads].join(", ") || "everything it carries"}${min ? `: the smallest board that holds everything is ${min.areaMm2} mm², e.g. ${min.widthMm}×${min.heightMm} mm` : ""}; make it that size, or move what crowds it`,
			fields: ["outline"],
			affects: ["architect"],
		})
		return v
	}
	if (opts.quick) return v
	if (o && min) {
		const base = compactBase(s, min)
		const slack = (o.widthMm * o.heightMm) / base - 1
		const limit = !sizeReasonHolds(s, o.sizeReason) && o.sizeReason?.kind === "engineer-size"
		if (slack > SLACK_LIMIT && !sizeReasonHolds(s, o.sizeReason))
			v.push({
				kind: "space-slack",
				message: `the board is ${o.widthMm}×${o.heightMm} mm (${o.widthMm * o.heightMm} mm²), ${pct(slack)} over the smallest it can be (${base} mm², e.g. ${base === min.areaMm2 ? `${min.widthMm}×${min.heightMm} mm by placement` : "the smallest within the engineer's size limit"}): shrink it to within ${pct(SLACK_LIMIT)}, or record why in outline.sizeReason${limit ? `. The engineer's size (${o.sizeReason!.detail}) is a limit, not a reason for extra room: a board within it and compact meets it. Only an exact size (an existing housing, a chassis: requirements.size exact true) keeps it` : ""}`,
				fields: ["outline"],
				affects: ["architect"],
			})
	}
	// Bigger than the engineer's limit, in either orientation, unless a failed build needs the room.
	const size = s.values.requirements?.size
	if (o && size && !size.exact && o.sizeReason?.kind !== "routing") {
		const fits = (w: number, h: number) => o.widthMm <= w + 1e-9 && o.heightMm <= h + 1e-9
		if (!fits(size.widthMm, size.heightMm) && !fits(size.heightMm, size.widthMm))
			v.push({
				kind: "space-slack",
				message: `the board is ${o.widthMm}×${o.heightMm} mm, over the engineer's limit of ${size.widthMm}×${size.heightMm} mm (requirements.size): make it fit within it`,
				fields: ["outline"],
				affects: ["architect"],
			})
	}
	const c = s.values.case
	// No case of ours (requirements.enclosure "none" or "own"): only the board's space counts.
	if (c && o && (s.values.requirements?.enclosure ?? "case") === "case") {
		const need = minCaseHeight(s, c)
		const slack = c.heightMm / need - 1
		if (need > 0 && slack > SLACK_LIMIT && !sizeReasonHolds(s, c.sizeReason))
			v.push({
				kind: "space-slack",
				message: `the case body is ${c.heightMm} mm tall, ${pct(slack)} over the ${need} mm its contents need: lower it to within ${pct(SLACK_LIMIT)}, or record why in case.sizeReason`,
				fields: ["case"],
				affects: ["enclosure"],
			})
	}
	return v
}

// tscircuit's autorouter gives up with these: the board needs room (or less in it), the same as a DRC failure.
// Also the router dropping a via onto a pad (the wake-word board at 35×25 mm: "Via hole at … overlaps SMD pad
// U1.GPIO9") and the placer finding no free spot for a part (tools/board.ts): the same answer, more room. Not the
// router's "cannot select a unique PCB port": it shows on boards that build clean too, so the cause was always another
// error, and "more room" for it widened the rover five times over for a trace past its length bound (15 Nov 2026).
// Also tscircuit's own placement check refusing to route (parts crowding each other on a board too small for them: the
// Eurobot base with servos and a spare motor at 60 × 40 mm, 17 Nov 2026), and traces left with no PCB trace: before,
// neither recorded the size, so no finding asked for a bigger board and the run stayed unsettled with none open.
export const ROUTING_FAILURE = /Autorouting was skipped because \d+ PCB placement errors? (?:was|were) found|has no PCB trace|missing a trace|could not (?:be )?route|failed to route|no route|no room on the board|via hole at .* overlaps/i

export const SIZE_REASON_SHAPE = `sizeReason (optional): {kind: ${Object.keys(SIZE_REASONS).map((k) => `"${k}"`).join("|")}, detail: string}`

export function sizeReasonError(r: unknown): string | null {
	if (r === undefined) return null
	const ok = typeof r === "object" && r !== null && (r as SizeReason).kind in SIZE_REASONS && typeof (r as SizeReason).detail === "string" && (r as SizeReason).detail.trim().length > 0
	return ok ? null : `${SIZE_REASON_SHAPE}: a reason from the list, and what it is in this design`
}

// Design facts: where the design stands against the space rules.
const failedNote = (min: MinimumBoard) => {
	const f = min.failed ?? []
	if (!f.length) return ""
	const one = f.length === 1
	return `, and outside ${f.map((x) => `${x.widthMm}×${x.heightMm}`).join(", ")} mm, which ${one ? "was" : "were"} built and failed to route (measured: don't shrink back into ${one ? "it" : "them"})`
}

export function spaceFactLines(s: ContractSnapshot): string[] {
	const o = s.values.outline
	const min = o ? minimumBoard(s) : null
	if (!o || !min) return []
	const slack = (o.widthMm * o.heightMm) / min.areaMm2 - 1
	const lines = [
		`Board: ${o.widthMm}×${o.heightMm} mm = ${o.widthMm * o.heightMm} mm²; the smallest it can be is ${min.areaMm2} mm² (${min.limitedBy === "placement" ? `every part placed at ${min.widthMm}×${min.heightMm} mm` : `courtyards ${min.courtyardMm2} mm² at the ${pct(MAX_DENSITY)} routing ceiling`}${failedNote(min)}); slack ${pct(slack)}, limit ${pct(SLACK_LIMIT)}${o.sizeReason ? `, over it for a recorded reason: ${o.sizeReason.kind} (${o.sizeReason.detail})` : ""}.`,
	]
	const c = caseOf(s)
	const need = minCaseHeight(s, c)
	if (need > 0) lines.push(`Case body: ${c.heightMm} mm tall; its contents need ${need} mm; slack ${pct(c.heightMm / need - 1)}, limit ${pct(SLACK_LIMIT)}${s.values.case?.sizeReason ? `, reason: ${s.values.case.sizeReason.kind} (${s.values.case.sizeReason.detail})` : ""}.`)
	const a = antennaOverhang(s)
	if (a) lines.push(`Antenna: the ESP32-C3 module sits at the ${a.edge} edge, opposite the USB-C port, its PCB antenna ${a.overhangMm} mm past the board edge (Espressif's preferred placement); the case leaves it 2 mm and the test fixture a notch. Espressif also recommends 15 mm of clearance around the antenna inside the housing, which the case does not give: more room there would be a "function" reason.`)
	lines.push(`Space rules: compact by default; more than ${pct(SLACK_LIMIT)} over the minimum needs sizeReason, one of: ${Object.entries(SIZE_REASONS).map(([k, d]) => `${k} (${d})`).join("; ")}. Priority when rules conflict: safety and manufacturability, the engineer's own words, function, usability, compactness, cost.`)
	return lines
}
