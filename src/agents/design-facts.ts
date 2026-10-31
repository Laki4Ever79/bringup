import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { generatedNets, supportParts } from "../codegen/circuit.ts"
import { bleAdvertiseMs } from "../codegen/firmware.ts"
import { dutyCycleCheckLines, estimatePower, powerBudgetLines } from "../contract/power.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { loadCatalog } from "../tools/parts-search.ts"

// The facts and computed checks about the current contract, one source for everyone who judges or changes it: the
// reviewer reads them at the final review, and every designer turn gets them recomputed from the contract as it is
// then. Before, only the reviewer saw them, and the designers kept missing what it blocked on (charge LED, flash
// storage, battery life, supply range, the behavior field).
export function designFacts(s: ContractSnapshot, brief: string): string[] {
	const power = estimatePower(s, brief)
	return [
		...partFactsSection(s),
		...fieldMeaningLines(s),
		"",
		"## Power budget (computed in code from the contract and the brief, not by a model)",
		...powerBudgetLines(power),
		...dutyCycleCheckLines(power, s),
	]
}

// What contract fields mean where they are easy to misread (real run 20: behavior read as the product LED).
export function fieldMeaningLines(s: ContractSnapshot): string[] {
	return s.values.behavior ? ["- The behavior field is the bench demo build's blink and tilt settings, not the product's status LED; the product firmware ignores it (see the firmware facts above)."] : []
}

// Catalog facts about the contract's parts that the contract itself doesn't carry, e.g. that the MCU module's 4 MB
// flash holds the reading history (real run 10's reviewer blocked "no nonvolatile storage").
// A charge LED the board generator wires from VBUS to the charger's CHRG pin shows charging state by itself. Derived
// from the generated wiring, so it is only said when the board really wires it (real runs 15 and 16 blocked on it).
export function chargeLedFacts(s: ContractSnapshot): string[] {
	const parts = s.values.parts ?? []
	const vbus = generatedNets(s).get("VBUS") ?? []
	return supportParts(s).flatMap((sp) => {
		const led = "ref" in sp.a ? parts.find((p) => p.ref === (sp.a as { ref: string }).ref && p.role === "charge-led") : undefined
		const to = "ref" in sp.b ? (sp.b as { ref: string; pin: string }) : undefined
		const charger = to && to.pin === "CHRG" ? parts.find((p) => p.ref === to.ref && p.role === "charger") : undefined
		if (!led || !charger || !vbus.includes(`${led.ref}.A`)) return []
		return [`- ${led.ref} ${led.mpn} (charge-led): anode on VBUS, cathode through ${sp.ref} ${sp.spec.value} to ${charger.ref} CHRG (${charger.mpn}). CHRG pulls low while the cell charges, so ${led.ref} shows charging state in hardware, with no firmware.`]
	})
}

// What the product firmware does on each reading, read from the template's own constants and the contract's period,
// so it stays true if either changes.
export function firmwareFacts(s: ContractSnapshot): string[] {
	const main = readFileSync(resolve(import.meta.dirname, "../../templates/fw/src/main.cpp"), "utf8")
	const num = (re: RegExp) => Number(re.exec(main)?.[1] ?? NaN)
	const blinkMs = num(/READING_BLINK_MS = (\d+)/)
	const contractDays = s.values.requirements?.historyDays
	const days = contractDays ?? num(/#define HISTORY_DAYS (\d+)/)
	const daysFrom = contractDays !== undefined ? "requirements.historyDays" : "the template's default; the contract has no historyDays"
	const contractPeriod = s.values.requirements?.dutyCycle?.periodS
	const periodS = contractPeriod !== undefined && contractPeriod > 0 ? Math.round(contractPeriod) : num(/#define DUTY_PERIOD_S (\d+)/)
	const chunk = num(/HISTORY_CHUNK = (\d+)/)
	const connectedS = num(/BLE_CONNECTED_MAX_MS = (\d+)/) / 1000
	if (![blinkMs, days, periodS, chunk, connectedS].every(Number.isFinite)) return []
	const from = contractPeriod !== undefined && contractPeriod > 0 ? "requirements.dutyCycle.periodS" : "the template's default; the contract has no duty cycle"
	const duty = s.values.requirements?.dutyCycle
	const advertise = duty ? `${bleAdvertiseMs(duty)} ms (activeMs minus the reading)` : `${num(/#define BLE_ADVERTISE_MS (\d+)/)} ms (the template's default; the contract has no duty cycle)`
	// The firmware has a sensor exactly when pins.h has both I2C pins (main.cpp HAS_SENSOR), and wakes early on a pin
	// named BUTTON on GPIO0..5.
	const pins = s.values.pins ?? []
	const button = pins.find((p) => p.signal === "BUTTON" && p.gpio >= 0 && p.gpio <= 5)
	const buttonFact = button
		? `- Firmware button: BUTTON on GPIO${button.gpio} wakes it from deep sleep early (pressed = low, to GND). A button wake runs the same wake as the timer: it blinks and starts BLE advertising at once, not at the next period.`
		: "- Firmware button: the firmware wakes on a pin named exactly BUTTON on GPIO0..5 (the ESP32-C3's deep-sleep wake pins); this design has none, so no button wakes it."
	if (!(pins.some((p) => p.signal === "I2C_SDA") && pins.some((p) => p.signal === "I2C_SCL")))
		return [
			`- Firmware (product build of templates/fw): the design has no sensor (no I2C_SDA/I2C_SCL pins), so on each wake it reads nothing and stores nothing: it blinks the status LED ${blinkMs} ms, then advertises over BLE for ${advertise}, then deep-sleeps ${periodS} s (${from}). The behavior field (blinkMs, tiltBlinkMs, tiltDeg) only drives the bench build; the product build ignores it.`,
			`- Firmware BLE: the same GATT service as with a sensor, but the latest reading reads 0xFFFFFFFE ("no sensor") and the history stays empty; a phone that connects keeps the device awake until it disconnects or ${connectedS} s pass.`,
			buttonFact,
		]
	return [
		`- Firmware (product build of templates/fw): on each wake it reads the sensor, stores the reading in a ring buffer on the module's flash (LittleFS, the last ${Math.floor((days * 86400) / periodS)} readings: ${days} days at ${periodS} s (${daysFrom})), blinks the status LED ${blinkMs} ms (a double blink if the sensor fails), then advertises over BLE for ${advertise}, then deep-sleeps ${periodS} s (${from}). The behavior field (blinkMs, tiltBlinkMs, tiltDeg) only drives the bench build; the product build ignores it.`,
		`- Firmware BLE: a GATT service with the latest reading, the history count and the history read newest first in chunks of ${chunk} records; a phone that connects keeps the device awake until it disconnects or ${connectedS} s pass.`,
		buttonFact,
	]
}

export function partFactsSection(s: ContractSnapshot): string[] {
	const catalog = loadCatalog(resolve(import.meta.dirname, "../.."))
	const facts = (s.values.parts ?? []).flatMap((p) => {
		const notes = catalog.find((c) => c.mpn.toUpperCase() === p.mpn.toUpperCase())?.notes
		return notes ? [`- ${p.ref} ${p.mpn}: ${notes}`] : []
	})
	return ["## Part facts (from the catalog)", ...(facts.length ? facts : ["- none"]), ...chargeLedFacts(s), ...firmwareFacts(s)]
}
