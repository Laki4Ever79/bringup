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

test("readiness separates listed, stock confirmed, stock unknown, out of stock, not listed and not checked", () => {
	const item = (ref: string, lcsc: string | null, stock: number | null, priceUsd: number | null) => ({ ref, lcsc, stock, priceUsd, inStock: stock === null ? null : stock > 0 })
	const r = orderReadiness([
		item("U1", "C2838502", 22598, 3.05),
		item("U3", "C5446", null, 0.148),
		item("U4", "C32574", null, 0.15),
		item("D1", "C2286", 0, 0.01),
		item("J9", null, null, null),
		item("R1", "C11702", null, null),
	])
	assert.deepEqual(r.counts, { listed: 4, stockConfirmed: 1, stockUnknown: 2, outOfStock: 1, notListed: 1, notChecked: 1 })
	assert.deepEqual(r.lines, [
		{ ref: "U1", status: "stock confirmed" },
		{ ref: "U3", status: "stock unknown" },
		{ ref: "U4", status: "stock unknown" },
		{ ref: "D1", status: "out of stock" },
		{ ref: "J9", status: "not listed" },
		{ ref: "R1", status: "not checked" },
	])
	assert.equal(r.warn, true, "amber: an out-of-stock or unlisted line")
	assert.equal(
		r.summary,
		"4/6 listed at LCSC/JLCPCB · 1 stock confirmed · 2 stock unknown (jlcsearch returned none) · 1 out of stock (D1) · 1 not listed (J9: no LCSC number) · 1 not checked (R1: no live data)",
	)
})

test("unknown stock alone is not a warning (7a's 2/18)", () => {
	const item = (ref: string, stock: number | null) => ({ ref, lcsc: "C5446", stock, priceUsd: 0.1, inStock: stock === null ? null : stock > 0 })
	const r = orderReadiness([item("U1", 5), item("U2", 7), ...Array.from({ length: 16 }, (_, i) => item(`R${i + 1}`, null))])
	assert.equal(r.warn, false)
	assert.equal(r.summary, "18/18 listed at LCSC/JLCPCB · 2 stock confirmed · 16 stock unknown (jlcsearch returned none)")
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
	assert.equal(bom.readiness!.counts.stockConfirmed, 1, "only U1 has known stock in the fake table")
	assert.equal(bom.readiness!.counts.notChecked, LOGGER_DESIGN.parts.length - 1, "the fake table returns nothing for the rest")
	assert.equal(bom.readiness!.warn, false)
})

test("whenIdle waits for a pending or running bom.json write", async () => {
	const slow = (async () => { await new Promise((r) => setTimeout(r, 300)); return new Response(JSON.stringify({ components: [] })) }) as typeof fetch
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const desk = createChangeDesk()
	joinRuntime(desk)
	const writer = createBomWriter({ fetch: slow, debounceMs: 50, root })
	joinRuntime(writer)
	assert.equal(writer.idle, true)
	const r = state.contract.propose({ field: "parts", value: LOGGER_DESIGN.parts, by: "parts", baseVersion: 0 })
	if (r.status !== "applied") throw new Error(r.status)
	emit(makeEvent("contract.changed", desk.getId(), { field: "parts", version: r.version, revision: r.revision, by: "parts" }), desk.getId())
	assert.equal(writer.idle, false, "a debounced write is pending")
	await writer.whenIdle(10_000)
	assert.ok(existsSync(join(state.outDir, "bom.json")), "the write finished before whenIdle resolved")
	assert.equal(writer.idle, true)
})

test("a run writes bom.json before it returns, even with slow live lookups (7a's race)", { timeout: 60_000 }, async () => {
	const { runDesign, ROOT } = await import("../src/run.ts")
	const { mockScripts } = await import("../src/inference/scripts.ts")
	const slow = (async () => { await new Promise((r) => setTimeout(r, 400)); return new Response(JSON.stringify({ components: [] })) }) as typeof fetch
	const outDir = tempDir()
	await runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, outDir, noHardware: true, review: false, timeoutMs: 50_000, scripts: mockScripts(), bomFetch: slow, env: { root: ROOT, tsci: null, kicad: null, python: null, pio: null } })
	assert.ok(existsSync(join(outDir, "bom.json")), "bom.json missing after the run returned")
	const bom = JSON.parse(readFileSync(join(outDir, "bom.json"), "utf8")) as Bom
	assert.ok(bom.readiness, "the final bom.json has the readiness summary")
})

test("without a lookup (mock run), a line with an LCSC number is at LCSC, and one without is still not listed", () => {
	const r = orderReadiness([
		{ ref: "U1", lcsc: "C2838502", stock: null, priceUsd: null, inStock: null },
		{ ref: "J9", lcsc: null, stock: null, priceUsd: null, inStock: null },
	], "mock run")
	assert.equal(r.summary, "1/2 at LCSC/JLCPCB · stock not checked (mock run) · 1 not listed (J9: no LCSC number)")
	assert.equal(r.warn, true, "a part with no LCSC number still needs attention")
})
