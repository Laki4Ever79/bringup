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

export type LineStatus = "stock confirmed" | "stock unknown" | "out of stock" | "not listed" | "not checked"

export interface Readiness {
	supplier: string
	total: number
	counts: { listed: number; stockConfirmed: number; stockUnknown: number; outOfStock: number; notListed: number; notChecked: number }
	lines: { ref: string; status: LineStatus }[]
	// Amber: a line is out of stock or not listed. Unknown or unchecked stock is not a warning.
	warn: boolean
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

// What one LCSC/JLCPCB order (and JLC assembly) could cover. "Listed" means an LCSC number and a live price.
// Stock jlcsearch didn't report is "stock unknown", and a part with an LCSC number but no live data at all (offline,
// or not returned) is "not checked": neither is a sourcing failure, so neither sets warn.
export function orderReadiness(items: { ref: string; lcsc: string | null; stock: number | null; priceUsd: number | null; inStock: boolean | null }[]): Readiness {
	const status = (i: (typeof items)[number]): LineStatus => {
		if (!i.lcsc || !LCSC_NUMBER.test(i.lcsc)) return "not listed"
		if (i.stock !== null && (i.inStock === false || i.stock <= 0)) return "out of stock"
		if (i.stock !== null) return "stock confirmed"
		return i.priceUsd !== null ? "stock unknown" : "not checked"
	}
	const lines = items.map((i) => ({ ref: i.ref, status: status(i) }))
	const refs = (s: LineStatus) => lines.filter((l) => l.status === s).map((l) => l.ref)
	const counts = {
		listed: lines.filter((l) => l.status === "stock confirmed" || l.status === "stock unknown" || l.status === "out of stock").length,
		stockConfirmed: refs("stock confirmed").length,
		stockUnknown: refs("stock unknown").length,
		outOfStock: refs("out of stock").length,
		notListed: refs("not listed").length,
		notChecked: refs("not checked").length,
	}
	const parts = [
		`${counts.listed}/${items.length} listed at ${ORDER_SUPPLIER}`,
		counts.stockConfirmed ? `${counts.stockConfirmed} stock confirmed` : "",
		counts.stockUnknown ? `${counts.stockUnknown} stock unknown (jlcsearch returned none)` : "",
		counts.outOfStock ? `${counts.outOfStock} out of stock (${refs("out of stock").join(", ")})` : "",
		counts.notListed ? `${counts.notListed} not listed (${refs("not listed").map((r) => `${r}: no LCSC number`).join(", ")})` : "",
		counts.notChecked ? `${counts.notChecked} not checked (${refs("not checked").map((r) => `${r}: no live data`).join(", ")})` : "",
	]
	return { supplier: ORDER_SUPPLIER, total: items.length, counts, lines, warn: counts.outOfStock + counts.notListed > 0, summary: parts.filter(Boolean).join(" · ") }
}
