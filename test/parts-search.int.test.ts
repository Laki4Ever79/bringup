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

test("live ESP32-C3-MINI-1 lookup returns numeric stock and price", { skip, timeout: 30_000 }, async () => {
	// The live service occasionally takes >5 s; one patient retry keeps this test about the API, not the network.
	let [mcu] = await searchParts("mcu")
	if (mcu.stock === null) [mcu] = await searchParts("mcu", { timeoutMs: 15_000 })
	assert.equal(mcu.lcsc, "C2838502")
	assert.equal(typeof mcu.stock, "number", JSON.stringify(mcu))
	assert.equal(typeof mcu.priceUsd, "number", JSON.stringify(mcu))
	assert.equal(mcu.inStock, mcu.stock! > 0)
})
