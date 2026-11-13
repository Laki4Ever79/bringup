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

// Real KiCad names (Package_SO, Package_SON, Package_TO_SOT_SMD) around the families datasheets print.
const INDEX = [
	"Package_SO:MSOP-8-1EP_3x3mm_P0.65mm_EP1.68x1.88mm_ThermalVias",
	"Package_SO:HVSSOP-8-1EP_3x3mm_P0.65mm_EP1.57x1.89mm_ThermalVias",
	"Package_SO:VSSOP-8_2.3x2mm_P0.5mm",
	"Package_SO:VSSOP-8_3x3mm_P0.65mm",
	"Package_SO:HVSSOP-8-1EP_3x3mm_P0.65mm_EP1.57x1.89mm",
	"Package_SO:MSOP-8_3x3mm_P0.65mm",
	"Package_SON:VSON-8-1EP_3x3mm_P0.65mm_EP1.65x2.4mm",
	"Package_TO_SOT_SMD:SOT-23-5",
	"Package_TO_SOT_SMD:SOT-23",
	"Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
]
const pins = (n: number) => Array.from({ length: n }, (_, i) => `P${i + 1}`)

test("the package's family is found inside how a datasheet prints it, and the plain variant is preferred", async () => {
	const f = await findFootprint({ packageName: "8-Pin HVSSOP", pins: pins(8), bodyMm: [3, 3] }, { fetchImpl: easyeda(null), kicadIndex: INDEX })
	assert.equal(f?.value, "kicad:Package_SO:HVSSOP-8-1EP_3x3mm_P0.65mm_EP1.57x1.89mm")
	assert.equal((await findFootprint({ packageName: "MSOP-8 PowerPAD (DGN)", pins: pins(8) }, { fetchImpl: easyeda(null), kicadIndex: INDEX }))?.value, "kicad:Package_SO:MSOP-8-1EP_3x3mm_P0.65mm_EP1.68x1.88mm_ThermalVias")
	assert.equal((await findFootprint({ packageName: "MSOP-8", pins: pins(8) }, { fetchImpl: easyeda(null), kicadIndex: INDEX }))?.value, "kicad:Package_SO:MSOP-8_3x3mm_P0.65mm", "no exposed pad named: the plain one")
})

test("the body size picks among same-family footprints, and rules out a wrong one", async () => {
	assert.equal((await findFootprint({ packageName: "VSSOP-8", pins: pins(8), bodyMm: [2.3, 2] }, { fetchImpl: easyeda(null), kicadIndex: INDEX }))?.value, "kicad:Package_SO:VSSOP-8_2.3x2mm_P0.5mm")
	assert.equal((await findFootprint({ packageName: "VSSOP-8", pins: pins(8), bodyMm: [3.0, 3.0] }, { fetchImpl: easyeda(null), kicadIndex: INDEX }))?.value, "kicad:Package_SO:VSSOP-8_3x3mm_P0.65mm")
	assert.equal(await findFootprint({ packageName: "VSSOP-8", pins: pins(8), bodyMm: [5, 6] }, { fetchImpl: easyeda(null), kicadIndex: INDEX }), null)
})

test("a family with a number in its name (SOT-23-5) keeps it", async () => {
	assert.equal((await findFootprint({ packageName: "SOT-23-5", pins: pins(5) }, { fetchImpl: easyeda(null), kicadIndex: INDEX }))?.value, "kicad:Package_TO_SOT_SMD:SOT-23-5")
	assert.equal(kicadPadCount("SOT-23-5"), 5)
})

const SO32 = ["Package_SO:HTSSOP-32-1EP_6.1x11mm_P0.65mm_EP5.2x11mm_Mask4.11x4.36mm", "Package_SO:HTSSOP-32-1EP_6.1x11mm_P0.65mm_EP5.2x11mm_Mask4.11x4.36mm_ThermalVias", "Package_SO:TSSOP-32_6.1x11mm_P0.65mm", "Package_SO:TSSOP-32_8x11mm_P0.65mm"]

test("the exposed-pad fact decides: no pad underneath takes the pad-less land pattern of the same body", async () => {
	const none = await findFootprint({ packageName: "HTSSOP (32)", pins: pins(32), bodyMm: [11, 6.2], exposedPad: false }, { fetchImpl: easyeda(null), kicadIndex: SO32 })
	assert.equal(none?.value, "kicad:Package_SO:TSSOP-32_6.1x11mm_P0.65mm")
	const pad = await findFootprint({ packageName: "HTSSOP (32)", pins: pins(32), bodyMm: [11, 6.2], exposedPad: true }, { fetchImpl: easyeda(null), kicadIndex: SO32 })
	assert.equal(pad?.value, "kicad:Package_SO:HTSSOP-32-1EP_6.1x11mm_P0.65mm_EP5.2x11mm_Mask4.11x4.36mm")
	assert.equal(await findFootprint({ packageName: "MSOP-8", pins: pins(8), exposedPad: true }, { fetchImpl: easyeda(null), kicadIndex: ["Package_SO:MSOP-8_3x3mm_P0.65mm"] }), null, "a pad the land pattern lacks")
})
