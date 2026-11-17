// jlcsearch stopped carrying stock (17 Nov 2026: null for every part, stock_checked_at 3 Nov), so every report said
// "stock unknown" (real run 20b: 16 lines). The stock is read from LCSC's own product page instead.
import { test } from "node:test"
import assert from "node:assert/strict"
import { lookupLcsc, stockFromLcscPage } from "../src/tools/parts-search.ts"

const page = `{"productCode":"C111","stockNumber":905},{"x":1,"productCode":"C15850","productModel":"CL21A106KAYNNNE","stockNumber":1621320},{"productCode":"C222","stockNumber":18880}`

test("the part's own stockNumber, not a neighbour's; none for a part the page doesn't list", () => {
	assert.equal(stockFromLcscPage(page, "C15850"), 1621320)
	assert.equal(stockFromLcscPage(page, "C999"), null)
})

test("a jlcsearch hit with null stock takes LCSC's page stock; a number from jlcsearch is kept", async () => {
	const fake = (stock: number | null) => (async (url: string) => {
		if (url.includes("jlcsearch")) return new Response(JSON.stringify({ components: [{ lcsc: 15850, stock, price: 0.0422, is_basic: true }] }))
		return new Response(page)
	}) as unknown as typeof fetch
	assert.deepEqual(await lookupLcsc("C15850", { fetch: fake(null) }), { stock: 1621320, priceUsd: 0.0422, inStock: true, basic: true, preferred: false })
	assert.equal((await lookupLcsc("C15850", { fetch: fake(42) })).stock, 42)
})
