// The build package's parts list (src/package/build.ts, robot-parts.ts): a bulk carton never counts as a build's cost.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

test("bulk-carton shop links carry their pack size, and the M2.5 nut has a small pack first", () => {
	const cat = JSON.parse(readFileSync(new URL("../catalog/mechanics.json", import.meta.url), "utf8")) as { hardware: { mpn: string; buy?: { supplier: string; url: string; packQty?: number }[] }[] }
	const links = cat.hardware.flatMap((h) => (h.buy ?? []).map((b) => ({ mpn: h.mpn, ...b })))
	for (const l of links.filter((x) => x.supplier === "Fastener SuperStore")) assert.ok((l.packQty ?? 1) >= 1000, `${l.mpn}: its carton size`)
	const nut = cat.hardware.find((h) => h.mpn.startsWith("M2.5 hex nut"))!
	assert.equal(nut.buy![0].url, "https://www.pololu.com/product/1967")
	assert.equal(nut.buy![0].packQty, 25)
})

test("the package command is wired into the CLI", () => {
	const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")
	assert.match(main, /argv\[0\] === "package"/)
	assert.match(main, /package <contract\.json> <outDir>/)
})
