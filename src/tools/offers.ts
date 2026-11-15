// Live price, availability and lead time for a bought part from the shop's own product page: the schema.org Offer
// (JSON-LD) that shops publish for search engines. One reader for every shop that publishes one, so a robot's parts
// list doesn't depend on one supplier's API or key. A shop that refuses automated requests, or publishes no Offer, is
// reported as unchecked: Bringup never fills in a price or a lead time a shop didn't state.

export type Availability = "in stock" | "out of stock" | "backorder" | "pre-order" | "discontinued" | "unknown"

export interface Offer {
	price: number | null
	currency: string | null
	availability: Availability
	// Days until it ships, only when the shop states it (deliveryLeadTime, or shippingDetails' handling time).
	leadDays: number | null
}

export interface OfferCheck {
	url: string
	status: "live" | "refused" | "no offer data" | "offline"
	offer: Offer | null
	checkedAt: string
	note: string
}

const TIMEOUT_MS = 8000
// A page's answer is kept this long (offline ones aren't kept): the parts list is rewritten on every parts or
// mechanics change, and a shop shouldn't see a request for each. Keyed by fetch, so an injected fetch never sees
// another one's answers.
const CACHE_MS = 30 * 60_000
const cache = new WeakMap<typeof fetch, Map<string, OfferCheck>>()

function availabilityOf(v: unknown): Availability {
	const s = String(v ?? "").replace(/^https?:\/\/schema\.org\//i, "").toLowerCase()
	if (s === "instock" || s === "limitedavailability" || s === "instoreonly" || s === "onlineonly") return "in stock"
	if (s === "outofstock" || s === "soldout") return "out of stock"
	if (s === "backorder") return "backorder"
	if (s === "preorder" || s === "presale") return "pre-order"
	if (s === "discontinued") return "discontinued"
	return "unknown"
}

// UN/CEFACT unit codes schema.org uses for durations: DAY, WEE (week), HUR (hour); "d" is common in the wild.
function toDays(value: unknown, unit: unknown): number | null {
	const n = Number(value)
	if (!Number.isFinite(n)) return null
	const u = String(unit ?? "DAY").toUpperCase()
	if (u === "DAY" || u === "D") return n
	if (u === "WEE" || u === "WK") return n * 7
	if (u === "HUR" || u === "H") return Math.ceil(n / 24)
	return null
}

function leadDaysOf(o: Record<string, any>): number | null {
	const lead = o.deliveryLeadTime
	if (lead && typeof lead === "object") return toDays(lead.maxValue ?? lead.value, lead.unitCode)
	const ship = Array.isArray(o.shippingDetails) ? o.shippingDetails[0] : o.shippingDetails
	const h = ship?.deliveryTime?.handlingTime
	if (h && typeof h === "object") return toDays(h.maxValue ?? h.value ?? h.minValue, h.unitCode)
	return null
}

function offerOf(o: Record<string, any>): Offer | null {
	const raw = o["@type"] === "AggregateOffer" ? o.lowPrice ?? o.price : o.price ?? o.priceSpecification?.price
	const price = raw === undefined || raw === null || raw === "" ? null : Number(raw)
	return {
		price: price !== null && Number.isFinite(price) ? price : null,
		currency: o.priceCurrency ?? o.priceSpecification?.priceCurrency ?? null,
		availability: availabilityOf(o.availability),
		leadDays: leadDaysOf(o),
	}
}

// Every Offer in the page's JSON-LD (inside a Product, a @graph or a list); the lowest-priced one, preferring one in
// stock at the same price. null when the page has none.
export function readOffer(html: string): Offer | null {
	const offers: Offer[] = []
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) return node.forEach(visit)
		if (!node || typeof node !== "object") return
		const n = node as Record<string, any>
		const type = Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]
		if (type.includes("Offer") || type.includes("AggregateOffer")) {
			const o = offerOf(n)
			if (o) offers.push(o)
			return
		}
		if (n.offers) visit(n.offers)
		if (n["@graph"]) visit(n["@graph"])
	}
	for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			visit(JSON.parse(m[1]))
		} catch {
			// A broken block: skip it; the page's other blocks may still hold the Offer.
		}
	}
	if (!offers.length) return null
	const priced = offers.filter((o) => o.price !== null)
	if (!priced.length) return offers[0]
	return priced.sort((a, b) => a.price! - b.price! || Number(b.availability === "in stock") - Number(a.availability === "in stock"))[0]
}

// One product page, fetched once. A browser-like User-Agent with no personal details; shops that still refuse are
// reported as refused.
export async function checkOffer(url: string, opts: { fetch?: typeof fetch; now?: () => Date; timeoutMs?: number } = {}): Promise<OfferCheck> {
	const f = opts.fetch ?? fetch
	const at = (opts.now ?? (() => new Date()))()
	if (!cache.has(f)) cache.set(f, new Map())
	const kept = cache.get(f)!.get(url)
	if (kept && at.getTime() - Date.parse(kept.checkedAt) < CACHE_MS) return kept
	const result = await fetchOffer(url, f, at.toISOString(), opts.timeoutMs ?? TIMEOUT_MS)
	if (result.status !== "offline") cache.get(f)!.set(url, result)
	return result
}

async function fetchOffer(url: string, f: typeof fetch, checkedAt: string, timeoutMs: number): Promise<OfferCheck> {
	const host = (() => {
		try {
			return new URL(url).hostname.replace(/^www\./, "")
		} catch {
			return url
		}
	})()
	try {
		const res = await f(url, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Bringup-parts-check", Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) })
		if (!res.ok) return { url, status: "refused", offer: null, checkedAt, note: `not checked: ${host} refused the automated check (HTTP ${res.status})` }
		const offer = readOffer(await res.text())
		if (!offer) return { url, status: "no offer data", offer: null, checkedAt, note: `not checked: ${host} publishes no price or stock data on the page` }
		return { url, status: "live", offer, checkedAt, note: `${host}, checked ${checkedAt.slice(0, 16).replace("T", " ")} UTC` }
	} catch (e) {
		return { url, status: "offline", offer: null, checkedAt, note: `not checked: ${host} unreachable (${e instanceof Error ? e.message : String(e)})` }
	}
}
