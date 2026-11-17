import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Part } from "../contract/types.ts"
import { readLearned, toCatalogPart } from "../learn/catalog.ts"

// Exact LCSC lookup: /api/search?q=C<number> returns that one part, including zero and unknown stock.
// Free-text search there ranks loosely, so the agents only ever look up parts that are already in the catalog.
export const JLCSEARCH = "https://jlcsearch.tscircuit.com"
const TIMEOUT_MS = 5000
const ROOT = resolve(import.meta.dirname, "../..")

interface Live {
	stock: number | null
	priceUsd: number | null
	inStock: boolean | null
	// JLCPCB's part class: a basic or preferred part loads with no feeder fee; any other is "extended".
	basic?: boolean
	preferred?: boolean
}

// iqUa: an LDO's typical quiescent current in µA. sleepUa: an MCU's typical deep-sleep current in µA, the lowest
// sleep current a design can claim. power.ts uses both for battery life. flashMb and notes: facts the reviewer is
// shown about a part, e.g. that an MCU module's flash can hold the reading history.
export type CatalogPart = Omit<Part, "ref"> & { ref?: string; iqUa?: number; sleepUa?: number; flashMb?: number; notes?: string } & Live

const UNKNOWN: Live = { stock: null, priceUsd: null, inStock: null }

// Successful lookups only, so a part that failed once is tried again on the next search. Keyed by fetch so an
// injected fetch never sees another one's answers.
const cache = new WeakMap<typeof fetch, Map<string, Live>>()

export function loadCatalog(root: string): CatalogPart[] {
	const entries = JSON.parse(readFileSync(join(root, "catalog/parts.json"), "utf8")) as CatalogPart[]
	// Then the parts Bringup learned by itself (catalog/learned/); a hand entry wins on the same MPN.
	const hand = new Set(entries.map((e) => e.mpn))
	const learned = readLearned(root).filter((p) => !hand.has(p.mpn)).map(toCatalogPart)
	return [...entries, ...learned].map((e) => ({ ...e, ...UNKNOWN }))
}

// One LCSC part's live stock and unit price (jlcsearch), for a part the catalog may not list (a passive).
export const lookupLcsc = (lcsc: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}) => lookup(lcsc, opts.fetch ?? fetch, opts.timeoutMs ?? TIMEOUT_MS)
async function lookup(lcsc: string, f: typeof fetch, timeoutMs: number): Promise<Live> {
	const known = cache.get(f)?.get(lcsc)
	if (known) return known
	try {
		const url = `${JLCSEARCH}/api/search?q=${encodeURIComponent(lcsc)}&limit=1`
		const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) })
		if (!res.ok) return UNKNOWN
		const body = (await res.json()) as { components?: { lcsc: number; stock: number | null; price: number | null; is_basic?: boolean; is_preferred?: boolean }[] }
		const hit = body.components?.find((c) => `C${c.lcsc}` === lcsc)
		if (!hit) return UNKNOWN
		const stock = typeof hit.stock === "number" ? hit.stock : null
		const live: Live = { stock, priceUsd: typeof hit.price === "number" ? hit.price : null, inStock: stock === null ? null : stock > 0, ...(typeof hit.is_basic === "boolean" ? { basic: hit.is_basic, preferred: hit.is_preferred === true } : {}) }
		if (!cache.has(f)) cache.set(f, new Map())
		cache.get(f)!.set(lcsc, live)
		return live
	} catch {
		return UNKNOWN
	}
}

// Catalog parts for a role, with live stock and unit price from JLCPCB where reachable. Never throws on the network:
// an offline run gets the catalog with nulls.
export async function searchParts(role: string, opts: { fetch?: typeof fetch; root?: string; timeoutMs?: number } = {}): Promise<CatalogPart[]> {
	const f = opts.fetch ?? fetch
	const parts = loadCatalog(opts.root ?? ROOT).filter((p) => p.role === role)
	// JLCPCB basic and preferred parts first: they load with no feeder fee ($3.07 a unique extended part), the biggest
	// avoidable line in a small order (run 9's package: 8 extended parts, $24.56 of a $51.45 order). Stable otherwise.
	const found = await Promise.all(parts.map(async (p) => (p.lcsc ? { ...p, ...(await lookup(p.lcsc, f, opts.timeoutMs ?? TIMEOUT_MS)) } : p)))
	// Only among drop-ins (the same footprint and pins): a preferred STM32 doesn't go ahead of the ESP32-C3 module, a
	// different chip family; the catalog's order between them stands.
	const free = (p: (typeof found)[number]) => ("basic" in p && (p.basic || p.preferred) ? 0 : 1)
	const group = (p: (typeof found)[number]) => `${p.footprint}|${[...p.pins].sort().join(",")}`
	const firstOf = new Map<string, number>()
	found.forEach((p, i) => { if (!firstOf.has(group(p))) firstOf.set(group(p), i) })
	return found.map((p, i) => ({ p, i })).sort((a, b) => firstOf.get(group(a.p))! - firstOf.get(group(b.p))! || free(a.p) - free(b.p) || a.i - b.i).map((x) => x.p)
}
