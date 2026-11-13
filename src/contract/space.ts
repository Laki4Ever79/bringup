import { antennaOverhang, boardParts, debugPort, layoutBoard, placeParts, recoveryPads, testPoints } from "../codegen/circuit.ts"
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
}

// The design with the outline set to w x h, connectors kept at the same relative place along their edges.
function resized(s: ContractSnapshot, w: number, h: number): ContractSnapshot {
	const o = s.values.outline!
	const connectors = (s.values.connectors ?? []).map((c) => {
		const along = c.edge === "left" || c.edge === "right" ? [o.heightMm, h] : [o.widthMm, w]
		return { ...c, offsetMm: Math.round(((c.offsetMm * along[1]) / along[0]) * 2) / 2 }
	})
	return { ...s, values: { ...s.values, outline: { ...o, widthMm: w, heightMm: h }, connectors } }
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
	const key = JSON.stringify({ parts, connectors, pins, rails, t: o.thicknessMm, aspect: [o.widthMm, o.heightMm] })
	if (cache.has(key)) return cache.get(key)!
	const fits = (w: number, h: number) => placesAll(s, w, h)
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
			? { widthMm: best.w, heightMm: best.h, areaMm2: packed, courtyardMm2, limitedBy: "placement", shapes }
			: { widthMm: best.w, heightMm: best.h, areaMm2: Math.round(floorArea), courtyardMm2, limitedBy: "density", shapes }
	cache.set(key, result)
	return result
}

// The compact board closest to the current proportions: of the shapes that place every part within the limit, the
// one whose width-to-height ratio is nearest. The rule judges area; this keeps a 50×30 board from becoming a strip.
export function compactOutline(s: ContractSnapshot): { widthMm: number; heightMm: number } | null {
	const o = s.values.outline
	const min = o ? minimumBoard(s) : null
	if (!o || !min) return null
	const ratio = Math.log(o.widthMm / o.heightMm)
	const ok = min.shapes.filter((x) => x.widthMm * x.heightMm <= min.areaMm2 * (1 + SLACK_LIMIT) && x.widthMm * x.heightMm >= min.areaMm2)
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

export function spaceChecks(s: ContractSnapshot): SpaceViolation[] {
	const v: SpaceViolation[] = []
	if (!complete(s)) return v
	const o = s.values.outline
	const min = o ? minimumBoard(s) : null
	// Too small for what it carries: a part with no spot, or a pad the board must have. Caught here, in plain code, not
	// only when a board build fails (a --no-hardware run never builds one).
	if (o && !placesAll(s, o.widthMm, o.heightMm)) {
		const parts = unplacedParts(s)
		const pads = [...recoveryPads(s).unplaced.map((n) => `recovery pad ${n}`), ...testPoints(s).unplaced.map((n) => `test pad ${n}`)]
		v.push({
			kind: "space-room",
			message: `the ${o.widthMm}×${o.heightMm} mm board has no spot for ${[...parts, ...pads].join(", ") || "everything it carries"}${min ? `: the smallest board that holds everything is ${min.areaMm2} mm², e.g. ${min.widthMm}×${min.heightMm} mm` : ""}; make it that size, or move what crowds it`,
			fields: ["outline"],
			affects: ["architect"],
		})
		return v
	}
	if (o && min) {
		const slack = (o.widthMm * o.heightMm) / min.areaMm2 - 1
		const limit = !sizeReasonHolds(s, o.sizeReason) && o.sizeReason?.kind === "engineer-size"
		if (slack > SLACK_LIMIT && !sizeReasonHolds(s, o.sizeReason))
			v.push({
				kind: "space-slack",
				message: `the board is ${o.widthMm}×${o.heightMm} mm (${o.widthMm * o.heightMm} mm²), ${pct(slack)} over the smallest it can be (${min.areaMm2} mm², e.g. ${min.widthMm}×${min.heightMm} mm by placement): shrink it to within ${pct(SLACK_LIMIT)}, or record why in outline.sizeReason${limit ? `. The engineer's size (${o.sizeReason!.detail}) is a limit, not a reason for extra room: a board within it and compact meets it. Only an exact size (an existing housing, a chassis: requirements.size exact true) keeps it` : ""}`,
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
// U1.GPIO9"), the placer finding no free spot for a part (tools/board.ts), and the router tangling a junction (the
// STM32 logger at 38×22 mm, 13 Nov: "cannot select a unique PCB port"; 38×21 routes): the same answer, more room.
export const ROUTING_FAILURE = /missing a trace|could not (?:be )?route|failed to route|no route|no room on the board|via hole at .* overlaps|cannot select a unique PCB port/i

export const SIZE_REASON_SHAPE = `sizeReason (optional): {kind: ${Object.keys(SIZE_REASONS).map((k) => `"${k}"`).join("|")}, detail: string}`

export function sizeReasonError(r: unknown): string | null {
	if (r === undefined) return null
	const ok = typeof r === "object" && r !== null && (r as SizeReason).kind in SIZE_REASONS && typeof (r as SizeReason).detail === "string" && (r as SizeReason).detail.trim().length > 0
	return ok ? null : `${SIZE_REASON_SHAPE}: a reason from the list, and what it is in this design`
}

// Design facts: where the design stands against the space rules.
export function spaceFactLines(s: ContractSnapshot): string[] {
	const o = s.values.outline
	const min = o ? minimumBoard(s) : null
	if (!o || !min) return []
	const slack = (o.widthMm * o.heightMm) / min.areaMm2 - 1
	const lines = [
		`Board: ${o.widthMm}×${o.heightMm} mm = ${o.widthMm * o.heightMm} mm²; the smallest it can be is ${min.areaMm2} mm² (${min.limitedBy === "placement" ? `every part placed at ${min.widthMm}×${min.heightMm} mm` : `courtyards ${min.courtyardMm2} mm² at the ${pct(MAX_DENSITY)} routing ceiling`}); slack ${pct(slack)}, limit ${pct(SLACK_LIMIT)}${o.sizeReason ? `, over it for a recorded reason: ${o.sizeReason.kind} (${o.sizeReason.detail})` : ""}.`,
	]
	const c = caseOf(s)
	const need = minCaseHeight(s, c)
	if (need > 0) lines.push(`Case body: ${c.heightMm} mm tall; its contents need ${need} mm; slack ${pct(c.heightMm / need - 1)}, limit ${pct(SLACK_LIMIT)}${s.values.case?.sizeReason ? `, reason: ${s.values.case.sizeReason.kind} (${s.values.case.sizeReason.detail})` : ""}.`)
	const a = antennaOverhang(s)
	if (a) lines.push(`Antenna: the ESP32-C3 module sits at the ${a.edge} edge, opposite the USB-C port, its PCB antenna ${a.overhangMm} mm past the board edge (Espressif's preferred placement); the case leaves it 2 mm and the test fixture a notch. Espressif also recommends 15 mm of clearance around the antenna inside the housing, which the case does not give: more room there would be a "function" reason.`)
	lines.push(`Space rules: compact by default; more than ${pct(SLACK_LIMIT)} over the minimum needs sizeReason, one of: ${Object.entries(SIZE_REASONS).map(([k, d]) => `${k} (${d})`).join("; ")}. Priority when rules conflict: safety and manufacturability, the engineer's own words, function, usability, compactness, cost.`)
	return lines
}
