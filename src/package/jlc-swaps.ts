// Cheaper at JLCPCB: for each extended part on the board (a $3.07 feeder each, src/package/build.ts JLC), the catalog
// parts of the same role that would load free (basic or preferred) or share a feeder already loaded (the same part used
// elsewhere on the board). Each swap is tried on the contract and kept only when the design's checks find nothing new,
// so an offer never trades a fee for a broken design; a refused one says why. Only drop-ins (same footprint and pins)
// are tried. Nothing is changed: it's a list.
import type { ContractSnapshot, Part } from "../contract/types.ts"
import { checkConsistency } from "../contract/consistency.ts"
import { loadCatalog } from "../tools/parts-search.ts"

export interface JlcClass { basic: boolean; preferred: boolean }
export interface JlcSwap { ref: string; from: string; to: string; toLcsc: string; why: string; savesUsd: number }
export interface JlcRefused { ref: string; from: string; to: string; reason: string }

export function jlcSwaps(s: ContractSnapshot, classOf: (lcsc: string) => JlcClass | null, opts: { root: string; feeUsd: number }): { swaps: JlcSwap[]; refused: JlcRefused[]; stays: { ref: string; mpn: string; reason: string }[] } {
	const parts = s.values.parts ?? []
	const extended = (p: { lcsc: string | null }) => {
		const c = p.lcsc ? classOf(p.lcsc) : null
		return c !== null && !c.basic && !c.preferred
	}
	const base = new Set(checkConsistency(s, {}).map((v) => `${v.kind}:${v.message}`))
	const catalog = loadCatalog(opts.root) as unknown as (Part & { lcsc: string | null })[]
	const swaps: JlcSwap[] = [], refused: JlcRefused[] = [], stays: { ref: string; mpn: string; reason: string }[] = []
	const seen = new Set<string>()
	for (const p of parts.filter((x) => x.lcsc && extended(x))) {
		// The fee is per unique part: a part another ref also uses gains nothing from moving one of them.
		const shared = parts.filter((x) => x.lcsc === p.lcsc).length > 1
		// A candidate loads free only when its class is KNOWN basic or preferred (an unknown class isn't a saving), or it
		// shares a feeder the board already loads.
		const free = (c: { lcsc: string | null }) => { const k = c.lcsc ? classOf(c.lcsc) : null; return k !== null && (k.basic || k.preferred) }
		const candidates = catalog.filter((c) => c.role === p.role && c.lcsc && c.mpn !== p.mpn && (free(c) || parts.some((x) => x.lcsc === c.lcsc && x.ref !== p.ref)))
		if (shared || !candidates.length) {
			if (!seen.has(p.lcsc!)) stays.push({ ref: p.ref, mpn: p.mpn, reason: shared ? `shared by ${parts.filter((x) => x.lcsc === p.lcsc).map((x) => x.ref).join(", ")}: one feeder already` : `no basic or preferred ${p.role} in the catalog`})
			seen.add(p.lcsc!)
			continue
		}
		let offered = false
		for (const c of candidates) {
			// Drop-in only: the same footprint and pin names, so the board's wiring stays as it is. Anything else (an STM32
			// for the ESP32-C3 module: another footprint, pins and no radio) is a redesign, not a cheaper part.
			const samePins = c.pins.length === p.pins.length && c.pins.every((x) => p.pins.includes(x))
			if (c.footprint !== p.footprint || !samePins) {
				refused.push({ ref: p.ref, from: p.mpn, to: c.mpn, reason: `not a drop-in: ${c.footprint !== p.footprint ? `footprint ${c.footprint}, not ${p.footprint}` : `pins ${c.pins.join("/")}, not ${p.pins.join("/")}`}` })
				continue
			}
			const swapped: ContractSnapshot = { ...s, values: { ...s.values, parts: parts.map((x) => (x.ref === p.ref ? { ...x, mpn: c.mpn, lcsc: c.lcsc, footprint: c.footprint, pins: c.pins } : x)) } }
			const fresh = checkConsistency(swapped, {}).filter((v) => !base.has(`${v.kind}:${v.message}`))
			if (fresh.length) {
				refused.push({ ref: p.ref, from: p.mpn, to: c.mpn, reason: `${fresh[0].kind}: ${fresh[0].message.slice(0, 200)}` })
				continue
			}
			const cl = classOf(c.lcsc!)
			swaps.push({ ref: p.ref, from: p.mpn, to: c.mpn, toLcsc: c.lcsc!, why: cl && (cl.basic || cl.preferred) ? `${cl.basic ? "basic" : "preferred"}: loads free` : `the board already loads ${c.mpn} (${parts.filter((x) => x.lcsc === c.lcsc).map((x) => x.ref).join(", ")}): one feeder for all`, savesUsd: opts.feeUsd })
			offered = true
			break
		}
		if (!offered) {
			const mine = refused.filter((r) => r.ref === p.ref)
			const allShape = mine.every((r) => r.reason.startsWith("not a drop-in"))
			stays.push({ ref: p.ref, mpn: p.mpn, reason: allShape ? `no drop-in alternative in the catalog (${mine.map((r) => `${r.to}: ${r.reason.replace(/^not a drop-in: /, "")}`).join("; ")})` : `its drop-in alternatives fail the design's checks (${mine.map((r) => `${r.to}: ${r.reason.split(":")[0]}`).join("; ")})` })
		}
	}
	return { swaps, refused, stays }
}
