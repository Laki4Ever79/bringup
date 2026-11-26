// Measures every shop link in catalog/mechanics.json with the live price check's own reader (src/tools/offers.ts):
// which answer with a price (and in which currency), which refuse, which publish none. It keeps UNREADABLE_SHOPS and
// USD_PER honest: a listed host that now answers, an unlisted one that refuses, or a currency with no rate is printed at
// the end. One request per link, no retries. The measurement is saved to catalog/shop-links.json, which the catalog
// tests read (test/catalog-shops.test.ts: every currency a shop answers in has a USD_PER rate).
//
//   npx tsx scripts/check-shop-links.ts
import { readFileSync, writeFileSync } from "node:fs"
import { checkOffer, shopHost, UNREADABLE_SHOPS } from "../src/tools/offers.ts"
import { USD_PER } from "../src/tools/robot-parts.ts"

type Part = { mpn: string; buy?: { url?: string | null }[] }
const catalog = JSON.parse(readFileSync("catalog/mechanics.json", "utf8")) as Record<string, unknown>
const links = Object.entries(catalog).flatMap(([section, v]) => (Array.isArray(v) ? (v as Part[]) : []).flatMap((p) => (p.buy ?? []).filter((b) => b.url).map((b) => ({ section, mpn: p.mpn, url: b.url! }))))

const rows: { section: string; mpn: string; url: string; status: string; price: number | null; currency: string | null }[] = []
const byHost = new Map<string, Set<string>>()
for (const l of links) {
	const r = await checkOffer(l.url, { timeoutMs: 15_000 })
	rows.push({ ...l, status: r.status === "refused" ? `refused (${/HTTP \d+/.exec(r.note)?.[0] ?? "?"})` : r.status, price: r.offer?.price ?? null, currency: r.offer?.currency?.toUpperCase() ?? null })
	const h = shopHost(l.url)
	if (!byHost.has(h)) byHost.set(h, new Set())
	byHost.get(h)!.add(r.status)
}
rows.sort((a, b) => a.section.localeCompare(b.section) || a.mpn.localeCompare(b.mpn) || a.url.localeCompare(b.url))
for (const r of rows) console.log(`${r.section}\t${r.mpn}\t${r.status}\t${r.price ?? ""} ${r.currency ?? ""}\t${r.url}`)
const live = rows.filter((r) => r.status === "live").length
console.log(`\n${live} of ${rows.length} links answered with an offer`)
for (const [h, s] of byHost) {
	if (h in UNREADABLE_SHOPS && s.has("live")) console.log(`UNREADABLE_SHOPS lists ${h}, but it answered now: take it off`)
	if (!(h in UNREADABLE_SHOPS) && !s.has("live") && !s.has("offline")) console.log(`${h} didn't answer (${[...s].join(", ")}): add it to UNREADABLE_SHOPS`)
}
const currencies = [...new Set(rows.flatMap((r) => (r.currency ? [r.currency] : [])))].sort()
for (const c of currencies) if (!(c in USD_PER)) console.log(`shops answer in ${c}, which has no USD_PER rate: add one (an estimate)`)
writeFileSync("catalog/shop-links.json", JSON.stringify({ measured: new Date().toISOString().slice(0, 10), live, links: rows.length, currencies, rows: rows.map((r) => ({ mpn: r.mpn, host: shopHost(r.url), status: r.status, currency: r.currency })) }, null, "\t") + "\n")
console.log("saved catalog/shop-links.json")
