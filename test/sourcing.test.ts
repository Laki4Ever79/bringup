import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createBomWriter, type Bom } from "../src/agents/bom.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { makeEvent } from "../src/events.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { BringupState, emit, join as joinRuntime, startRuntime } from "../src/runtime.ts"
import { alternativesFor, orderReadiness, sourcesFor } from "../src/tools/sourcing.ts"
import { tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 100)))
const root = resolve(import.meta.dirname, "..")

test("sources: LCSC with live data, Digi-Key and Mouser as unchecked search links", () => {
	const s = sourcesFor({ mpn: "S2B-PH-K-S(LF)(SN)", lcsc: "C173752" }, { stock: 198123, priceUsd: 0.0397 })
	assert.deepEqual(s.map((x) => x.supplier), ["LCSC/JLCPCB", "Digi-Key", "Mouser"])
	assert.deepEqual(s[0], { supplier: "LCSC/JLCPCB", url: "https://www.lcsc.com/product-detail/C173752.html", stock: 198123, priceUsd: 0.0397 })
	assert.equal(s[1].url, "https://www.digikey.com/en/products/result?keywords=S2B-PH-K-S(LF)(SN)".replace("(LF)(SN)", encodeURIComponent("(LF)(SN)")))
	for (const other of s.slice(1)) {
		assert.deepEqual([other.stock, other.priceUsd, other.note], [null, null, "search link, not checked"], "never invent another supplier's data")
	}
	for (const x of s) assert.match(x.url, /^https:\/\//)
})

test("sources: a part without a valid LCSC number gets an LCSC search link instead", () => {
	for (const lcsc of [null, "C000000x", "javascript:alert(1)"]) {
		const [l] = sourcesFor({ mpn: "HEADER-1X02", lcsc }, undefined)
		assert.deepEqual(l, { supplier: "LCSC/JLCPCB", url: "https://www.lcsc.com/search?q=HEADER-1X02", stock: null, priceUsd: null, note: "no LCSC number: search link, not checked" })
	}
})

test("alternatives: other catalog parts with the same role, with live data, never the part itself", () => {
	const catalog = [
		{ role: "ldo", mpn: "AP2112K-3.3TRG1", lcsc: "C51118", footprint: "sot23_5", pins: [], stock: 5000, priceUsd: 0.1, inStock: true },
		{ role: "ldo", mpn: "XC6206P332MR-G", lcsc: "C5446", footprint: "sot23", pins: [], stock: 530418, priceUsd: 0.148, inStock: true },
		{ role: "led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: [], stock: 0, priceUsd: 0.01, inStock: false },
	]
	assert.deepEqual(alternativesFor({ mpn: "XC6206P332MR-G", role: "ldo" }, catalog), [{ mpn: "AP2112K-3.3TRG1", lcsc: "C51118", stock: 5000, priceUsd: 0.1, inStock: true }])
	assert.deepEqual(alternativesFor({ mpn: "KT-0603R", role: "led" }, catalog), [])
})

test("order readiness: lines orderable at LCSC, and why the rest aren't", () => {
	const item = (ref: string, lcsc: string | null, stock: number | null) => ({ ref, lcsc, stock, inStock: stock === null ? null : stock > 0 })
	const r = orderReadiness([item("U1", "C2838502", 22598), item("U4", "C32574", null), item("D1", "C2286", 0), item("J9", null, null), item("R1", "C11702", 100)])
	assert.deepEqual(r, {
		supplier: "LCSC/JLCPCB",
		orderable: 2,
		total: 5,
		missing: [
			{ ref: "U4", reason: "stock unknown" },
			{ ref: "D1", reason: "out of stock" },
			{ ref: "J9", reason: "no LCSC number" },
		],
		summary: "2/5 lines orderable at LCSC/JLCPCB; U4 stock unknown, D1 out of stock, J9 no LCSC number",
	})
	assert.equal(orderReadiness([item("U1", "C2838502", 5)]).summary, "1/1 lines orderable at LCSC/JLCPCB")
})

test("bom.json carries sources, alternatives and the order readiness", async () => {
	const prices: Record<string, { stock: number; price: number }> = { C2838502: { stock: 22598, price: 3.05 }, C5446: { stock: 530418, price: 0.148 } }
	const f = (async (input: string | URL | Request) => {
		const q = new URL(String(input)).searchParams.get("q") ?? ""
		const hit = prices[q]
		return new Response(JSON.stringify({ components: hit ? [{ lcsc: Number(q.slice(1)), stock: hit.stock, price: hit.price }] : [] }))
	}) as typeof fetch
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const desk = createChangeDesk()
	joinRuntime(desk)
	joinRuntime(createBomWriter({ fetch: f, debounceMs: 20, root }))
	const r = state.contract.propose({ field: "parts", value: LOGGER_DESIGN.parts, by: "parts", baseVersion: 0 })
	if (r.status !== "applied") throw new Error(r.status)
	emit(makeEvent("contract.changed", desk.getId(), { field: "parts", version: r.version, revision: r.revision, by: "parts" }), desk.getId())
	const path = join(state.outDir, "bom.json")
	await waitFor(() => existsSync(path))
	const bom = JSON.parse(readFileSync(path, "utf8")) as Bom
	const u1 = bom.items.find((i) => i.ref === "U1")!
	assert.deepEqual(u1.sources![0], { supplier: "LCSC/JLCPCB", url: "https://www.lcsc.com/product-detail/C2838502.html", stock: 22598, priceUsd: 3.05 })
	const u3 = bom.items.find((i) => i.ref === "U3")!
	assert.ok(u3.alternatives!.some((a) => a.mpn === "XC6206P332MR-G" && a.stock === 530418), "the low-Iq LDO is offered with its live stock")
	assert.equal(bom.readiness!.total, LOGGER_DESIGN.parts.length)
	assert.equal(bom.readiness!.orderable, 1, "only U1 has known stock in the fake table")
	assert.match(bom.readiness!.summary, new RegExp(`^1/${LOGGER_DESIGN.parts.length} lines orderable at LCSC/JLCPCB; U2 stock unknown`))
})
