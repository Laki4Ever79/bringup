import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { loadCatalog, searchParts } from "../src/tools/parts-search.ts"

const root = resolve(import.meta.dirname, "..")

// Answers /api/search?q=C<n> the way jlcsearch does, from a table of lcsc -> {stock, price}.
function fakeFetch(table: Record<string, { stock: number | null; price: number | null }>, calls: string[] = []): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = new URL(String(input))
		calls.push(url.toString())
		const q = url.searchParams.get("q") ?? ""
		const hit = table[q]
		const components = hit ? [{ lcsc: Number(q.slice(1)), mfr: "x", stock: hit.stock, price: hit.price }] : []
		return new Response(JSON.stringify({ components }), { status: 200, headers: { "content-type": "application/json" } })
	}) as typeof fetch
}

test("catalog loads every vetted part with no live data yet", () => {
	const catalog = loadCatalog(root)
	assert.ok(catalog.some((p) => p.mpn === "ESP32-C3-MINI-1" && p.lcsc === "C2838502"))
	for (const p of catalog) assert.deepEqual([p.stock, p.priceUsd, p.inStock], [null, null, null])
})

test("search enriches the role's parts with live stock and price", async () => {
	const calls: string[] = []
	const parts = await searchParts("mcu", { root, fetch: fakeFetch({ C2838502: { stock: 22598, price: 3.05 } }, calls) })
	assert.equal(parts.length, 1)
	assert.equal(parts[0].mpn, "ESP32-C3-MINI-1")
	assert.deepEqual([parts[0].stock, parts[0].priceUsd, parts[0].inStock], [22598, 3.05, true])
	assert.match(calls[0], /\/api\/search\?q=C2838502/)
})

test("zero stock is reported as out of stock", async () => {
	const parts = await searchParts("ldo", { root, fetch: fakeFetch({ C51118: { stock: 0, price: 0.18 } }) })
	assert.deepEqual([parts[0].stock, parts[0].inStock], [0, false])
})

test("a part jlcsearch does not know keeps nulls", async () => {
	const parts = await searchParts("sensor", { root, fetch: fakeFetch({}) })
	assert.deepEqual(parts.map((p) => p.mpn), ["SHT40-AD1B-R2", "SHTC3-TR-2.5KS"])
	for (const p of parts) assert.deepEqual([p.stock, p.priceUsd, p.inStock], [null, null, null])
})

test("a failed fetch returns the catalog entries with nulls instead of throwing", async () => {
	const failing = (async () => { throw new TypeError("fetch failed") }) as typeof fetch
	const parts = await searchParts("led", { root, fetch: failing })
	assert.equal(parts[0].mpn, "KT-0603R")
	assert.deepEqual([parts[0].stock, parts[0].priceUsd, parts[0].inStock], [null, null, null])
})

test("a server error returns nulls", async () => {
	const broken = (async () => new Response("oops", { status: 502 })) as typeof fetch
	const parts = await searchParts("led", { root, fetch: broken })
	assert.equal(parts[0].stock, null)
})

test("a hung lookup times out to nulls", async () => {
	const hung = ((_: unknown, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch
	const start = Date.now()
	const parts = await searchParts("capacitor", { root, fetch: hung, timeoutMs: 50 })
	assert.equal(parts[0].stock, null)
	assert.ok(Date.now() - start < 2000)
})

test("an unknown role gives no parts", async () => {
	assert.deepEqual(await searchParts("flux-capacitor", { root, fetch: fakeFetch({}) }), [])
})

test("live lookups are cached for the process", async () => {
	const calls: string[] = []
	const resistors = loadCatalog(root).filter((p) => p.role === "resistor")
	const f = fakeFetch({ ...Object.fromEntries(resistors.map((p) => [p.lcsc!, { stock: 7, price: 0.001 }])), C25744: { stock: 5, price: 0.001 } }, calls)
	const first = await searchParts("resistor", { root, fetch: f })
	const again = await searchParts("resistor", { root, fetch: f })
	assert.equal(calls.length, first.length) // one lookup per catalog resistor, none repeated
	assert.equal(again.find((p) => p.lcsc === "C25744")?.stock, 5)
})
