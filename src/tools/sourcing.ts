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
	// What switching to it would change in the rest of the design (swapEffects); absent when its catalog data is.
	changes?: string[]
}

// What a part in the catalog says about itself, as far as a swap is concerned.
export interface SwapSide {
	mpn: string
	role: string
	footprint: string
	pins: string[]
	iqUa?: number
	sleepUa?: number
	notes?: string
}

const i2cAddress = (notes = "") => /I2C address (0x[0-9a-f]+)/i.exec(notes)?.[1] ?? null

// What switching from one catalog part to another changes in the rest of the design, in plain words: the board (land
// pattern, pins), the firmware (driver, I2C address) and the power budget (quiescent or sleep current). Facts from the
// catalog only; an unknown is said to be unknown.
export function swapEffects(from: SwapSide, to: SwapSide, driverOf: (mpn: string) => string | null): string[] {
	const out: string[] = []
	out.push(from.footprint === to.footprint ? `same footprint (${to.footprint}): the board keeps its land pattern` : `footprint ${from.footprint} → ${to.footprint}: the board is re-placed and re-routed`)
	const same = from.pins.length === to.pins.length && from.pins.every((p, i) => p === to.pins[i])
	const missing = from.pins.filter((p) => !to.pins.includes(p))
	if (same) out.push("same pinout")
	else if (missing.length === 0) out.push("same pin names in another order: the board wires them by name")
	else out.push(`no ${missing.join(", ")} pin${missing.length > 1 ? "s" : ""}: pins assigned to ${missing.length > 1 ? "them" : "it"} must move`)
	const [d1, d2] = [driverOf(from.mpn), driverOf(to.mpn)]
	if (from.role === "sensor" || d1 || d2) {
		if (d1 !== d2) out.push(d2 ? `firmware driver ${d1 ?? "none"} → ${d2}: pins.h selects it and the firmware rebuilds` : `no firmware driver for ${to.mpn}: the firmware can't read it yet`)
		const [a1, a2] = [i2cAddress(from.notes), i2cAddress(to.notes)]
		if (a1 && a2 && a1 !== a2) out.push(`I2C address ${a1} → ${a2}`)
	}
	if (from.iqUa !== undefined && to.iqUa !== undefined && from.iqUa !== to.iqUa) out.push(`quiescent current ${from.iqUa} → ${to.iqUa} µA: the battery estimate changes`)
	if (from.sleepUa !== undefined && to.sleepUa !== undefined && from.sleepUa !== to.sleepUa) out.push(`sleep current ${from.sleepUa} → ${to.sleepUa} µA: the battery estimate changes`)
	return out
}

// For a line out of stock at LCSC: the same part from another supplier first (their stock isn't checked here, so
// these are links), then an in-stock catalog part for the same role with what switching would change, and a change
// request a person can send. Bringup never sends it on its own: buying elsewhere is often the better answer.
export interface StockSuggestion {
	elsewhere: Source[]
	alternative: Alternative | null
	request: string | null
}

export function stockSuggestion(part: { ref: string; mpn: string }, sources: Source[], alternatives: Alternative[]): StockSuggestion {
	// In stock, and preferably one the firmware can drive: a part with no driver would trade a purchase for a rewrite.
	const inStock = alternatives.filter((a) => a.inStock === true || (a.stock ?? 0) > 0)
	const alternative = inStock.find((a) => !a.changes?.some((c) => c.startsWith("no firmware driver"))) ?? inStock[0] ?? null
	return {
		elsewhere: sources.filter((x) => x.supplier !== ORDER_SUPPLIER),
		alternative,
		request: alternative ? `${part.ref} ${part.mpn} is out of stock at ${ORDER_SUPPLIER}: swap it for the ${alternative.mpn}${alternative.lcsc ? ` (${alternative.lcsc})` : ""} from the catalog` : null,
	}
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
// effects: what switching would change, when both parts' catalog data is known (swapEffects).
export function alternativesFor(
	part: { mpn: string; role: string },
	sameRole: { role: string; mpn: string; lcsc: string | null; stock: number | null; priceUsd: number | null; inStock: boolean | null }[],
	effects?: (to: string) => string[] | null,
): Alternative[] {
	return sameRole
		.filter((c) => c.role === part.role && c.mpn.toUpperCase() !== part.mpn.toUpperCase())
		.map((c) => {
			const changes = effects?.(c.mpn)
			return { mpn: c.mpn, lcsc: c.lcsc, stock: c.stock, priceUsd: c.priceUsd, inStock: c.inStock, ...(changes ? { changes } : {}) }
		})
}

// What one LCSC/JLCPCB order (and JLC assembly) could cover. "Listed" means an LCSC number and a live price.
// Stock jlcsearch didn't report is "stock unknown", and a part with an LCSC number but no live data at all (offline,
// or not returned) is "not checked": neither is a sourcing failure, so neither sets warn.
// skipped: why nothing was looked up ("mock run"). Then the summary counts the lines LCSC lists (they have an LCSC
// number) and says stock was not checked, as the dashboard does, instead of "0/N listed … not checked".
export function orderReadiness(items: { ref: string; lcsc: string | null; stock: number | null; priceUsd: number | null; inStock: boolean | null }[], skipped?: string): Readiness {
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
	if (skipped) {
		const atLcsc = items.length - counts.notListed
		const summary = [
			`${atLcsc}/${items.length} at ${ORDER_SUPPLIER} · stock not checked (${skipped})`,
			counts.notListed ? `${counts.notListed} not listed (${refs("not listed").map((r) => `${r}: no LCSC number`).join(", ")})` : "",
		]
		return { supplier: ORDER_SUPPLIER, total: items.length, counts, lines, warn: counts.notListed > 0, summary: summary.filter(Boolean).join(" · ") }
	}
	const parts = [
		`${counts.listed}/${items.length} listed at ${ORDER_SUPPLIER}`,
		counts.stockConfirmed ? `${counts.stockConfirmed} stock confirmed` : "",
		counts.stockUnknown ? `${counts.stockUnknown} stock unknown (jlcsearch returned none)` : "",
		counts.outOfStock ? `${counts.outOfStock} out of stock (${refs("out of stock").join(", ")})` : "",
		counts.notListed ? `${counts.notListed} not listed (${refs("not listed").map((r) => `${r}: no LCSC number`).join(", ")})` : "",
		counts.notChecked ? (skipped ? `${counts.notChecked} not checked: ${skipped}` : `${counts.notChecked} not checked (${refs("not checked").map((r) => `${r}: no live data`).join(", ")})`) : "",
	]
	return { supplier: ORDER_SUPPLIER, total: items.length, counts, lines, warn: counts.outOfStock + counts.notListed > 0, summary: parts.filter(Boolean).join(" · ") }
}
