import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { partFactsSection } from "../src/agents/reviewer.ts"
import { CONTRACT_SHAPES } from "../src/agents/roles.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { fixtureContract } from "./fixture.ts"

const catalog = loadCatalog(resolve(import.meta.dirname, ".."))

// Real run 10's reviewer blocked "no nonvolatile storage for history": the contract names the module, not its flash.
test("every MCU module in the catalog states its on-module flash and that it can hold history", () => {
	const mcus = catalog.filter((p) => p.role === "mcu")
	assert.ok(mcus.length > 0)
	for (const m of mcus) {
		assert.equal(typeof m.flashMb, "number", `${m.mpn} has no flashMb`)
		assert.match(m.notes ?? "", /flash/i, `${m.mpn} notes don't mention its flash`)
		assert.match(m.notes ?? "", /history/i, `${m.mpn} notes don't say it can store history`)
	}
	assert.equal(catalog.find((p) => p.mpn === "ESP32-C3-MINI-1")!.flashMb, 4, "datasheet v2.2 Table 1-1: 4 MB Quad SPI")
})

test("the reviewer sees the catalog's facts about the contract's parts", () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	const text = partFactsSection(s).join("\n")
	assert.match(text, /^## Part facts \(from the catalog\)$/m)
	assert.match(text, /^- U1 ESP32-C3-MINI-1: 4 MB on-module flash; .*history.*NVS.*LittleFS/m)
	assert.doesNotMatch(text, /^- U2 /m, "parts without catalog notes are not listed")
})

test("the agents are told the module's flash stores the history", () => {
	assert.match(CONTRACT_SHAPES, /4 MB on-module flash/)
	assert.match(CONTRACT_SHAPES, /history/)
})

// Real runs 15 and 16: "shows charging state" was a review blocker though D2 lights from the charger's CHRG pin.
test("the reviewer learns from the generated wiring that a charge LED shows charging state in hardware", () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	const text = partFactsSection(s).join("\n")
	assert.match(text, /^- D2 KT-0603R \(charge-led\): anode on VBUS, cathode through R\d+ 1k to U4 CHRG \(TP4054-42-SOT25R\)\. CHRG pulls low while the cell charges, so D2 shows charging state in hardware, with no firmware\.$/m)
	const without = fixtureContract()
	without.values = { ...without.values, ...structuredClone(LOGGER_DESIGN) }
	without.values.parts = without.values.parts!.filter((p) => p.role !== "charge-led")
	assert.doesNotMatch(partFactsSection(without).join("\n"), /charge-led/)
})
