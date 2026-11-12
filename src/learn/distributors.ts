import { usageRecord, type UsageRecord } from "../inference/usage.ts"
import { JLCSEARCH } from "../tools/parts-search.ts"
import { mpnKey } from "./catalog.ts"
import { BudgetExhausted, estimateUsd, type Budget } from "./budget.ts"
import type { DocStore } from "./docs.ts"
import { MODELS_LEARN } from "./reader.ts"
import type { Listing } from "./types.ts"

// Where a part can be bought, behind one interface: LCSC/JLCPCB (no key; what the board assembler stocks), DigiKey and
// Mouser (official APIs, with keys the user registers), and the manufacturer's own datasheet found by web search for
// parts no distributor API lists. The user, 12 Nov: "we should be able to take any part from digikey, or whatever
// provider".
export interface Distributor {
	name: string
	lookup(mpn: string): Promise<Listing | null>
}

const TIMEOUT_MS = 10_000

// Same part number: case-insensitive, ignoring an ordering suffix after "#" ("#PBF") or a trailing "-TR".
export function sameMpn(a: string, b: string): boolean {
	return mpnKey(a) === mpnKey(b)
}

// jlcsearch (the same index parts-search.ts uses): an MPN query; only an exact MPN counts, because its free-text
// ranking is loose. It has no datasheet link, so an LCSC part's datasheet comes from another listing or webFind.
export function lcsc(fetchImpl: typeof fetch): Distributor {
	return {
		name: "lcsc",
		async lookup(mpn) {
			const res = await fetchImpl(`${JLCSEARCH}/api/search?q=${encodeURIComponent(mpn)}&limit=10`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
			if (!res.ok) return null
			const body = (await res.json()) as { components?: { lcsc: number; mfr?: string; package?: string; description?: string; stock?: number | null; price?: number | null }[] }
			const hit = body.components?.find((c) => c.mfr && sameMpn(c.mfr, mpn))
			if (!hit) return null
			return {
				distributor: "lcsc",
				mpn: hit.mfr!,
				sku: `C${hit.lcsc}`,
				stock: typeof hit.stock === "number" ? hit.stock : null,
				priceUsd: typeof hit.price === "number" ? hit.price : null,
				assemblerStocked: true,
				productUrl: `https://www.lcsc.com/product-detail/C${hit.lcsc}.html`,
				...(hit.package ? { package: hit.package } : {}),
				...(hit.description ? { description: hit.description } : {}),
			}
		},
	}
}

// DigiKey Product Information v4 (developer.digikey.com): a client-credentials token, then product details by part
// number. Endpoint and field names as documented there; not yet exercised against the live API (needs the user's
// keys). DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET.
export function digikey(env: Record<string, string | undefined>, fetchImpl: typeof fetch): Distributor | null {
	const id = env.DIGIKEY_CLIENT_ID?.trim()
	const secret = env.DIGIKEY_CLIENT_SECRET?.trim()
	if (!id || !secret) return null
	let token: { value: string; until: number } | null = null
	const auth = async () => {
		if (token && token.until > Date.now()) return token.value
		const res = await fetchImpl("https://api.digikey.com/v1/oauth2/token", {
			method: "POST",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }).toString(),
		})
		const b = (await res.json()) as { access_token?: string; expires_in?: number }
		if (!res.ok || !b.access_token) throw new Error(`digikey token: HTTP ${res.status}`)
		token = { value: b.access_token, until: Date.now() + Math.max(60, (b.expires_in ?? 600) - 60) * 1000 }
		return token.value
	}
	return {
		name: "digikey",
		async lookup(mpn) {
			const res = await fetchImpl(`https://api.digikey.com/products/v4/search/${encodeURIComponent(mpn)}/productdetails`, {
				signal: AbortSignal.timeout(TIMEOUT_MS),
				headers: { authorization: `Bearer ${await auth()}`, "X-DIGIKEY-Client-Id": id },
			})
			if (!res.ok) return null
			const p = ((await res.json()) as { Product?: { ManufacturerProductNumber?: string; Manufacturer?: { Name?: string }; QuantityAvailable?: number; UnitPrice?: number; DatasheetUrl?: string; PhotoUrl?: string; ProductUrl?: string } }).Product
			if (!p?.ManufacturerProductNumber || !sameMpn(p.ManufacturerProductNumber, mpn)) return null
			return {
				distributor: "digikey",
				mpn: p.ManufacturerProductNumber,
				manufacturer: p.Manufacturer?.Name,
				stock: typeof p.QuantityAvailable === "number" ? p.QuantityAvailable : null,
				priceUsd: typeof p.UnitPrice === "number" ? p.UnitPrice : null,
				assemblerStocked: false,
				datasheetUrl: p.DatasheetUrl?.replace(/^\/\//, "https://"),
				photoUrl: p.PhotoUrl,
				productUrl: p.ProductUrl,
			}
		},
	}
}

// Mouser Search API v1, part-number search (mouser.com/api-search). Field names as documented there; not yet
// exercised against the live API (needs the user's key). MOUSER_API_KEY.
export function mouser(env: Record<string, string | undefined>, fetchImpl: typeof fetch): Distributor | null {
	const key = env.MOUSER_API_KEY?.trim()
	if (!key) return null
	return {
		name: "mouser",
		async lookup(mpn) {
			const res = await fetchImpl(`https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(key)}`, {
				method: "POST",
				signal: AbortSignal.timeout(TIMEOUT_MS),
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: "Exact" } }),
			})
			if (!res.ok) return null
			type Part = { ManufacturerPartNumber?: string; Manufacturer?: string; MouserPartNumber?: string; AvailabilityInStock?: string; PriceBreaks?: { Quantity?: number; Price?: string }[]; DataSheetUrl?: string; ImagePath?: string; ProductDetailUrl?: string }
			const parts = ((await res.json()) as { SearchResults?: { Parts?: Part[] } }).SearchResults?.Parts ?? []
			const p = parts.find((x) => x.ManufacturerPartNumber && sameMpn(x.ManufacturerPartNumber, mpn))
			if (!p) return null
			const price = Number((p.PriceBreaks?.[0]?.Price ?? "").replace(/[^0-9.,]/g, "").replace(",", "."))
			const stock = Number((p.AvailabilityInStock ?? "").replace(/\D/g, ""))
			return {
				distributor: "mouser",
				mpn: p.ManufacturerPartNumber!,
				manufacturer: p.Manufacturer,
				sku: p.MouserPartNumber,
				stock: p.AvailabilityInStock ? stock : null,
				priceUsd: Number.isFinite(price) && price > 0 ? price : null,
				assemblerStocked: false,
				datasheetUrl: p.DataSheetUrl || undefined,
				photoUrl: p.ImagePath || undefined,
				productUrl: p.ProductDetailUrl || undefined,
			}
		},
	}
}

export function distributorsFrom(env: Record<string, string | undefined>, fetchImpl: typeof fetch): Distributor[] {
	return [lcsc(fetchImpl), digikey(env, fetchImpl), mouser(env, fetchImpl)].filter((d): d is Distributor => d !== null)
}

// Every distributor that answers; one that fails or times out just isn't in the list.
export async function findListings(mpn: string, ds: Distributor[]): Promise<Listing[]> {
	const all = await Promise.all(ds.map((d) => d.lookup(mpn).catch(() => null)))
	return all.filter((l): l is Listing => l !== null)
}

// OpenAI's web search tool is billed per search on top of tokens: an estimate, charged to the budget with every call.
const SEARCH_FEE_USD = 0.01

export interface WebFindDeps {
	env: Record<string, string | undefined>
	fetchImpl: typeof fetch
	budget: Budget
	store: DocStore
	onUsage: (r: UsageRecord) => void
}

// The manufacturer's datasheet for exactly this MPN, found by a model with web search. A link counts only when the
// PDF behind it names the MPN in its first pages' text: the model's say-so is not enough.
export async function webFind(mpn: string, deps: WebFindDeps): Promise<Listing | null> {
	const model = MODELS_LEARN.cheap
	const est = estimateUsd(model, 0, 800) + SEARCH_FEE_USD
	if (!deps.env.OPENAI_API_KEY) return null
	if (!deps.budget.reserve(est)) throw new BudgetExhausted(deps.budget.spent, deps.budget.cap)
	let text = ""
	let usd: number | null = null
	try {
		const res = await deps.fetchImpl("https://api.openai.com/v1/responses", {
			method: "POST",
			signal: AbortSignal.timeout(120_000),
			headers: { "content-type": "application/json", authorization: `Bearer ${deps.env.OPENAI_API_KEY}` },
			body: JSON.stringify({
				model,
				tools: [{ type: "web_search" }],
				max_output_tokens: 800,
				input: `Find the official datasheet PDF for the electronic part with manufacturer part number "${mpn}". Prefer the manufacturer's own site. Answer with the direct PDF URLs only, one per line, best first.`,
			}),
		})
		const body = (await res.json()) as { output_text?: string; output?: { content?: { text?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }
		const record = usageRecord(model, "part-learner", body.usage?.input_tokens, body.usage?.input_tokens_details?.cached_tokens, body.usage?.output_tokens)
		deps.onUsage(record)
		usd = record.usd === null ? null : record.usd + SEARCH_FEE_USD
		if (!res.ok) return null
		text = body.output_text ?? (body.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("\n")
	} finally {
		deps.budget.settle(est, usd)
	}
	const urls = [...new Set(text.match(/https?:\/\/[^\s<>()"']+?\.pdf\b[^\s<>()"']*/gi) ?? [])].slice(0, 3)
	const named = new RegExp(`(^|[^A-Za-z0-9])${mpn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")
	for (const url of urls) {
		const doc = await deps.store.fetch(url, "datasheet")
		if ("error" in doc) continue
		let firstPages = ""
		for (let p = 1; p <= Math.min(3, doc.pages); p++) firstPages += `${await deps.store.textIn(doc, p)}\n`
		if (named.test(firstPages)) return { distributor: "manufacturer", mpn, stock: null, priceUsd: null, assemblerStocked: false, datasheetUrl: url }
	}
	return null
}
