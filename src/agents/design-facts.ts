import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { generatedNets, supportParts } from "../codegen/circuit.ts"
import { addedForYouFactLines } from "../contract/added.ts"
import { linkFactLines } from "../contract/links.ts"
import { bleAdvertiseMs } from "../codegen/firmware.ts"
import { dutyCycleCheckLines, estimatePower, powerBudgetLines } from "../contract/power.ts"
import { enclosureMode, type ContractSnapshot } from "../contract/types.ts"
import { modelFactLines } from "../contract/model.ts"
import { expectedCurrents, probeableNets } from "../contract/testkit.ts"
import { testPoints } from "../codegen/circuit.ts"
import { caseFactLines } from "../contract/case.ts"
import { connectivityOf } from "../contract/connectivity.ts"
import { DATA_FORMAT } from "../codegen/data-format.ts"
import { spaceFactLines } from "../contract/space.ts"
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
		...testFactLines(s),
		...addedForYouFactLines(s),
		...linkFactLines(s),
		...(s.values.outline ? ["", "## Space (computed in code: the smallest board the parts place on, the case's contents)", ...spaceFactLines(s).map((l) => `- ${l}`)] : []),
		...(s.values.outline && enclosureMode(s.values) === "case" ? ["", "## The case (computed in code from the outline, the connectors and the case field)", ...caseFactLines(s).map((l) => `- ${l}`)] : []),
		...(enclosureMode(s.values) !== "case" ? ["", "## The case", enclosureMode(s.values) === "none" ? '- None: a bare board (requirements.enclosure "none"). No case is built or checked; the case field, if any, is ignored.' : '- None of ours: the board goes into the engineer\'s own housing (requirements.enclosure "own"). No case is built or checked; Bringup writes interface.md (outline, mounting holes, openings, buttons, lights, vents, antenna keep-out, underside pads, label) for whoever designs the housing.'] : []),
		...(s.values.model ? ["", "## The on-device model (checked in code against the flash and RAM the firmware leaves, the sensor and its pins, and the battery)", ...modelFactLines(s)] : []),
		"",
		"## Power budget (computed in code from the contract and the brief, not by a model)",
		...powerBudgetLines(power),
		...dutyCycleCheckLines(power, s),
	]
}

// How a deep-sleeping board is reflashed when its firmware doesn't boot, from the generated pads (the "Added by
// Bringup" list in the design facts carries it, with USB wake).
export function recoveryFactLines(s: ContractSnapshot): string[] {
	return addedForYouFactLines(s).filter((l) => l.startsWith("- Recovery pads"))
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
	// From the data format, the firmware's own source for it (it used to be a literal in main.cpp, which this parsed).
	const chunk = DATA_FORMAT.gatt.chunk
	const connectedS = num(/BLE_CONNECTED_MAX_MS = (\d+)/) / 1000
	if (![blinkMs, days, periodS, chunk, connectedS].every(Number.isFinite)) return []
	const from = contractPeriod !== undefined && contractPeriod > 0 ? "requirements.dutyCycle.periodS" : "the template's default; the contract has no duty cycle"
	const duty = s.values.requirements?.dutyCycle
	const advertiseMs = duty ? `${bleAdvertiseMs(duty)} ms (activeMs minus the reading)` : `${num(/#define BLE_ADVERTISE_MS (\d+)/)} ms (the template's default; the contract has no duty cycle)`
	// The radio step of each wake, from the connectivity field: advertising (BTHome in it too), or a Wi-Fi upload every N.
	const c = connectivityOf(s)
	const every = c.radio === "wifi" ? Math.max(1, Math.round((c.uploadPeriodS ?? periodS) / periodS)) : 0
	const advertise = c.radio === "wifi" ? null : `${advertiseMs}${c.report.includes("bthome") ? ", with the reading in BTHome v2 service data" : ""}`
	const radioStep = advertise ? `advertises over BLE for ${advertise}` : `every ${every} wakes (${c.uploadPeriodS} s) joins Wi-Fi and uploads by MQTT${c.updates === "ota" ? ", then checks for a firmware update" : ""}`
	const radioFact =
		c.radio === "wifi"
			? `- Firmware Wi-Fi: MQTT with Home Assistant discovery; each upload publishes the latest reading and the batch since the last upload. No BLE.`
			: c.report.includes("gatt")
				? null
				: `- Firmware BLE: BTHome broadcast only (not connectable): no GATT service, so a phone can't read the stored history.`
	// The firmware has a sensor exactly when pins.h has both I2C pins (main.cpp HAS_SENSOR), and wakes early on a pin
	// named BUTTON on GPIO0..5.
	const pins = s.values.pins ?? []
	const button = pins.find((p) => p.signal === "BUTTON" && p.gpio >= 0 && p.gpio <= 5)
	const buttonFact = button
		? `- Firmware button: BUTTON on GPIO${button.gpio} wakes it from deep sleep early (pressed = low, to GND), so a phone can connect at once: it takes a reading, blinks, and stays visible over BLE for ${num(/BUTTON_ADVERTISE_MS = (\d+)/) / 1000} s (not just the reading's burst), or until a phone that connects disconnects.`
		: "- Firmware button: the firmware wakes on a pin named exactly BUTTON on GPIO0..5 (the ESP32-C3's deep-sleep wake pins); this design has none, so no button wakes it."
	if (!(pins.some((p) => p.signal === "I2C_SDA") && pins.some((p) => p.signal === "I2C_SCL")))
		return [
			`- Firmware (product build of templates/fw): the design has no sensor (no I2C_SDA/I2C_SCL pins), so on each wake it reads nothing and stores nothing: it blinks the status LED ${blinkMs} ms, then ${radioStep}, then deep-sleeps ${periodS} s (${from}). The behavior field (blinkMs, tiltBlinkMs, tiltDeg) only drives the bench build; the product build ignores it.`,
			radioFact ?? `- Firmware BLE: the same GATT service as with a sensor, but the latest reading reads 0xFFFFFFFE ("no sensor") and the history stays empty; a phone that connects keeps the device awake until it disconnects or ${connectedS} s pass.`,
			buttonFact,
		]
	return [
		`- Firmware (product build of templates/fw): on each wake it reads the sensor, stores the reading in a ring buffer on the module's flash (LittleFS, the last ${Math.floor((days * 86400) / periodS)} readings: ${days} days at ${periodS} s (${daysFrom})), blinks the status LED ${blinkMs} ms (a double blink if the sensor fails), then ${radioStep}, then deep-sleeps ${periodS} s (${from}). The behavior field (blinkMs, tiltBlinkMs, tiltDeg) only drives the bench build; the product build ignores it.`,
		radioFact ?? `- Firmware BLE: a GATT service with the latest reading, the history count and the history read newest first in chunks of ${chunk} records; a phone that connects keeps the device awake until it disconnects or ${connectedS} s pass.`,
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

// For the test agent: what the design can probe, its own currents (the floor for the limits) and where the pads went.
function testFactLines(s: ContractSnapshot): string[] {
	const { signals, power } = probeableNets(s)
	const { awakeMa, sleepUa } = expectedCurrents(s)
	const lines = ["", "## Production test (computed in code)", `- Nets the fixture can probe: signals ${signals.join(", ") || "none"}; power ${power.join(", ") || "none"}.`, `- The design's own current: peak ${awakeMa ?? "unknown"} mA awake, ${sleepUa === null ? "unknown" : +sleepUa.toFixed(1)} µA asleep (MCU floor and regulators). test limits below these fail every good board.`]
	if (s.values.test) {
		const { placed, unplaced } = testPoints(s)
		lines.push(`- Test pads placed: ${placed.map((p) => `${p.ref} ${p.net} (${p.xMm}, ${p.yMm})`).join(", ") || "none"}${unplaced.length ? `; no room for ${unplaced.join(", ")}` : ""}.`)
	}
	return lines
}
