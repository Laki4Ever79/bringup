// The board page's data (engineer, 13 Nov 2026: a board view of its own, "the window is too small still and users
// can't precisely select the components on it or sometimes even see the entire board"; and watching the design change
// "realtime on the PCB itself"). For one revision of a run: the placement straight from the contract (plain code, well
// under a second, so the page shows every change at once), the routed board when that revision has been built (about
// 50 s later), every part's reason (src/contract/reasons.ts) and what changed since the revision before.
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { sensorDriver } from "../codegen/firmware.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import { swapEffects, swapRequest } from "../tools/sourcing.ts"
import { bringupPads, debugPort, layoutBoard, recoveryPads, TC2030, TEST_PAD, testPoints } from "../codegen/circuit.ts"
import { partReasons, type PartReason } from "../contract/reasons.ts"
import type { ContractSnapshot } from "../contract/types.ts"

export interface BoardView {
	revision: number
	revisions: number[]
	widthMm: number | null
	heightMm: number | null
	// tscircuit-shaped elements (pcb_board, components, pads) for pcb-view.js, from placement alone: no traces.
	preview: unknown[]
	// The routed board's circuit.json, relative to the run folder, when this revision was built; else null.
	routed: string | null
	// The newest revision at or before this one that was built, when this one wasn't.
	routedRevision: number | null
	reasons: PartReason[]
	// Since the revision before: parts added, removed, moved or swapped (changed), and of those, swapped for another part
	// number (swapped).
	changed: { added: string[]; removed: string[]; changed: string[]; swapped: string[] }
	// What each chosen part could be swapped for (swapOptions); a part with no option isn't listed.
	swaps: Record<string, SwapOption[]>
	summary: string
}

// A catalog part that could take a chosen part's place: what switching would change (swapEffects), its stock and price
// when the run's bom.json looked them up (null: not checked), and the change request the card sends.
export interface SwapOption {
	mpn: string
	lcsc: string | null
	changes: string[]
	stock: number | null
	priceUsd: number | null
	inStock: boolean | null
	request: string
}

// The roles a card offers no swap for. The microcontroller changes the pins, the firmware and its toolchain: a change
// request in words ("use an STM32G031"), not a pick from a list. A resistor's or capacitor's value comes from a
// datasheet or a rule (the card shows which); another catalog value would break it without saying so.
const NO_SWAP = new Set(["mcu", "resistor", "capacitor"])

const catalog = loadCatalog(resolve(import.meta.dirname, "../.."))

type BomLike = { items?: { ref: string; alternatives?: { mpn: string; stock: number | null; priceUsd: number | null; inStock: boolean | null }[] }[] }

export function swapOptions(s: ContractSnapshot, bom?: BomLike | null): Record<string, SwapOption[]> {
	const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase()
	const out: Record<string, SwapOption[]> = {}
	for (const p of s.values.parts ?? []) {
		if (NO_SWAP.has(p.role)) continue
		const own = catalog.find((c) => same(c.mpn, p.mpn))
		const live = bom?.items?.find((i) => i.ref === p.ref)?.alternatives ?? []
		const options = catalog
			.filter((c) => c.role === p.role && !same(c.mpn, p.mpn))
			.map((c) => {
				const l = live.find((a) => same(a.mpn, c.mpn))
				return { mpn: c.mpn, lcsc: c.lcsc ?? null, changes: swapEffects({ ...p, ...own }, c, sensorDriver), stock: l?.stock ?? null, priceUsd: l?.priceUsd ?? null, inStock: l?.inStock ?? null, request: swapRequest(p, { mpn: c.mpn, lcsc: c.lcsc ?? null }) }
			})
		if (options.length > 0) out[p.ref] = options
	}
	return out
}

// Elements pcb-view.js reads (circuitIndex): the board, a box per placed part, the bottom pads and the debug
// footprint's six pads, with each pad's net so the tooltip names it.
export function previewCircuit(s: ContractSnapshot): unknown[] {
	const o = s.values.outline
	if (!o) return []
	const els: Record<string, unknown>[] = [{ type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: o.widthMm, height: o.heightMm, num_layers: 2, thickness: 1.6 }]
	const comp = (ref: string, layer: "top" | "bottom", x: number, y: number, w: number, h: number) => {
		els.push({ type: "source_component", source_component_id: `sc_${ref}`, name: ref })
		els.push({ type: "pcb_component", pcb_component_id: `pc_${ref}`, source_component_id: `sc_${ref}`, center: { x, y }, width: w, height: h, rotation: 0, layer })
	}
	let n = 0
	const pad = (ref: string, net: string | null, x: number, y: number, d: number) => {
		const id = `p${n++}`
		els.push({ type: "source_port", source_port_id: `sp_${id}`, source_component_id: `sc_${ref}`, name: id })
		els.push({ type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, pcb_component_id: `pc_${ref}`, x, y })
		els.push({ type: "pcb_smtpad", pcb_smtpad_id: id, pcb_component_id: `pc_${ref}`, pcb_port_id: `pp_${id}`, shape: "circle", radius: d / 2, x, y, layer: "bottom" })
		if (net) {
			if (!els.some((e) => e.type === "source_net" && e.name === net)) els.push({ type: "source_net", source_net_id: `net_${net}`, name: net })
			els.push({ type: "source_trace", source_trace_id: `st_${id}`, connected_source_port_ids: [`sp_${id}`], connected_source_net_ids: [`net_${net}`] })
		}
	}
	const { parts } = layoutBoard(s)
	for (const b of parts) comp(b.ref, "top", b.x, b.y, b.w, b.h)
	for (const p of [...testPoints(s).placed, ...recoveryPads(s).placed, ...bringupPads(s).placed]) {
		comp(p.ref, "bottom", p.x, p.y, TEST_PAD.diameterMm, TEST_PAD.diameterMm)
		pad(p.ref, p.net, p.x, p.y, TEST_PAD.diameterMm)
	}
	const dp = debugPort(s).placed
	if (dp) {
		comp(dp.ref, "bottom", dp.x, dp.y, 4, 2)
		for (const p of dp.pads) pad(dp.ref, p.end && "net" in p.end ? p.end.net : null, p.x, p.y, TC2030.padDiameterMm)
	}
	return els
}

export function changedRefs(prev: ContractSnapshot | null, next: ContractSnapshot): BoardView["changed"] {
	if (!prev) return { added: [], removed: [], changed: [], swapped: [] }
	const boxes = (s: ContractSnapshot) => {
		try {
			return new Map(s.values.outline ? layoutBoard(s).parts.map((b) => [b.ref, b]) : [])
		} catch {
			return new Map()
		}
	}
	const [a, b] = [boxes(prev), boxes(next)]
	const mpn = (s: ContractSnapshot) => new Map((s.values.parts ?? []).map((p) => [p.ref, p.mpn]))
	const [ma, mb] = [mpn(prev), mpn(next)]
	const refs = new Set([...a.keys(), ...b.keys(), ...ma.keys(), ...mb.keys()])
	const added: string[] = [], removed: string[] = [], changed: string[] = [], swapped: string[] = []
	for (const r of refs) {
		const was = a.has(r) || ma.has(r), is = b.has(r) || mb.has(r)
		if (!was && is) added.push(r)
		else if (was && !is) removed.push(r)
		else if (ma.has(r) && mb.has(r) && ma.get(r) !== mb.get(r)) {
			changed.push(r)
			swapped.push(r)
		}
		else if (ma.get(r) !== mb.get(r) || (a.get(r) && b.get(r) && (a.get(r).x !== b.get(r).x || a.get(r).y !== b.get(r).y || a.get(r).rotation !== b.get(r).rotation))) changed.push(r)
	}
	const sort = (x: string[]) => x.sort((p, q) => p.localeCompare(q, "en", { numeric: true }))
	return { added: sort(added), removed: sort(removed), changed: sort(changed), swapped: sort(swapped) }
}

async function revisionsOf(dir: string): Promise<number[]> {
	const names = await readdir(join(dir, "contracts")).catch(() => [] as string[])
	return names.map((n) => /^rev-(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b)
}

async function snapshot(dir: string, rev: number | null): Promise<ContractSnapshot | null> {
	const file = rev === null ? join(dir, "contract.json") : join(dir, "contracts", `rev-${rev}.json`)
	return readFile(file, "utf8").then((t) => JSON.parse(t) as ContractSnapshot, () => null)
}

// The routed board of a revision, if it was built: where the run keeps it (board/rev-N, the newest also in board/).
function routedOf(dir: string, rev: number, latest: boolean): string | null {
	const tries = [`board/rev-${rev}/dist/board/circuit.json`, `board/rev-${rev}/circuit.json`, ...(latest ? ["board/circuit.json"] : [])]
	return tries.find((t) => existsSync(join(dir, t))) ?? null
}

export async function boardView(dir: string, wanted: number | null): Promise<BoardView | null> {
	const revisions = await revisionsOf(dir)
	const revision = wanted !== null && revisions.includes(wanted) ? wanted : (revisions.at(-1) ?? null)
	const s = await snapshot(dir, revision) ?? (await snapshot(dir, null))
	if (!s) return null
	const prevRev = revision === null ? null : [...revisions].reverse().find((r) => r < revision) ?? null
	const prev = prevRev === null ? null : await snapshot(dir, prevRev)
	const brief = await readFile(join(dir, "brief.md"), "utf8").catch(() => "")
	const bom = await readFile(join(dir, "bom.json"), "utf8").then((t) => JSON.parse(t) as BomLike, () => null)
	const rev = revision ?? s.revision
	const latest = revision === null || revision === revisions.at(-1)
	const routed = routedOf(dir, rev, latest)
	const routedRevision = routed ? rev : [...revisions].reverse().find((r) => r < rev && routedOf(dir, r, false)) ?? null
	let preview: unknown[] = []
	let reasons: PartReason[] = []
	let swaps: Record<string, SwapOption[]> = {}
	try {
		swaps = swapOptions(s, bom)
		preview = previewCircuit(s)
		reasons = partReasons(s, brief)
	} catch {
		// A contract the placer can't lay out yet (no parts, no outline): the page shows what it has.
	}
	return {
		revision: rev,
		revisions,
		widthMm: s.values.outline?.widthMm ?? null,
		heightMm: s.values.outline?.heightMm ?? null,
		preview,
		routed,
		routedRevision,
		reasons,
		changed: changedRefs(prev, s),
		swaps,
		summary: s.values.requirements?.summary ?? (brief.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").replace(/^Brief:\s*/i, ""),
	}
}
