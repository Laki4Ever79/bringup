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
	assert.doesNotMatch(text, /^- U3 /m, "parts without catalog notes are not listed")
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

test("the reviewer learns what the product firmware does on each reading, from the template's own defines", async () => {
	const { firmwareFacts } = await import("../src/agents/reviewer.ts")
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	s.values.requirements = { ...s.values.requirements!, dutyCycle: { activeMs: 100, periodS: 300, sleepUa: 5 } }
	const text = firmwareFacts(s).join("\n")
	assert.match(text, /^- Firmware \(product build of templates\/fw\): on each wake it reads the sensor, stores the reading in a ring buffer on the module's flash \(LittleFS, the last 8640 readings: 30 days at 300 s\), blinks the status LED 20 ms \(a double blink if the sensor fails\), then advertises over BLE for 70 ms \(activeMs minus the reading\), then deep-sleeps 300 s \(requirements\.dutyCycle\.periodS\)\. The behavior field/m)
	assert.match(text, /^- Firmware BLE: a GATT service with the latest reading, the history count and the history read newest first in chunks of 100 records; a phone that connects keeps the device awake until it disconnects or 30 s pass\.$/m)
})

// Real run 17's review blocked on sensor accuracy and on "no USB-UART bridge for flashing": both are datasheet facts.
test("the reviewer gets each sensor's datasheet accuracy and the module's native USB flashing", () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	const text = partFactsSection(s).join("\n")
	assert.match(text, /^- U1 ESP32-C3-MINI-1: .*USB Serial\/JTAG .*GPIO18 \(USB_D-\) and GPIO19 \(USB_D\+\).*no USB-UART bridge/m)
	assert.match(text, /^- U2 SHT40-AD1B-R2: typical accuracy ±1\.8 %RH and ±0\.2 °C/m)
	const shtc3 = catalog.find((p) => p.mpn === "SHTC3-TR-2.5KS")!
	assert.match(shtc3.notes ?? "", /^typical accuracy ±2 %RH and ±0\.2 °C/)
})

test("the firmware fact says behavior only drives the bench build", async () => {
	const { firmwareFacts } = await import("../src/agents/reviewer.ts")
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	assert.match(firmwareFacts(s).join("\n"), /The behavior field \(blinkMs, tiltBlinkMs, tiltDeg\) only drives the bench build; the product build ignores it\./)
})
