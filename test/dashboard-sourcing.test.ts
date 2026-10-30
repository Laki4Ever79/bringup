import assert from "node:assert/strict"
import { test } from "node:test"
import { safeUrl, sourcingRows } from "../src/dashboard/model.js"

test("only absolute http(s) links reach an href", () => {
	assert.equal(safeUrl("https://www.lcsc.com/product-detail/C2838502.html"), "https://www.lcsc.com/product-detail/C2838502.html")
	assert.equal(safeUrl("javascript:alert(1)"), null)
	assert.equal(safeUrl("//evil.example/x"), null)
	assert.equal(safeUrl("data:text/html,hi"), null)
	assert.equal(safeUrl(undefined), null)
})

test("sources show live stock and price where known, 'not checked' otherwise, never a made-up number", () => {
	const item = {
		ref: "U1",
		mpn: "ESP32-C3-MINI-1",
		sources: [
			{ supplier: "LCSC/JLCPCB", url: "https://www.lcsc.com/product-detail/C2838502.html", stock: 22598, priceUsd: 3.05 },
			{ supplier: "Digi-Key", url: "https://www.digikey.com/en/products/result?keywords=ESP32-C3-MINI-1", stock: null, priceUsd: null, note: "search link, not checked" },
			{ supplier: "Mouser", url: "javascript:void(0)", stock: null, priceUsd: null },
		],
		alternatives: [{ mpn: "ESP32-C3-WROOM-02", lcsc: "C2934560", stock: 0, priceUsd: 2.8, inStock: false }, { mpn: "X", lcsc: null, stock: null, priceUsd: null, inStock: null }],
	}
	const r = sourcingRows(item)
	assert.deepEqual(r.sources.map((s: any) => [s.supplier, s.stock, s.price, s.url !== null]), [
		["LCSC/JLCPCB", "23k in stock", "$3.05", true],
		["Digi-Key", "not checked", "not checked", true],
		["Mouser", "not checked", "not checked", false],
	])
	assert.equal(r.sources[1].note, "search link, not checked")
	assert.deepEqual(r.alternatives.map((a: any) => [a.mpn, a.stock, a.price]), [["ESP32-C3-WROOM-02", "out of stock", "$2.80"], ["X", "not checked", "not checked"]])
	assert.deepEqual(sourcingRows({ ref: "R1", mpn: "0402" }), { sources: [], alternatives: [] }, "older bom.json without sourcing")
})
