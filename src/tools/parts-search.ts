import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Part } from "../contract/types.ts"

// Exact LCSC lookup: /api/search?q=C<number> returns that one part, including zero and unknown stock.
// Free-text search there ranks loosely, so the agents only ever look up parts that are already in the catalog.
export const JLCSEARCH = "https://jlcsearch.tscircuit.com"
const TIMEOUT_MS = 5000
const ROOT = resolve(import.meta.dirname, "../..")

interface Live {
	stock: number | null
	priceUsd: number | null
	inStock: boolean | null
}

// iqUa: an LDO's typical quiescent current in µA (power.ts uses it for battery life).
export type CatalogPart = Omit<Part, "ref"> & { ref?: string; iqUa?: number } & Live

const UNKNOWN: Live = { stock: null, priceUsd: null, inStock: null }

// Successful lookups only, so a part that failed once is tried again on the next search. Keyed by fetch so an
// injected fetch never sees another one's answers.
const cache = new WeakMap<typeof fetch, Map<string, Live>>()

export function loadCatalog(root: string): CatalogPart[] {
	const entries = JSON.parse(readFileSync(join(root, "catalog/parts.json"), "utf8")) as CatalogPart[]
	return entries.map((e) => ({ ...e, ...UNKNOWN }))
}

async function lookup(lcsc: string, f: typeof fetch, timeoutMs: number): Promise<Live> {
	const known = cache.get(f)?.get(lcsc)
	if (known) return known
	try {
		const url = `${JLCSEARCH}/api/search?q=${encodeURIComponent(lcsc)}&limit=1`
		const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) })
		if (!res.ok) return UNKNOWN
		const body = (await res.json()) as { components?: { lcsc: number; stock: number | null; price: number | null }[] }
		const hit = body.components?.find((c) => `C${c.lcsc}` === lcsc)
		if (!hit) return UNKNOWN
		const stock = typeof hit.stock === "number" ? hit.stock : null
		const live: Live = { stock, priceUsd: typeof hit.price === "number" ? hit.price : null, inStock: stock === null ? null : stock > 0 }
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
	return Promise.all(parts.map(async (p) => (p.lcsc ? { ...p, ...(await lookup(p.lcsc, f, opts.timeoutMs ?? TIMEOUT_MS)) } : p)))
}
