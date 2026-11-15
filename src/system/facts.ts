// The facts card of a board or a cable on the design page: a few plain lines read from the board's contract and the
// system spec, the same words in the 3D and the Top view. A value that is not known shows as "—", never "undefined".
import type { ContractSnapshot } from "../contract/types.ts"
import { mcuProfileOf } from "../mcu/profile.ts"
import { bringupPads, debugPort } from "../codegen/circuit.ts"
import type { SystemBoard, SystemLink } from "./spec.ts"
import { field, moduleById, moduleOutline, type Cite } from "./bought.ts"
import type { Module } from "../modules/library.ts"
import type { SystemAssembly } from "./assembly.ts"

export interface BoardFacts {
	size: string
	chip: string | null
	power: string
	links: string[]
	mount: string
	debug: string
	// A bought board (a compute module): where it comes from, its peak draw with the source, the board it sits on, and
	// the device its ROS bridge opens.
	bought?: { from: string; peak: string; bridge: string; carrier: string }
}
export interface CableFacts {
	kind: string
	length: string
	messages: string[]
	power: string
}

const DASH = "—"
const mm = (n: number): string => String(Math.round(n * 10) / 10)

const PORT_BY_VENDOR: Record<string, string> = { espressif: "USB/UART download", st: "SWD", nordic: "SWD", raspberrypi: "SWD" }

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
	// The debug port only when the contract places it (on, a pinout for this chip, room on the board), named by the
	// MCU's family: Espressif's is its USB/UART download pinout, ST's, Nordic's (and the RP2040's) SWD.
	let port: string[] = []
	try {
		if (debugPort(c).placed) port = [`debug port (${PORT_BY_VENDOR[mcuProfileOf(v.parts)?.vendor ?? ""] ?? "SWD"})`]
	} catch { /* the contract is not complete enough to place it */ }
	let pads: string
	if (v.requirements?.testPads === false) pads = "no test pads"
	else {
		let nets: string[] = []
		try { nets = bringupPads(c).placed.map((p) => p.net) } catch { /* the contract is not complete enough to place them */ }
		pads = nets.length ? `test pads: ${nets.slice(0, 8).join(", ")}${nets.length > 8 ? ", …" : ""}` : "test pads: none placed"
	}
	const line = [pads, ...usb, ...port].join(" · ")
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

const cited = (c: Cite | null | undefined) => (c ? `${c.url} (${c.where})` : "no source")

export function boughtFacts(m: Module, name: string, assembly: SystemAssembly | undefined, carrier: string | null): BoardFacts {
	const o = moduleOutline(m)
	const peak = field<number>(m, "currentA.peak"), inV = field<{ nom: number }>(m, "inputV")
	const bridge = (m.compute as { bridgeDevice?: { value: string; via?: string } } | undefined)?.bridgeDevice
	return {
		size: o ? `${mm(o.widthMm)} × ${mm(o.heightMm)} mm` : DASH,
		chip: null,
		power: inV?.value?.nom != null ? `${mm(inV.value.nom)} V in${carrier ? ` from ${carrier}` : ""}` : DASH,
		links: [],
		mount: assembly ? `${MOUNT[assembly.body] ?? DASH}${carrier ? `, on ${carrier}` : ""}` : DASH,
		debug: DASH,
		bought: {
			from: m.title,
			peak: peak?.value != null ? `${mm(peak.value)} A${inV?.value?.nom != null ? ` at ${mm(inV.value.nom)} V` : ""}: ${cited(peak.source)}` : `unknown${peak?.note ? ` (${peak.note})` : ""}`,
			bridge: bridge ? `${bridge.value}${bridge.via ? ` (${bridge.via})` : ""}` : DASH,
			carrier: carrier ?? "none yet",
		},
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

// `boards`: the spec's boards, so a bought one shows its module record's facts instead of a contract's.
export function systemFacts(contracts: Record<string, ContractSnapshot | null>, assembly: SystemAssembly | undefined, links: SystemLink[], keys: Record<string, string> = {}, boards: SystemBoard[] = []): { boards: Record<string, BoardFacts>; cables: Record<string, CableFacts> } {
	const boughtOf = (n: string) => {
		const b = boards.find((x) => x.name === n)
		const m = b?.kind === "bought" && b.module ? moduleById(b.module) : undefined
		return m ? boughtFacts(m, n, assembly, boards.find((x) => x.carries === n)?.name ?? null) : null
	}
	return {
		boards: Object.fromEntries(Object.entries(contracts).map(([n, c]) => [n, boughtOf(n) ?? boardFacts(c, n, assembly, links, keys[n])])),
		cables: Object.fromEntries(links.map((l) => [l.id, cableFacts(l)])),
	}
}
