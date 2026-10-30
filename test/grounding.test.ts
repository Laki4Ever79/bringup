import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { groundParts, matchSymbol, parseKicadSymbols } from "../src/contract/grounding.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { fixtureContract } from "./fixture.ts"

const catalog = loadCatalog(resolve(import.meta.dirname, ".."))

const pin = (name: string, number: string) => `
			(pin input line (at 0 0 0) (length 2.54)
				(name "${name}" (effects (font (size 1.27 1.27))))
				(number "${number}" (effects (font (size 1.27 1.27)))))`

// Trimmed from KiCad 10's Sensor_Humidity and Regulator_Linear libraries.
const SAMPLE = `(kicad_symbol_lib
	(version 20241209)
	(generator "kicad_symbol_editor")
	(symbol "SHT4x"
		(property "Value" "SHT4x" (at 0 6.35 0))
		(property "ki_keywords" "Sensirion environment digital SHT40 SHT41 SHT45" (at 0 0 0))
		(symbol "SHT4x_0_1" (rectangle (start -5.08 5.08) (end 5.08 -5.08)))
		(symbol "SHT4x_1_1"${pin("SDA", "1")}${pin("SCL", "2")}${pin("VDD", "3")}${pin("VSS", "4")}
		)
	)
	(symbol "AP2204K-1.5"
		(property "Description" "LDO \\"quoted\\" (parens)" (at 0 0 0))
		(symbol "AP2204K-1.5_1_1"${pin("VIN", "1")}${pin("GND", "2")}${pin("EN", "3")}${pin("NC", "4")}${pin("VOUT", "5")}
		)
	)
	(symbol "AP2112K-3.3"
		(extends "AP2204K-1.5")
		(property "Value" "AP2112K-3.3" (at 0 5.715 0))
	)
	(symbol "Reset"
		(symbol "Reset_1_1"${pin("~{RST}", "1")})
	)
)`

test("parseKicadSymbols reads pin names and numbers", () => {
	const symbols = parseKicadSymbols(SAMPLE)
	assert.deepEqual(symbols.SHT4x.pins, [
		{ name: "SDA", number: "1" },
		{ name: "SCL", number: "2" },
		{ name: "VDD", number: "3" },
		{ name: "VSS", number: "4" },
	])
	assert.deepEqual(symbols.SHT4x.keywords, ["Sensirion", "environment", "digital", "SHT40", "SHT41", "SHT45"])
	assert.equal(symbols["SHT4x_1_1"], undefined, "units are not top-level symbols")
})

test("parseKicadSymbols resolves extends to the parent's pins", () => {
	const symbols = parseKicadSymbols(SAMPLE)
	assert.deepEqual(symbols["AP2112K-3.3"].pins.map((p) => p.name), ["VIN", "GND", "EN", "NC", "VOUT"])
})

test("parseKicadSymbols strips KiCad overbar markup from pin names", () => {
	assert.deepEqual(parseKicadSymbols(SAMPLE).Reset.pins, [{ name: "RST", number: "1" }])
})

test("an MPN matches a symbol by prefix, by x wildcard or by keyword", () => {
	const symbols = parseKicadSymbols(SAMPLE)
	assert.equal(matchSymbol("AP2112K-3.3TRG1", symbols), "AP2112K-3.3")
	assert.equal(matchSymbol("SHT40-AD1B-R2", symbols), "SHT4x")
	assert.equal(matchSymbol("SHT45-AD1B-R2", symbols), "SHT4x")
	assert.equal(matchSymbol("BME280", symbols), null)
})

test("the fixture is grounded with no findings", () => {
	assert.deepEqual(groundParts(fixtureContract(), { catalog }), [])
})

test("an invented pin on a part is pin-not-on-part", () => {
	const c = fixtureContract()
	c.values.parts!.find((p) => p.ref === "U2")!.pins.push("SDA2")
	const findings = groundParts(c, { catalog })
	assert.equal(findings.length, 1, JSON.stringify(findings))
	assert.deepEqual([findings[0].partRef, findings[0].kind, findings[0].source], ["U2", "pin-not-on-part", "catalog"])
	assert.match(findings[0].detail, /SDA2/)
})

test("a pin assignment to an invented pin is pin-not-on-part", () => {
	const c = fixtureContract()
	c.values.pins![0].partPin = "SDA2"
	const findings = groundParts(c, { catalog })
	assert.deepEqual(findings.map((f) => [f.partRef, f.kind]), [["U2", "pin-not-on-part"]])
})

test("a GPIO the MCU does not have is pin-not-on-part", () => {
	const c = fixtureContract()
	c.values.pins![1].gpio = 21
	const findings = groundParts(c, { catalog })
	assert.deepEqual(findings.map((f) => [f.partRef, f.kind]), [["U1", "pin-not-on-part"]])
	assert.match(findings[0].detail, /GPIO21/)
})

test("an MPN no source knows is unknown-part", () => {
	const c = fixtureContract()
	c.values.parts!.find((p) => p.ref === "U2")!.mpn = "HDC9999-MADEUP"
	const findings = groundParts(c, { catalog, symbols: parseKicadSymbols(SAMPLE) })
	assert.deepEqual(findings.map((f) => [f.partRef, f.kind, f.source]), [["U2", "unknown-part", "none"]])
})

test("a part outside the catalog is grounded in the KiCad symbol", () => {
	const c = fixtureContract()
	c.values.parts!.push({ ref: "U3", role: "ldo", mpn: "AP2112K-3.3TRG1-NEW", lcsc: null, footprint: "sot23_5", pins: ["VIN", "VOUT", "BYPASS"] })
	const findings = groundParts(c, { catalog, symbols: parseKicadSymbols(SAMPLE) })
	assert.deepEqual(findings.map((f) => [f.partRef, f.kind, f.source]), [["U3", "pin-not-on-part", "kicad"]])
	assert.match(findings[0].detail, /BYPASS/)
})

test("a pin claimed on a part whose source lists no pins is unknown-pin", () => {
	const c = fixtureContract()
	c.values.parts!.push({ ref: "J9", role: "connector", mpn: "NO-PINS-1", lcsc: null, footprint: "pinrow4", pins: ["VBUS"] })
	const bare = [...catalog, { role: "connector", mpn: "NO-PINS-1", lcsc: null, footprint: "pinrow4", pins: [], stock: null, priceUsd: null, inStock: null }]
	const findings = groundParts(c, { catalog: bare })
	assert.deepEqual(findings.map((f) => [f.partRef, f.kind, f.source]), [["J9", "unknown-pin", "catalog"]])
})

test("USB-C pins are grounded in the catalog's named pins", () => {
	const c = fixtureContract()
	c.values.parts!.push({ ref: "J1", role: "usb-c", mpn: "TYPE-C-31-M-12", lcsc: "C165948", footprint: "usbcmidmount", pins: ["VBUS", "CC1", "DP", "SBU1"] })
	const findings = groundParts(c, { catalog })
	assert.deepEqual(findings.map((f) => [f.partRef, f.kind, f.source]), [["J1", "pin-not-on-part", "catalog"]])
})

test("a pin assignment to a part that is not in the contract is unknown-part", () => {
	const c = fixtureContract()
	c.values.pins![0].partRef = "U9"
	const findings = groundParts(c, { catalog })
	assert.deepEqual(findings.map((f) => [f.partRef, f.kind, f.source]), [["U9", "unknown-part", "none"]])
})
