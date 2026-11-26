// Measures every shop link in catalog/mechanics.json with the live price check's own reader (src/tools/offers.ts):
// which answer with a price, which refuse, which publish none. It keeps UNREADABLE_SHOPS honest: a listed host that
// now answers, or an unlisted one that refuses, is printed at the end. One request per link, no retries.
//
//   npx tsx scripts/check-shop-links.ts
import { readFileSync } from "node:fs"
import { checkOffer, shopHost, UNREADABLE_SHOPS } from "../src/tools/offers.ts"

type Part = { mpn: string; buy?: { url?: string | null }[] }
const catalog = JSON.parse(readFileSync("catalog/mechanics.json", "utf8")) as Record<string, unknown>
const links = Object.entries(catalog).flatMap(([section, v]) => (Array.isArray(v) ? (v as Part[]) : []).flatMap((p) => (p.buy ?? []).filter((b) => b.url).map((b) => ({ section, mpn: p.mpn, url: b.url! }))))

const rows: { section: string; mpn: string; url: string; status: string; price: string }[] = []
const byHost = new Map<string, Set<string>>()
for (const l of links) {
	const r = await checkOffer(l.url, { timeoutMs: 15_000 })
	rows.push({ ...l, status: r.status === "refused" ? `refused (${/HTTP \d+/.exec(r.note)?.[0] ?? "?"})` : r.status, price: r.offer?.price != null ? `${r.offer.price} ${r.offer.currency ?? ""}` : "" })
	const h = shopHost(l.url)
	if (!byHost.has(h)) byHost.set(h, new Set())
	byHost.get(h)!.add(r.status)
}
for (const r of rows.sort((a, b) => a.section.localeCompare(b.section) || a.mpn.localeCompare(b.mpn))) console.log(`${r.section}\t${r.mpn}\t${r.status}\t${r.price}\t${r.url}`)
const live = rows.filter((r) => r.status === "live").length
console.log(`\n${live} of ${rows.length} links answered with an offer`)
for (const [h, s] of byHost) {
	if (h in UNREADABLE_SHOPS && s.has("live")) console.log(`UNREADABLE_SHOPS lists ${h}, but it answered now: take it off`)
	if (!(h in UNREADABLE_SHOPS) && !s.has("live") && !s.has("offline")) console.log(`${h} didn't answer (${[...s].join(", ")}): add it to UNREADABLE_SHOPS`)
}
