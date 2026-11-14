// Moving parts on the board page (engineer, 13 Nov 2026: step 3, "code checks per move, AI only at the end of editing";
// 14 Nov, the robot direction: "modify each part individually in bringup but keep it aware of rest of the system so it
// is plug and play"). Every move is checked here in plain code, in milliseconds, against the same consistency checks the
// run uses, and says what else it moves: on the board, in the case, across the system's cables. Nothing is sent until
// the engineer sends the batch; then it is one change request through requests.jsonl, so the owners write it and the
// run's checks and review see it once.
import { connectorBoxes, footprintFor, layoutBoard, MODULE_FOOTPRINT, supportParts } from "../codegen/circuit.ts"
import { checkConsistency, type Violation } from "../contract/consistency.ts"
import { enclosureMode, type Connector, type ContractSnapshot } from "../contract/types.ts"
import { changedRefs, previewCircuit } from "./board-view.ts"

type Edge = Connector["edge"]
export type Move = { ref: string; xMm: number; yMm: number } | { ref: string; edge: Edge; offsetMm: number }
const isConnectorMove = (m: Move): m is { ref: string; edge: Edge; offsetMm: number } => "edge" in m

// What can move and where it is now: a part by its centre (mm from the board's bottom-left corner, top view), a connector
// by its edge and its offset along it (and each edge's length, for the page's slider).
export type Movable = { ref: string; kind: "part"; xMm: number; yMm: number } | { ref: string; kind: "connector"; edge: Edge; offsetMm: number; edges: Record<Edge, number> }

export interface MoveCheck {
	// No problem the moves would add: the batch can be sent.
	ok: boolean
	// What the moves would add: a check the design passed before and fails after, or a move that can't be made. system:
	// it concerns a cable to another board (the system's, not this board's alone).
	problems: { kind: string; message: string; system: boolean }[]
	// Each move, from and to, how far it reaches (board: re-routed only; case: the case follows; system: another board's
	// cable plugs in here) and what follows it, in words.
	moves: { ref: string; from: string; to: string; scope: "board" | "case" | "system"; effects: string[] }[]
	// Parts the layout moves because of them (the regulator follows the USB-C connector, a passive its part).
	alsoMoved: string[]
	// The board as it would be (the board page's preview elements).
	preview: unknown[]
	// The change request that sends the batch.
	request: string
}

const r1 = (n: number) => Math.round(n * 10) / 10
const fmtXY = (x: number, y: number) => `(${r1(x)}, ${r1(y)}) mm`

export function movables(s: ContractSnapshot): { movable: Record<string, Movable>; fixed: Record<string, string> } {
	const movable: Record<string, Movable> = {}
	const fixed: Record<string, string> = {}
	const o = s.values.outline
	if (!o) return { movable, fixed }
	const [W, H] = [o.widthMm, o.heightMm]
	const connectors = s.values.connectors ?? []
	for (const c of connectors) movable[c.ref] = { ref: c.ref, kind: "connector", edge: c.edge, offsetMm: c.offsetMm, edges: { left: H, right: H, top: W, bottom: W } }
	let boxes = new Map<string, { x: number; y: number }>()
	try {
		boxes = new Map(layoutBoard(s).parts.map((b) => [b.ref, b]))
	} catch {
		// No layout yet (no parts): nothing but the connectors to move.
	}
	for (const p of s.values.parts ?? []) {
		if (movable[p.ref]) continue
		if (footprintFor(p) === MODULE_FOOTPRINT) {
			fixed[p.ref] = "The radio module sits at the edge opposite the USB-C connector, its antenna past the board's edge (the module's datasheet keeps copper away from it). Move the USB-C connector to another edge to move it."
			continue
		}
		const b = boxes.get(p.ref)
		if (p.at) movable[p.ref] = { ref: p.ref, kind: "part", xMm: p.at.xMm, yMm: p.at.yMm }
		else if (b) movable[p.ref] = { ref: p.ref, kind: "part", xMm: r1(b.x + W / 2), yMm: r1(b.y + H / 2) }
		else fixed[p.ref] = "It has no spot on the board yet: the board is too small for everything it carries."
	}
	return { movable, fixed }
}

// The design with the moves made: a part keeps the spot (Part.at), a connector takes its edge and offset.
export function applyMoves(s: ContractSnapshot, moves: Move[]): ContractSnapshot {
	const next = structuredClone(s)
	for (const m of moves) {
		if (isConnectorMove(m)) next.values.connectors = (next.values.connectors ?? []).map((c) => (c.ref === m.ref ? { ...c, edge: m.edge, offsetMm: r1(m.offsetMm) } : c))
		else next.values.parts = (next.values.parts ?? []).map((p) => (p.ref === m.ref ? { ...p, at: { xMm: r1(m.xMm), yMm: r1(m.yMm) } } : p))
	}
	return next
}

// The one sentence that sends the batch. The scripted agents read it back with parseMoves; a model reads it as words.
export function moveRequest(s: ContractSnapshot, moves: Move[]): string {
	const { movable } = movables(s)
	const items = moves.map((m) => {
		const was = movable[m.ref]
		if (isConnectorMove(m)) return `${m.ref} ${was && was.kind === "connector" ? `${was.edge}@${was.offsetMm}` : "?"} → ${m.edge}@${r1(m.offsetMm)} mm`
		return `${m.ref} ${was && was.kind === "part" ? `(${was.xMm}, ${was.yMm})` : "(?)"} → (${r1(m.xMm)}, ${r1(m.yMm)}) mm`
	})
	return `placed on the board page (a part's centre in mm from the board's bottom-left corner, top view, kept as its parts[].at; a connector as edge@offset): ${items.join("; ")}`
}

export function parseMoves(text: string): Move[] {
	if (!/placed on the board page/.test(text)) return []
	const out: Move[] = []
	for (const item of text.slice(text.indexOf("):") + 2).split(";")) {
		const c = /(\w+) \S+ → (left|right|top|bottom)@(-?[\d.]+) mm/.exec(item)
		if (c) {
			out.push({ ref: c[1], edge: c[2] as Edge, offsetMm: Number(c[3]) })
			continue
		}
		const p = /(\w+) \([^)]*\) → \((-?[\d.]+), (-?[\d.]+)\) mm/.exec(item)
		if (p) out.push({ ref: p[1], xMm: Number(p[2]), yMm: Number(p[3]) })
	}
	return out
}

// The design's own violations, before any move: the same for every check of one revision, so kept for the last few.
const beforeCache = new Map<string, Set<string>>()
function beforeKeys(s: ContractSnapshot, brief: string, key: (v: Violation) => string): Set<string> {
	const k = JSON.stringify(s.values) + brief
	const hit = beforeCache.get(k)
	if (hit) return hit
	const keys = new Set(checkConsistency(s, {}, brief, { quick: true }).map(key))
	if (beforeCache.size >= 8) beforeCache.delete(beforeCache.keys().next().value!)
	beforeCache.set(k, keys)
	return keys
}

export function checkMoves(s: ContractSnapshot, moves: Move[], brief = ""): MoveCheck {
	const { movable, fixed } = movables(s)
	const o = s.values.outline
	const problems: MoveCheck["problems"] = []
	const valid: Move[] = []
	for (const m of moves) {
		const was = movable[m.ref]
		if (!was) {
			problems.push({ kind: "not-movable", message: `${m.ref} can't be moved here. ${fixed[m.ref] ?? "It is placed by Bringup beside the part it serves, and moves with it."}`, system: false })
			continue
		}
		if (isConnectorMove(m) !== (was.kind === "connector")) {
			problems.push({ kind: "not-movable", message: `${m.ref} is ${was.kind === "connector" ? "a connector: it moves along the board's edges" : "a part: it moves to a spot on the board, not onto an edge"}`, system: false })
			continue
		}
		if (isConnectorMove(m) && was.kind === "connector") {
			const k = s.values.connectors!.find((c) => c.ref === m.ref)!
			const len = was.edges[m.edge]
			if (!(m.offsetMm >= k.widthMm / 2 && m.offsetMm <= len - k.widthMm / 2)) {
				problems.push({ kind: "connector-off-edge", message: `${m.ref} is ${k.widthMm} mm wide: on the ${len} mm ${m.edge} edge its centre goes from ${k.widthMm / 2} to ${len - k.widthMm / 2} mm, not ${r1(m.offsetMm)} mm`, system: false })
				continue
			}
		}
		if (!isConnectorMove(m) && o && !(m.xMm >= 0 && m.xMm <= o.widthMm && m.yMm >= 0 && m.yMm <= o.heightMm)) {
			problems.push({ kind: "part-off-board", message: `${fmtXY(m.xMm, m.yMm)} is off the ${o.widthMm}×${o.heightMm} mm board`, system: false })
			continue
		}
		valid.push(m)
	}
	const after = applyMoves(s, valid)
	// What the moves add: a check that passed before and fails after. Compared by kind and message, so a violation the
	// design already had isn't blamed on the move.
	const key = (v: Violation) => `${v.kind}|${v.message}`
	const before = beforeKeys(s, brief, key)
	// A part that doesn't fit where it was put is told to the engineer in their terms (the check's own message is for the
	// parts agent).
	const blockedWhy = new Map((() => {
		try {
			return layoutBoard(after).blocked.map((b) => [b.ref, b.why] as const)
		} catch {
			return []
		}
	})())
	for (const v of checkConsistency(after, {}, brief, { quick: true })) {
		if (before.has(key(v))) continue
		if (v.kind === "part-pinned-blocked") {
			for (const [ref, why] of blockedWhy) {
				const m = valid.find((x) => x.ref === ref) as { xMm: number; yMm: number } | undefined
				if (m) problems.push({ kind: v.kind, message: `${ref} doesn't fit at ${fmtXY(m.xMm, m.yMm)}: ${why}.`, system: false })
			}
			continue
		}
		problems.push({ kind: v.kind, message: v.message, system: v.kind.startsWith("link-") || v.fields.includes("links") })
	}

	const caseCut = enclosureMode(s.values) === "case"
	const links = s.values.links ?? []
	const supports = (() => {
		try {
			return supportParts(s)
		} catch {
			return []
		}
	})()
	const boxesAfter = (() => {
		try {
			return new Map(layoutBoard(after).parts.map((b) => [b.ref, b]))
		} catch {
			return new Map<string, { x: number; y: number }>()
		}
	})()
	const report = valid.map((m): MoveCheck["moves"][number] => {
		const was = movable[m.ref]!
		const effects: string[] = []
		let scope: "board" | "case" | "system" = "board"
		if (isConnectorMove(m) && was.kind === "connector") {
			const k = s.values.connectors!.find((c) => c.ref === m.ref)!
			if (caseCut) {
				effects.push(`the case's opening for it moves with it (the case designer re-cuts it)`)
				scope = "case"
			}
			if (k.kind === "usb-c" && m.edge !== was.edge) effects.push("the board is laid out from the USB-C edge: the regulator and the LEDs follow it, and the radio module goes to the opposite edge")
			const link = links.find((l) => l.connector === m.ref)
			if (link) {
				scope = "system"
				effects.push(`${link.id}'s cable to ${link.peer} plugs in here${link.edge ? `: the system runs it out of the ${link.edge} edge` : ""}`)
			}
			return { ref: m.ref, from: `${was.edge}@${was.offsetMm} mm`, to: `${m.edge}@${r1(m.offsetMm)} mm`, scope, effects }
		}
		const part = s.values.parts!.find((p) => p.ref === m.ref)!
		const p = m as { xMm: number; yMm: number }
		effects.push("kept at this spot: the layout places everything else around it")
		if (caseCut && part.role === "sensor") {
			effects.push("the case's vent moves over it (the case is rebuilt)")
			scope = "case"
		}
		if (caseCut && part.role === "microphone") {
			effects.push("the case's sound port moves under it (the case is rebuilt)")
			scope = "case"
		}
		const sp = supports.find((x) => x.ref === m.ref)
		const near = sp && o ? boxesAfter.get(sp.near) : undefined
		if (sp && near && o) {
			const d = Math.hypot(p.xMm - (near.x + o.widthMm / 2), p.yMm - (near.y + o.heightMm / 2))
			effects.push(`it serves ${sp.job}: the layout puts it beside ${sp.near}; here it is ${r1(d)} mm from ${sp.near}'s centre, so its trace is longer`)
		}
		return { ref: m.ref, from: was.kind === "part" ? fmtXY(was.xMm, was.yMm) : "?", to: fmtXY(p.xMm, p.yMm), scope, effects }
	})
	const moved = new Set(valid.map((m) => m.ref))
	let alsoMoved: string[] = []
	let preview: unknown[] = []
	try {
		alsoMoved = changedRefs(s, after).changed.filter((r) => !moved.has(r) && !connectorBoxes(after, o?.widthMm ?? 0, o?.heightMm ?? 0).some((b) => b.ref === r && moved.has(b.ref)))
		preview = previewCircuit(after)
	} catch {
		// A layout that fails outright: the problems above say why.
	}
	return { ok: problems.length === 0 && valid.length > 0, problems, moves: report, alsoMoved, preview, request: moveRequest(s, valid) }
}
