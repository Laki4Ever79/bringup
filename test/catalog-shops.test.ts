// Every bought part in catalog/mechanics.json (motors, wheels, casters, batteries, servos, cables, hardware…) has a shop
// link the live price check can read: a host not in UNREADABLE_SHOPS (src/tools/offers.ts, measured by
// scripts/check-shop-links.ts). Before 26 Nov 2026, 18 of the catalog's 49 links answered and the rover's motors and
// wheels always showed "not checked".
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { readableShop, shopHost } from "../src/tools/offers.ts"

// Parts no readable shop was found for yet (26 Nov 2026), each with where it was looked for. Shrink this list; a part
// that gains a readable link must leave it (the test says so).
const NO_READABLE_SHOP_YET: Record<string, string> = {
	"POLOLU-5139 100:1 MP 6V 12 CPR encoder": "The Pi Hut and Melopero don't list it; RobotShop and Core Electronics refuse; Robot Gear publishes no price",
	"POLOLU-5219 150:1 HPCB 12V 12 CPR encoder": "The Pi Hut, Melopero and Kamami don't list it; RobotShop and Core Electronics refuse",
	"TENTE 1430POI038P60-46x38 swivel caster 38 mm": "RS (au) refuses; Kramp's and TENTE's own product pages answer 404",
	"BOTLAND-7292 swivel caster 25 mm": "only Botland, which refuses",
	"IFUTURETECH 1in castor wheel": "only iFutureTech, which refuses",
	"GENSACE-GEA22002S20X6 2S 2200 mAh 20C LiPo XT60": "only Gensace, which refuses",
	"GOBILDA-3423-0006-0088 GT2 belt 44T closed": "only goBILDA, which refuses",
	"GOBILDA-3501-0804-0200 lead screw 8 mm lead 200 mm": "only goBILDA, which refuses",
	"GOBILDA-3505-0804-3216 lead screw pattern nut 8 mm lead": "only goBILDA, which refuses",
	"KHK-SSA1-20J8 spur gear module 1 20T 8 mm bore": "only KHK, which publishes no price",
	"KHK-SSA1-40J8 spur gear module 1 40T 8 mm bore": "only KHK, which publishes no price",
	"608ZZ bearing 8x22x7 mm (SMB Bearings)": "the link is SMB's datasheet PDF, not a shop page",
	"ARTEKIT JST PH 2-pin cable 300 mm": "only Artekit, which publishes no price",
	"M2.5x8 thread-forming pan head screw (for plastic)": "only McMaster-Carr, which publishes no price",
}

type Part = { mpn: string; buy?: { url?: string | null }[] }
const catalog = JSON.parse(readFileSync("catalog/mechanics.json", "utf8")) as Record<string, unknown>
const parts = Object.entries(catalog).flatMap(([section, v]) => (Array.isArray(v) ? (v as Part[]).map((p) => ({ section, ...p })) : []))

test("every bought part has a shop link the live price check can read", () => {
	assert.ok(parts.length > 40, `${parts.length}`)
	const missing = parts.filter((p) => !(p.buy ?? []).some((b) => b.url && readableShop(b.url)))
	const unexplained = missing.filter((p) => !(p.mpn in NO_READABLE_SHOP_YET))
	assert.deepEqual(
		unexplained.map((p) => `${p.section}: ${p.mpn} (${(p.buy ?? []).map((b) => (b.url ? shopHost(b.url) : "no url")).join(", ") || "no link"})`),
		[],
		"add a shop that answers the check (scripts/check-shop-links.ts measures one)",
	)
	// A part that has a readable link now leaves the waiting list.
	const fixed = Object.keys(NO_READABLE_SHOP_YET).filter((m) => !missing.some((p) => p.mpn === m))
	assert.deepEqual(fixed, [], "these parts have a readable link now: take them off NO_READABLE_SHOP_YET")
})

test("every shop link is a product page, never a shop's home page", () => {
	const bare = parts.flatMap((p) => (p.buy ?? []).filter((b) => b.url && new URL(b.url).pathname.replace(/\/$/, "") === "").map(() => p.mpn))
	assert.deepEqual(bare, [])
})

test("every currency a catalog shop answers in has a USD_PER rate (catalog/shop-links.json, the last measurement)", async () => {
	const { USD_PER } = await import("../src/tools/robot-parts.ts")
	const m = JSON.parse(readFileSync("catalog/shop-links.json", "utf8")) as { measured: string; currencies: string[]; rows: { currency: string | null }[] }
	assert.ok(m.currencies.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(m.measured))
	// The list agrees with its rows, and each currency converts (else its lines would say "not converted").
	assert.deepEqual(m.currencies, [...new Set(m.rows.flatMap((r) => (r.currency ? [r.currency] : [])))].sort())
	assert.deepEqual(m.currencies.filter((c) => !(c in USD_PER)), [], "add a USD_PER rate (an estimate) for these")
})
