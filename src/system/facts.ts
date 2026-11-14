// The facts card of a board or a cable on the design page: a few plain lines read from the board's contract and the
// system spec, the same words in the 3D and the Top view. A value that is not known shows as "—", never "undefined".
import type { ContractSnapshot } from "../contract/types.ts"
import { mcuProfileOf } from "../mcu/profile.ts"
import { bringupPads } from "../codegen/circuit.ts"
import type { SystemLink } from "./spec.ts"
import type { SystemAssembly } from "./assembly.ts"

export interface BoardFacts {
	size: string
	chip: string | null
	power: string
	links: string[]
	mount: string
	debug: string
}
export interface CableFacts {
	kind: string
	length: string
	messages: string[]
	power: string
}

const DASH = "—"
const mm = (n: number): string => String(Math.round(n * 10) / 10)

const MOUNT = { chassis: "on the chassis", enclosure: "in the shared enclosure", separate: "in its case" } as const

// The pad list is placed with the parts (slow) and the page polls: memoised per run and revision when the caller names one.
const padsMemo = new Map<string, string>()
function padsLine(c: ContractSnapshot | null, key?: string): string {
	if (!c) return DASH
	const v = c.values
	if (v.requirements?.testPads !== false && !v.outline) return DASH // nothing built yet: no pad exists to list
	const memo = key ? `${key}@${c.revision}` : null
	const hit = memo ? padsMemo.get(memo) : undefined
	if (hit !== undefined) return hit
	const usb = (v.connectors ?? []).some((k) => k.kind === "usb-c") ? ["USB-C"] : []
	const swd = v.requirements?.debugPort === false || !v.outline ? [] : ["SWD port"]
	let pads: string
	if (v.requirements?.testPads === false) pads = "no test pads"
	else {
		let nets: string[] = []
		try { nets = bringupPads(c).placed.map((p) => p.net) } catch { /* the contract is not complete enough to place them */ }
		pads = nets.length ? `test pads: ${nets.slice(0, 8).join(", ")}${nets.length > 8 ? ", …" : ""}` : "test pads: none placed"
	}
	const line = [pads, ...usb, ...swd].join(" · ")
	if (memo) { if (padsMemo.size > 200) padsMemo.clear(); padsMemo.set(memo, line) }
	return line
}

export function boardFacts(contract: ContractSnapshot | null, name: string, assembly: SystemAssembly | undefined, links: SystemLink[], cacheKey?: string): BoardFacts {
	const v = contract?.values
	const placed = assembly?.boards.find((b) => b.name === name)
	const o = v?.outline ?? (placed ? placed.outline : null)
	const estimate = !v?.outline && placed?.outlineSource === "estimate"
	const size = o ? `${estimate ? "≈ " : ""}${mm(o.widthMm)} × ${mm(o.heightMm)} mm${estimate ? " (estimate)" : ""}` : DASH
	const rails = (v?.rails ?? []).map((r) => `${mm(r.voltageV)} V`)
	const mine = links.filter((l) => l.a.board === name || l.b.board === name)
	const fed = mine.find((l) => l.power && l.power.from !== name)
	const own = rails.length ? [...new Set(rails)].join(" · ") : null
	const power = [...(own ? [own] : []), ...(fed ? [`powered by ${fed.id}`] : [])].join(" · ") || DASH
	return {
		size,
		chip: mcuProfileOf(v?.parts)?.mpn ?? null,
		power,
		links: mine.map((l) => `${l.id} ${l.kind.toUpperCase()} to ${l.a.board === name ? l.b.board : l.a.board}`),
		mount: assembly ? MOUNT[assembly.body] ?? DASH : DASH,
		debug: padsLine(contract, cacheKey),
	}
}

export function cableFacts(link: SystemLink): CableFacts {
	const len = link.cable?.lengthMm
	return {
		kind: link.kind.toUpperCase(),
		length: typeof len === "number" ? `${mm(len)} mm` : DASH,
		messages: (link.messages ?? []).map((m) => `${m.name} from ${m.from}`),
		power: link.power ? `${link.power.from} powers ${link.power.from === link.a.board ? link.b.board : link.a.board}` : "each board has its own supply",
	}
}

export function systemFacts(contracts: Record<string, ContractSnapshot | null>, assembly: SystemAssembly | undefined, links: SystemLink[], keys: Record<string, string> = {}): { boards: Record<string, BoardFacts>; cables: Record<string, CableFacts> } {
	return {
		boards: Object.fromEntries(Object.entries(contracts).map(([n, c]) => [n, boardFacts(c, n, assembly, links, keys[n])])),
		cables: Object.fromEntries(links.map((l) => [l.id, cableFacts(l)])),
	}
}
