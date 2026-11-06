import { isDeepStrictEqual } from "node:util"
import { sizeReasonError } from "./space.ts"
import type { AgentRole, CaseFeature, CaseSpec, ContractSnapshot, ContractValues, FieldName } from "./types.ts"

// The case's fixed geometry, shared by the checks, the stub and py/enclosure.py (which gets a copy in its spec).
// Frozen: a test that edited a spec's lid once changed LID itself for every later build in the process.
// Board mounting: M2 self-tapping screws (ISO 7049 / PT style) straight into a 1.6 mm pilot hole in a 5 mm post.
// No inserts and no soldering iron; PLA and PETG hold a few re-assemblies, which is what a prototype needs.
export const STANDOFF = Object.freeze({ heightMm: 3, outerMm: 5, pilotMm: 1.6 })
// Lid: a flat plate with a lip that drops 3 mm into the case, 0.2 mm clearance per side. It prints plate-down with
// no overhangs, and at 0.2 mm layers the first-layer squish takes up most of the gap, so it sits as a light press
// fit. A snap-fit was the alternative; its cantilevers are brittle in PLA and need tuning per printer.
export const LID = Object.freeze({ plateMm: 2, lipMm: 3, lipWallMm: 1.6, clearanceMm: 0.2 })
// Board edge to the inside of the wall, per side.
export const CASE_CLEARANCE_MM = 2
// Each way around a connector's own opening (py/enclosure.py SLOT_MARGIN_MM).
export const SLOT_MARGIN_MM = 0.5
// Three 0.4 mm perimeters (py/enclosure.py MIN_WALL_MM).
export const MIN_WALL_MM = 1.2
// Without a case field: what every case had before the field existed.
export const DEFAULT_CASE: Readonly<CaseSpec> = Object.freeze({ wallMm: 2, heightMm: 14, features: Object.freeze([]) as unknown as CaseSpec["features"] })
// Flat tabs, flush with the floor, so they print on the bed with no support. 3 mm of PLA/PETG holds a small device
// on a wall screw; 4.5 mm takes an M4 or a #8 wood screw; the lanyard hole takes a 3 mm cord or a split ring.
export const MOUNT_TAB = Object.freeze({ outMm: 10, alongMm: 14, thickMm: 3, holeMm: 4.5 })
export const LANYARD_TAB = Object.freeze({ outMm: 7, alongMm: 8, thickMm: 3, holeMm: 3.5 })
// Engraved lettering: 0.6 mm deep (three 0.2 mm layers) into the 2 mm lid plate; 3 mm letters are the smallest that
// print legibly with a 0.4 mm nozzle, 8 mm the largest the generator uses.
export const TEXT = Object.freeze({ depthMm: 0.6, minMm: 3, maxMm: 8 })
const WALL_RANGE = [MIN_WALL_MM, 4] as const
const HEIGHT_RANGE = [8, 40] as const
const HOLE_RANGE = [2, 16] as const
const TEXT_PATTERN = /^[A-Za-z0-9 .,:!?&+#/-]{1,24}$/
const EDGES = ["left", "right", "top", "bottom"] as const
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const

export const caseOf = (s: ContractSnapshot): CaseSpec => s.values.case ?? structuredClone(DEFAULT_CASE as CaseSpec)

// The case's outer footprint: the board plus clearance and a wall on each side.
export function caseOuter(outline: ContractValues["outline"], c: CaseSpec): { widthMm: number; heightMm: number } {
	const add = 2 * (CASE_CLEARANCE_MM + c.wallMm)
	return { widthMm: round(outline.widthMm + add), heightMm: round(outline.heightMm + add) }
}

// The board outline a case of this outer size holds (the inverse of caseOuter).
export function boardFor(outer: number, c: CaseSpec): number {
	return round(outer - 2 * (CASE_CLEARANCE_MM + c.wallMm))
}

const round = (x: number) => Math.round(x * 100) / 100

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown, [lo, hi]: readonly [number, number]) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi

export const CASE_SHAPE = `case must be {wallMm (${WALL_RANGE[0]}-${WALL_RANGE[1]}), heightMm (${HEIGHT_RANGE[0]}-${HEIGHT_RANGE[1]}), features: [feature]} plus an optional sizeReason {kind, detail} (space rules), with each feature one of {id, kind: "wall-mount", sides: "left-right"|"top-bottom"}, {id, kind: "lanyard", corner: "top-left"|"top-right"|"bottom-left"|"bottom-right"}, {id, kind: "text", text (1-24 letters, digits, spaces, .,:!?&+#/-)}, {id, kind: "hole", edge: "left"|"right"|"top"|"bottom", offsetMm, diameterMm (${HOLE_RANGE[0]}-${HOLE_RANGE[1]})}; ids unique; at most one wall-mount and one text`

function featureOk(f: unknown): f is CaseFeature {
	if (!obj(f) || typeof f.id !== "string" || f.id.length === 0) return false
	switch (f.kind) {
		case "wall-mount":
			return f.sides === "left-right" || f.sides === "top-bottom"
		case "lanyard":
			return CORNERS.includes(f.corner as never)
		case "text":
			return typeof f.text === "string" && TEXT_PATTERN.test(f.text) && f.text.trim().length > 0
		case "hole":
			return EDGES.includes(f.edge as never) && typeof f.offsetMm === "number" && Number.isFinite(f.offsetMm) && num(f.diameterMm, HOLE_RANGE)
		default:
			return false
	}
}

// The value's own shape; the checks below judge it against the board.
export function caseShapeError(value: unknown): string | null {
	if (!obj(value) || !num(value.wallMm, WALL_RANGE) || !num(value.heightMm, HEIGHT_RANGE) || !Array.isArray(value.features)) return CASE_SHAPE
	const reason = sizeReasonError(value.sizeReason)
	if (reason) return `${CASE_SHAPE}; ${reason}`
	const bad = value.features.filter((f) => !featureOk(f))
	if (bad.length > 0) return `${CASE_SHAPE}; not a feature: ${JSON.stringify(bad[0])}`
	const features = value.features as CaseFeature[]
	const ids = features.map((f) => f.id)
	if (new Set(ids).size !== ids.length) return `${CASE_SHAPE}; feature ids repeat`
	for (const kind of ["wall-mount", "text"] as const) if (features.filter((f) => f.kind === kind).length > 1) return `${CASE_SHAPE}; more than one ${kind}`
	return null
}

// ---- geometry, in the contract's frame (board's bottom-left corner at the origin) ---------------------------------

const edgeLength = (outline: ContractValues["outline"], edge: (typeof EDGES)[number]) => (edge === "left" || edge === "right" ? outline.heightMm : outline.widthMm)

// The height a connector's cutout reaches, from the floor's underside (py/enclosure.py slot_extent).
function cutoutTop(c: CaseSpec, outline: ContractValues["outline"], heightMm: number): number {
	return c.wallMm + STANDOFF.heightMm + outline.thicknessMm + heightMm + SLOT_MARGIN_MM
}

// The lowest body that clears every connector's cutout under the lid's lip.
// The lowest body that clears every connector's cutout under the lid's lip, and gives every wall hole its wall.
export function minCaseHeight(s: ContractSnapshot, c = caseOf(s)): number {
	const outline = s.values.outline
	if (!outline) return 0
	const tallest = Math.max(0, ...(s.values.connectors ?? []).map((k) => k.heightMm))
	const holes = c.features.map((f) => (f.kind === "hole" ? f.diameterMm + 1 + LID.lipMm + c.wallMm : 0))
	return round(Math.max(cutoutTop(c, outline, tallest) + LID.lipMm, ...holes))
}

// A wall hole's centre height: halfway up the wall's free height, between the floor and the lid's lip.
export function holeCentreZ(c: CaseSpec): number {
	return round((c.wallMm + c.heightMm - LID.lipMm) / 2)
}

// Where each tab sits along its wall, in the wall's own frame (0 at the bottom or left end of the case's outer face).
interface TabSpan {
	id: string
	tab: typeof MOUNT_TAB | typeof LANYARD_TAB
	wall: (typeof EDGES)[number]
	from: number
	to: number
}

function tabSpans(s: ContractSnapshot, c: CaseSpec): TabSpan[] {
	const outline = s.values.outline!
	const outer = caseOuter(outline, c)
	const out: TabSpan[] = []
	for (const f of c.features) {
		if (f.kind === "wall-mount") {
			const walls = f.sides === "left-right" ? (["left", "right"] as const) : (["top", "bottom"] as const)
			for (const wall of walls) {
				const len = wall === "left" || wall === "right" ? outer.heightMm : outer.widthMm
				out.push({ id: f.id, tab: MOUNT_TAB, wall, from: (len - MOUNT_TAB.alongMm) / 2, to: (len + MOUNT_TAB.alongMm) / 2 })
			}
		}
		if (f.kind === "lanyard") {
			const wall = f.corner.endsWith("left") ? "left" : "right"
			const len = outer.heightMm
			out.push({ id: f.id, tab: LANYARD_TAB, wall, ...(f.corner.startsWith("top") ? { from: len - LANYARD_TAB.alongMm, to: len } : { from: 0, to: LANYARD_TAB.alongMm }) })
		}
	}
	return out
}

// Where a tab or a lanyard loop sits: its hole's centre, in the contract's frame (the stub reports these).
export function tabHoles(s: ContractSnapshot, c = caseOf(s)): { id: string; xMm: number; yMm: number; diameterMm: number }[] {
	const outline = s.values.outline
	if (!outline) return []
	const side = CASE_CLEARANCE_MM + c.wallMm
	return tabSpans(s, c).map((t) => {
		const along = (t.from + t.to) / 2 - side
		const out = t.tab.outMm / 2
		const holeMm = t.tab.holeMm
		const xy =
			t.wall === "left" ? [-side - out, along] : t.wall === "right" ? [outline.widthMm + side + out, along] : t.wall === "bottom" ? [along, -side - out] : [along, outline.heightMm + side + out]
		return { id: t.id, xMm: round(xy[0]), yMm: round(xy[1]), diameterMm: holeMm }
	})
}

export type CaseViolationKind = "case-too-low" | "case-feature-collision" | "case-feature-missing"

export interface CaseViolation {
	kind: CaseViolationKind
	message: string
	fields: FieldName[]
	affects: AgentRole[]
}

// The case field against the board: the body tall enough for the connectors, each feature on its wall clear of the
// connectors' cutouts and the other features. Every one wakes the case designer, who owns the field; a fix that would
// need the board to change goes through change control and the engineer's confirmation (boardChangeWarning).
export function caseChecks(s: ContractSnapshot): CaseViolation[] {
	const c = s.values.case
	const outline = s.values.outline
	if (!c || !outline) return []
	const v: CaseViolation[] = []
	const push = (kind: CaseViolationKind, message: string) => v.push({ kind, message, fields: ["case"], affects: ["enclosure"] })
	const need = minCaseHeight(s, c)
	if (c.heightMm < need) push("case-too-low", `the case body is ${c.heightMm} mm tall, but the connectors' cutouts need ${need} mm (board on its standoffs, the tallest connector's opening, then the lid's ${LID.lipMm} mm lip)`)

	// Spans along each wall, in the connectors' frame: cutouts, then holes.
	const spans: { wall: (typeof EDGES)[number]; from: number; to: number; what: string }[] = []
	for (const k of s.values.connectors ?? []) spans.push({ wall: k.edge, from: k.offsetMm - k.widthMm / 2 - SLOT_MARGIN_MM, to: k.offsetMm + k.widthMm / 2 + SLOT_MARGIN_MM, what: `${k.ref}'s cutout` })
	const free = c.heightMm - LID.lipMm - c.wallMm
	for (const f of c.features) {
		if (f.kind !== "hole") continue
		const len = edgeLength(outline, f.edge)
		const from = f.offsetMm - f.diameterMm / 2
		const to = f.offsetMm + f.diameterMm / 2
		if (from < -CASE_CLEARANCE_MM + MIN_WALL_MM || to > len + CASE_CLEARANCE_MM - MIN_WALL_MM)
			push("case-feature-collision", `hole ${f.id} (${f.diameterMm} mm at ${f.offsetMm} mm) runs off the ${f.edge} wall, which is ${len} mm along the board plus ${CASE_CLEARANCE_MM} mm each end`)
		if (f.diameterMm > free - 1) push("case-feature-collision", `hole ${f.id} is ${f.diameterMm} mm across, but the ${f.edge} wall has ${round(free)} mm between the floor and the lid's lip (at most ${round(free - 1)} mm)`)
		for (const o of spans) if (o.wall === f.edge && from < o.to + MIN_WALL_MM && to > o.from - MIN_WALL_MM) push("case-feature-collision", `hole ${f.id} (${round(from)}-${round(to)} mm along the ${f.edge} wall) runs into ${o.what} (${round(o.from)}-${round(o.to)} mm); keep ${MIN_WALL_MM} mm of wall between them`)
		spans.push({ wall: f.edge, from, to, what: `hole ${f.id}` })
	}

	const tabs = tabSpans(s, c)
	const outer = caseOuter(outline, c)
	for (const t of tabs) {
		const len = t.wall === "left" || t.wall === "right" ? outer.heightMm : outer.widthMm
		if (t.from < 0 || t.to > len) push("case-feature-collision", `${t.id}'s tab is ${round(t.to - t.from)} mm along, longer than the ${len} mm ${t.wall} wall`)
	}
	for (let i = 0; i < tabs.length; i++)
		for (let j = i + 1; j < tabs.length; j++) {
			const [a, b] = [tabs[i], tabs[j]]
			if (a.id !== b.id && a.wall === b.wall && a.from < b.to + 1 && a.to > b.from - 1) push("case-feature-collision", `${a.id} and ${b.id} put tabs on the same stretch of the ${a.wall} wall`)
		}
	return v
}

// What the built case has for each feature (py/enclosure.py features.json, measured on the solid).
export interface BuiltFeature {
	id: string
	kind: CaseFeature["kind"]
	ok: boolean
	issue?: string
	xMm?: number
	yMm?: number
	zMm?: number
	diameterMm?: number
	// Lettering: its size as engraved.
	textMm?: number
	// A wall hole: its wall and offset along it, as measured.
	edge?: string
	offsetMm?: number
}

// The built case against the case field: each feature the field asks for is in the solid, as asked.
// Only while the case was built from the features the field has now: a rebuild that hasn't finished isn't a fault.
export function builtFeatureChecks(s: ContractSnapshot, enclosure: { features?: BuiltFeature[]; featuresAsked?: CaseFeature[] } | undefined): CaseViolation[] {
	const c = s.values.case
	const built = enclosure?.features
	if (!c || !built || !isDeepStrictEqual(enclosure.featuresAsked ?? [], c.features)) return []
	const v: CaseViolation[] = []
	for (const f of c.features) {
		const b = built.find((x) => x.id === f.id)
		if (!b) v.push({ kind: "case-feature-missing", message: `the built case has no ${f.kind} ${f.id}`, fields: ["case"], affects: ["enclosure"] })
		else if (!b.ok) v.push({ kind: "case-feature-missing", message: `${f.kind} ${f.id} could not be built: ${b.issue ?? "no reason given"}`, fields: ["case"], affects: ["enclosure"] })
	}
	return v
}

// ---- the case changing the board ----------------------------------------------------------------------------------

// The fields the board is built from (agents/builders.ts BUILD_INPUTS.board; test/case.test.ts holds them equal).
export const BOARD_FIELDS: readonly FieldName[] = ["parts", "pins", "outline", "connectors", "test"]

// A change the case designer asks for that would change the PCB: the engineer is warned and must confirm it, on top
// of the field owner's approval (change-control.ts). null when the change leaves the board alone.
export function boardChangeWarning(requester: AgentRole, field: FieldName, before: unknown, after: unknown): string | null {
	if (requester !== "enclosure" || !BOARD_FIELDS.includes(field)) return null
	let what = `its ${field}`
	if (field === "outline" && obj(before) && obj(after)) what = `the board outline ${before.widthMm}×${before.heightMm} → ${after.widthMm}×${after.heightMm} mm`
	if (field === "connectors" && Array.isArray(before) && Array.isArray(after)) {
		const moved = (after as ContractValues["connectors"]).filter((a) => {
			const b = (before as ContractValues["connectors"]).find((x) => x.ref === a.ref)
			return !b || b.edge !== a.edge || b.offsetMm !== a.offsetMm
		})
		if (moved.length > 0) what = moved.map((m) => `${m.ref} to ${m.edge}@${m.offsetMm} mm`).join(", ")
	}
	return `This case change changes the PCB: ${what}. The board is placed and routed again, and what follows it (firmware, test kit) rebuilds. It goes ahead only if you confirm.`
}

// Design facts for the agents: the case as it stands, and what bounds it.
export function caseFactLines(s: ContractSnapshot): string[] {
	const outline = s.values.outline
	if (!outline) return []
	const c = caseOf(s)
	const outer = caseOuter(outline, c)
	const features = c.features.length > 0 ? c.features.map((f) => `${f.id} (${f.kind}${f.kind === "hole" ? ` ${f.diameterMm} mm, ${f.edge}@${f.offsetMm} mm` : f.kind === "text" ? ` "${f.text}"` : f.kind === "lanyard" ? ` ${f.corner}` : ` ${f.sides}`})`).join(", ") : "none"
	return [
		`Case${s.values.case ? "" : " (defaults, no case field yet)"}: outer ${outer.widthMm}×${outer.heightMm}×${c.heightMm} mm plus a ${LID.plateMm} mm lid; walls ${c.wallMm} mm; ${CASE_CLEARANCE_MM} mm clearance around the board, so outer = board + ${round(2 * (CASE_CLEARANCE_MM + c.wallMm))} mm each way.`,
		`Case features: ${features}. The lowest body the connectors allow: ${minCaseHeight(s, c)} mm. A wall hole's centre sits ${holeCentreZ(c)} mm up; its diameter can be at most ${round(c.heightMm - LID.lipMm - c.wallMm - 1)} mm.`,
	]
}
