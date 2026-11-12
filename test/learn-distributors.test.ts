import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Budget } from "../src/learn/budget.ts"
import { createDocStore } from "../src/learn/docs.ts"
import { digikey, distributorsFrom, findListings, lcsc, mouser, sameMpn, webFind, type Distributor } from "../src/learn/distributors.ts"

const FIX = resolve(import.meta.dirname, "../examples/learn")
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("lcsc counts only a result with the exact mpn", async () => {
	const f = (async () => json({ components: [{ lcsc: 460310, mfr: "AP2112K-1.2TRG1", package: "SOT-25", is_basic: false, stock: 2070, price: 0.1554 }] })) as unknown as typeof fetch
	assert.equal(await lcsc(f).lookup("AP2112K-3.3TRG1"), null)
	const hit = await lcsc(f).lookup("AP2112K-1.2TRG1")
	assert.deepEqual({ sku: hit?.sku, stock: hit?.stock, price: hit?.priceUsd, assembler: hit?.assemblerStocked, pkg: hit?.package }, { sku: "C460310", stock: 2070, price: 0.1554, assembler: true, pkg: "SOT-25" })
})

test("mpn comparison ignores case and packaging suffixes", () => {
	assert.ok(sameMpn("max98357aete+t", "MAX98357AETE+T"))
	assert.ok(sameMpn("TPS7A0233PDBVR", "TPS7A0233PDBVR#PBF"))
	assert.ok(!sameMpn("AP2112K-1.2", "AP2112K-3.3"))
})

test("keyed distributors appear only with their keys", () => {
	const f = fetch
	assert.equal(digikey({}, f), null)
	assert.equal(mouser({}, f), null)
	assert.deepEqual(distributorsFrom({}, f).map((d) => d.name), ["lcsc"])
	assert.deepEqual(distributorsFrom({ DIGIKEY_CLIENT_ID: "a", DIGIKEY_CLIENT_SECRET: "b", MOUSER_API_KEY: "c" }, f).map((d) => d.name), ["lcsc", "digikey", "mouser"])
})

test("mouser reads stock, price, datasheet and photo", async () => {
	const f = (async () =>
		json({ Errors: [], SearchResults: { Parts: [{ ManufacturerPartNumber: "BRG-SPK40", Manufacturer: "Bringup Audio", MouserPartNumber: "123-BRGSPK40", AvailabilityInStock: "420", PriceBreaks: [{ Quantity: 1, Price: "$2.10" }], DataSheetUrl: "https://example.com/brg-spk40.pdf", ImagePath: "https://example.com/spk.jpg", ProductDetailUrl: "https://example.com/p" }] } })) as unknown as typeof fetch
	const l = await mouser({ MOUSER_API_KEY: "k" }, f)!.lookup("BRG-SPK40")
	assert.deepEqual({ stock: l?.stock, price: l?.priceUsd, ds: l?.datasheetUrl, photo: l?.photoUrl, assembler: l?.assemblerStocked }, { stock: 420, price: 2.1, ds: "https://example.com/brg-spk40.pdf", photo: "https://example.com/spk.jpg", assembler: false })
})

test("digikey gets a token, then the product", async () => {
	const urls: string[] = []
	const f = (async (u: string | URL | Request) => {
		urls.push(String(u))
		if (String(u).includes("oauth2/token")) return json({ access_token: "t", expires_in: 600 })
		return json({ Product: { ManufacturerProductNumber: "BRG-AMP1", Manufacturer: { Name: "Bringup Semi" }, QuantityAvailable: 50, UnitPrice: 0.9, DatasheetUrl: "https://example.com/brg-amp1.pdf", PhotoUrl: "https://example.com/amp.jpg", ProductUrl: "https://example.com/a" } })
	}) as unknown as typeof fetch
	const l = await digikey({ DIGIKEY_CLIENT_ID: "a", DIGIKEY_CLIENT_SECRET: "b" }, f)!.lookup("BRG-AMP1")
	assert.equal(l?.stock, 50)
	assert.equal(l?.datasheetUrl, "https://example.com/brg-amp1.pdf")
	assert.ok(urls[0].includes("oauth2/token"))
})

test("a failing distributor doesn't stop the others", async () => {
	const broken: Distributor = { name: "broken", lookup: async () => { throw new Error("down") } }
	const ok: Distributor = { name: "ok", lookup: async (mpn) => ({ distributor: "ok", mpn, stock: 1, priceUsd: 1, assemblerStocked: false }) }
	assert.deepEqual((await findListings("X", [broken, ok])).map((l) => l.distributor), ["ok"])
})

test("web find keeps a datasheet only if it names the mpn", async () => {
	const files: Record<string, string> = { "brg-amp1.pdf": "brg-amp1.pdf" }
	const f = (async (u: string | URL | Request) => {
		const url = String(u)
		if (url.includes("api.openai.com")) return json({ output_text: "Datasheet: https://example.com/brg-amp1.pdf", output: [{ type: "message", content: [{ type: "output_text", text: "Datasheet: https://example.com/brg-amp1.pdf" }] }], usage: { input_tokens: 100, output_tokens: 20 } })
		const name = Object.keys(files).find((k) => url.endsWith(k))
		return name ? new Response(readFileSync(join(FIX, files[name])), { status: 200 }) : new Response("no", { status: 404 })
	}) as unknown as typeof fetch
	const store = createDocStore(mkdtempSync(join(tmpdir(), "web-")), f)
	const deps = { env: { OPENAI_API_KEY: "k" }, fetchImpl: f, budget: new Budget(1), store, onUsage: () => {} }
	const hit = await webFind("BRG-AMP1", deps)
	assert.equal(hit?.datasheetUrl, "https://example.com/brg-amp1.pdf")
	assert.equal(hit?.distributor, "manufacturer")
	assert.equal(await webFind("BRG-OTHER9", deps), null)
})

test("a datasheet names a part by its base number, without the ordering suffix", async () => {
	const { namesPart } = await import("../src/learn/distributors.ts")
	assert.ok(namesPart("TPA2005D1DGN", "The TPA2005D1 is a 1.4-W high-efficiency filter-free class-D audio amplifier"))
	assert.ok(namesPart("PAM8302AASCR", "PAM8302A 2.5W MONO CLASS-D AUDIO AMPLIFIER"))
	assert.ok(!namesPart("TPA2005D1DGN", "The TPA2012D2 is a stereo amplifier"))
	assert.ok(!namesPart("TPA2005D1DGN", "TPA is a family"), "a short prefix isn't a name")
})

test("candidate part numbers lose a maker's name written in front", async () => {
	const { parseCandidates } = await import("../src/learn/runtime.ts")
	assert.deepEqual(parseCandidates('{"parts":[{"manufacturer":"Texas Instruments","mpn":"Texas Instruments TPA2005D1DGN"},{"manufacturer":"Diodes Incorporated","mpn":"PAM8302AASCR"}]}'), ["TPA2005D1DGN", "PAM8302AASCR"])
	assert.deepEqual(parseCandidates('```json\n{"mpns":["MAX98357AETE+T"]}\n```'), ["MAX98357AETE+T"])
	assert.deepEqual(parseCandidates("not json"), [])
})
