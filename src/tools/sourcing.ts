// Where to buy each part, and whether one supplier can fill the whole order. Only LCSC/JLCPCB has live data
// (jlcsearch); other suppliers get search links by MPN with stock and price left null, never invented.

export const ORDER_SUPPLIER = "LCSC/JLCPCB"
const NOT_CHECKED = "search link, not checked"
const LCSC_NUMBER = /^C\d+$/

export interface Source {
	supplier: string
	url: string // always an absolute https URL
	stock: number | null
	priceUsd: number | null
	note?: string
}

export interface Alternative {
	mpn: string
	lcsc: string | null
	stock: number | null
	priceUsd: number | null
	inStock: boolean | null
}

export interface Readiness {
	supplier: string
	orderable: number
	total: number
	missing: { ref: string; reason: "no LCSC number" | "stock unknown" | "out of stock" }[]
	summary: string
}

const q = encodeURIComponent

export function sourcesFor(part: { mpn: string; lcsc: string | null }, live: { stock: number | null; priceUsd: number | null } | undefined): Source[] {
	const lcsc: Source =
		part.lcsc && LCSC_NUMBER.test(part.lcsc)
			? { supplier: ORDER_SUPPLIER, url: `https://www.lcsc.com/product-detail/${part.lcsc}.html`, stock: live?.stock ?? null, priceUsd: live?.priceUsd ?? null }
			: { supplier: ORDER_SUPPLIER, url: `https://www.lcsc.com/search?q=${q(part.mpn)}`, stock: null, priceUsd: null, note: `no LCSC number: ${NOT_CHECKED}` }
	return [
		lcsc,
		{ supplier: "Digi-Key", url: `https://www.digikey.com/en/products/result?keywords=${q(part.mpn)}`, stock: null, priceUsd: null, note: NOT_CHECKED },
		{ supplier: "Mouser", url: `https://www.mouser.com/c/?q=${q(part.mpn)}`, stock: null, priceUsd: null, note: NOT_CHECKED },
	]
}

// Other catalog parts that could fill the same role, with their live data where known.
export function alternativesFor(
	part: { mpn: string; role: string },
	sameRole: { role: string; mpn: string; lcsc: string | null; stock: number | null; priceUsd: number | null; inStock: boolean | null }[],
): Alternative[] {
	return sameRole
		.filter((c) => c.role === part.role && c.mpn.toUpperCase() !== part.mpn.toUpperCase())
		.map((c) => ({ mpn: c.mpn, lcsc: c.lcsc, stock: c.stock, priceUsd: c.priceUsd, inStock: c.inStock }))
}

// Can one LCSC/JLCPCB order (and JLC assembly) cover every line? Unknown stock counts as not orderable, but is named
// as "stock unknown", not "missing": offline runs know nothing either way.
export function orderReadiness(items: { ref: string; lcsc: string | null; stock: number | null; inStock: boolean | null }[]): Readiness {
	const missing: Readiness["missing"] = []
	for (const i of items) {
		if (!i.lcsc || !LCSC_NUMBER.test(i.lcsc)) missing.push({ ref: i.ref, reason: "no LCSC number" })
		else if (i.stock === null) missing.push({ ref: i.ref, reason: "stock unknown" })
		else if (i.inStock === false || i.stock <= 0) missing.push({ ref: i.ref, reason: "out of stock" })
	}
	const orderable = items.length - missing.length
	const head = `${orderable}/${items.length} lines orderable at ${ORDER_SUPPLIER}`
	return { supplier: ORDER_SUPPLIER, orderable, total: items.length, missing, summary: missing.length ? `${head}; ${missing.map((m) => `${m.ref} ${m.reason}`).join(", ")}` : head }
}
