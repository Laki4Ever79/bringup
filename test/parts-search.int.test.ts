import { test } from "node:test"
import assert from "node:assert/strict"
import { JLCSEARCH, searchParts } from "../src/tools/parts-search.ts"

async function online(): Promise<boolean> {
	try {
		const res = await fetch(JLCSEARCH, { method: "HEAD", signal: AbortSignal.timeout(5000) })
		return res.status < 500
	} catch {
		return false
	}
}
const skip = (await online()) ? false : "jlcsearch unreachable"

test("live ESP32-C3-MINI-1 lookup returns a price, and stock when the service has it", { skip, timeout: 30_000 }, async () => {
	// The live service occasionally takes >5 s; one patient retry keeps this test about the API, not the network.
	let [mcu] = await searchParts("mcu")
	if (mcu.priceUsd === null) [mcu] = await searchParts("mcu", { timeoutMs: 15_000 })
	assert.equal(mcu.lcsc, "C2838502")
	// jlcsearch sometimes returns stock: null with a price (seen 30 Oct for C2838502 and C51118).
	assert.ok(mcu.stock === null || typeof mcu.stock === "number", JSON.stringify(mcu))
	assert.equal(typeof mcu.priceUsd, "number", JSON.stringify(mcu))
	assert.equal(mcu.inStock, mcu.stock === null ? null : mcu.stock > 0)
})
