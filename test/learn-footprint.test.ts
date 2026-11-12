import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { findFootprint, kicadPadCount } from "../src/learn/footprint.ts"

const FIX = resolve(import.meta.dirname, "../examples/learn")
const easyeda = (file: string | null) =>
	(async (u: string | URL | Request) => (file && String(u).includes("easyeda.com/api/products/") ? new Response(readFileSync(join(FIX, file))) : new Response("{}", { status: 404 }))) as unknown as typeof fetch
const PINS = "SD,GAIN,DIN,BCLK,LRCLK,GND,VDD,OUTP,OUTN,GND".split(",")

test("an EasyEDA footprint whose pad count matches the pins is the footprint fact", async () => {
	const f = await findFootprint({ lcsc: "C999001", pins: PINS }, { fetchImpl: easyeda("easyeda-c999001.json") })
	assert.equal(f?.field, "footprint")
	assert.equal(f?.value, "easyeda:C999001")
	assert.equal(f?.critical, true)
	assert.equal(f?.check, "pad-count")
	assert.match(f?.origin ?? "", /easyeda\.com\/api\/products\/C999001/)
})

test("a pad count that doesn't match the pins gives no footprint", async () => {
	assert.equal(await findFootprint({ lcsc: "C999001", pins: PINS.slice(0, 6) }, { fetchImpl: easyeda("easyeda-c999001.json") }), null)
})

test("without an LCSC id, a KiCad library footprint named for the package", async () => {
	const kicadIndex = ["Package_DFN_QFN:QFN-16-1EP_3x3mm_P0.5mm_EP1.7x1.7mm", "Package_DFN_QFN:QFN-10-1EP_3x3mm_P0.5mm_EP1.65x2.38mm", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm"]
	const f = await findFootprint({ packageName: "QFN-10", pins: PINS }, { fetchImpl: easyeda(null), kicadIndex })
	assert.equal(f?.value, "kicad:Package_DFN_QFN:QFN-10-1EP_3x3mm_P0.5mm_EP1.65x2.38mm")
	assert.equal(await findFootprint({ packageName: "QFN-12", pins: PINS }, { fetchImpl: easyeda(null), kicadIndex }), null)
})

test("KiCad names give their pad count, exposed pad included", () => {
	assert.equal(kicadPadCount("QFN-10-1EP_3x3mm_P0.5mm"), 11)
	assert.equal(kicadPadCount("SOIC-8_3.9x4.9mm_P1.27mm"), 8)
	assert.equal(kicadPadCount("R_0402_1005Metric"), null)
})
