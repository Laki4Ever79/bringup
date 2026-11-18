import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { generatedNets, supportParts } from "../codegen/circuit.ts"
import { addedForYouFactLines } from "../contract/added.ts"
import { linkFactLines } from "../contract/links.ts"
import { bleAdvertiseMs, sensorDriver } from "../codegen/firmware.ts"
import { dutyCycleCheckLines, estimatePower, powerBudgetLines } from "../contract/power.ts"
import { enclosureMode, type ContractSnapshot } from "../contract/types.ts"
import { modelFactLines } from "../contract/model.ts"
import { expectedCurrents, probeableNets } from "../contract/testkit.ts"
import { testPoints } from "../codegen/circuit.ts"
import { caseFactLines } from "../contract/case.ts"
import { connectivityOf } from "../contract/connectivity.ts"
import { DATA_FORMAT } from "../codegen/data-format.ts"
import { spaceFactLines } from "../contract/space.ts"
import { standardsFactLines } from "../contract/standards.ts"
import { catalogEntry, loadCatalog } from "../tools/parts-search.ts"
import { mechanicsFactLines } from "../mechanics/facts.ts"
import { mechanicsFigures } from "../mechanics/checks.ts"
import { mcuFacts } from "../mcu/facts.ts"
import { mcuProfileOf } from "../mcu/profile.ts"
import { roverHeader, OPPONENT_GAP_MM } from "../mechanics/firmware.ts"

// The facts and computed checks about the current contract, one source for everyone who judges or changes it: the
// reviewer reads them at the final review, and every designer turn gets them recomputed from the contract as it is
// then. Before, only the reviewer saw them, and the designers kept missing what it blocked on (charge LED, flash
// storage, battery life, supply range, the behavior field).
// Every agent turn asks again, mostly on a design it has already seen (33 architect turns per logger run): kept for the
// last few designs, keyed on the design and the brief.
const factsCache = new Map<string, string[]>()
export function designFacts(s: ContractSnapshot, brief: string): string[] {
	const key = JSON.stringify(s.values) + "\u0000" + brief
	const hit = factsCache.get(key)
	if (hit) return [...hit]
	const facts = designFactsUncached(s, brief)
	if (factsCache.size >= 32) factsCache.delete(factsCache.keys().next().value!)
	factsCache.set(key, facts)
	return [...facts]
}

function designFactsUncached(s: ContractSnapshot, brief: string): string[] {
	const power = estimatePower(s, brief)
	return [
		...mcuFactsSection(s),
		...partFactsSection(s),
		...fieldMeaningLines(s),
		...testFactLines(s),
		...addedForYouFactLines(s, brief),
		...linkFactLines(s),
		...standardsFactLines(s),
		...mechanicsFactLines(s),
		...(s.values.outline ? ["", "## Space (computed in code: the smallest board the parts place on, the case's contents)", ...spaceFactLines(s).map((l) => `- ${l}`)] : []),
		...(s.values.outline && enclosureMode(s.values) === "case" ? ["", "## The case (computed in code from the outline, the connectors and the case field)", ...caseFactLines(s).map((l) => `- ${l}`)] : []),
		...(enclosureMode(s.values) !== "case" ? ["", "## The case", enclosureMode(s.values) === "none" ? '- None: a bare board (requirements.enclosure "none"). No case is built or checked; the case field, if any, is ignored.' : '- None of ours: the board goes into the engineer\'s own housing (requirements.enclosure "own"). No case is built or checked; Bringup writes interface.md (outline, mounting holes, openings, buttons, lights, vents, antenna keep-out, underside pads, label) for whoever designs the housing.'] : []),
		...(s.values.model ? ["", "## The on-device model (checked in code against the flash and RAM the firmware leaves, the sensor and its pins, and the battery)", ...modelFactLines(s)] : []),
		"",
		"## Power budget (computed in code from the contract and the brief, not by a model)",
		...robotRuntime(s, powerBudgetLines(power)),
		...dutyCycleCheckLines(power, s),
	]
}

// The chosen MCU, from its profile (src/mcu/facts.ts): pins by name and index, what is reserved, peripherals free,
// programming, sleep floor. Nothing when there is no MCU yet or its part has no profile.
export function mcuFactsSection(s: ContractSnapshot): string[] {
	const p = mcuProfileOf(s.values.parts)
	return p ? ["## The MCU (from its profile, catalog/mcu)", ...mcuFacts(p), ""] : []
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
	if (s.values.mechanics && s.values.motion) return roverFirmwareFacts(s)
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
		const notes = catalogEntry(catalog, p)?.notes
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

// A robot's product firmware is templates/fw-rover (src/tools/firmware.ts prepareFirmware), not the logger's
// templates/fw: its facts come from the rover header the build writes (rover run cc-rover-7 on the Claude subscription,
// 16 Nov 2026: the reviewer was told the rover ran the logger, reading the sensor and deep-sleeping 300 s, and failed a
// design whose built firmware drives, avoids walls and passed the simulated drive).
// The servos' supply as the parts have it (run 20b: the fact named a step-down the board didn't have).
function servoSupplyFact(s: ContractSnapshot): string {
	const parts = s.values.parts ?? []
	const supply = parts.find((p) => p.role === "servo-supply")
	if (!supply) return " The board has no servo supply (no part with role servo-supply): the servo plugs' +5 V is not powered."
	const estop = parts.some((p) => p.role === "estop") && supply.pins.includes("EN")
	return ` The servos' 5 V comes from ${supply.ref} ${supply.mpn}${estop ? ", switched off by the emergency stop through its EN" : ""}.`
}

export function roverFirmwareFacts(s: ContractSnapshot): string[] {
	let header: string
	try {
		header = roverHeader(s)
	} catch (e) {
		return [`- Firmware (templates/fw-rover): not built yet: ${(e as Error).message}`]
	}
	const def = (name: string) => new RegExp(`#define ${name} (\\S+)`).exec(header)?.[1]
	const led = (s.values.pins ?? []).find((p) => p.signal === "STATUS_LED")
	// A pull-cord start (templates/fw-rover/src/match.h): PIN_START and MATCH_MS from the same header, the debounce from
	// match.h itself.
	const start = def("PIN_START"), matchMs = Number(def("MATCH_MS")?.replace(/UL$/, ""))
	const debounce = /#define MATCH_DEBOUNCE_MS (\d+)/.exec(readFileSync(resolve(import.meta.dirname, "../../templates/fw-rover/src/match.h"), "utf8"))?.[1]
	const startFact = start
		? [`- Firmware start (pull cord): the motors stay off until it has seen the start cord in (START on GPIO${start} reads low: the cord's loop to GND), so a robot powered up without its cord never starts; once the cord has stayed out ${debounce} ms it drives${Number.isFinite(matchMs) ? `, and ${matchMs / 1000} s after the start it stops both drive motors for good (until reset; a cord put back doesn't restart it)` : ", with no match length: it drives until it is switched off"}.`]
		: []
	// Under a competition's rules (rover_hold.h): the stop for the opponent, in the header's own numbers.
	const hold = def("ROVER_HOLD_MM")
	const holdFact = hold
		? [`- Firmware opponent stop (competition rules, ${s.values.motion?.rules}): when the distance sensor reads under ${hold} mm ahead (at least the ${OPPONENT_GAP_MM} mm gap to the opponent plus the braking distance, and never less than its wall stop distance, so the hold comes before any turn), both motors stop and stay stopped, with no turn away, while it stays there (also when the sensor reads nothing right after a reading under ${def("ROVER_BLIND_MM")} mm, its blind range); when it reads ${def("ROVER_CLEAR_MM")} mm or more, or nothing in range after a farther reading, the robot drives on. After ${Number(def("ROVER_HOLD_MAX_MS")?.replace(/UL$/, "")) / 1000} s still blocked it treats the obstacle as fixed (a wall) and its normal stop-and-turn takes over. The hold runs ahead of any host command too: a host can't drive it forward into what it holds for. The simulated drive tests it with an opponent that appears 0.4 m ahead and leaves 3 s later.`]
		: []
	// With wheel encoders (rover_odo.h): odometry and go-to-point, in the header's own numbers.
	const mmPerCount = def("ROVER_MM_PER_COUNT")
	const gotoFact = mmPerCount
		? [`- Firmware odometry and go-to-point (wheel encoders): it tracks its pose (the axle's middle, x ahead, y left of where it started) from the encoder counts, ${mmPerCount.replace(/f$/, "")} mm a count over a ${def("ROVER_TRACK_MM")?.replace(/f$/, "")} mm track, and prints it twice a second (ODO). A host's \`G <x_mm> <y_mm>\` drives it to that point: it turns in place to face it, drives there holding its heading, slows over the last 150 mm, stops within 8 mm by its odometry and stays until the next command (an H command cancels it). On the way it stops for something in its way (a reading inside its ${def("ROVER_HOLD_MM") ? "opponent hold" : "stop"} distance that is nearer than the target plus ${def("ROVER_GOTO_GAP_MM")} mm), not for the wall beyond the target. Successive G commands queue a route (up to 16 points), the odometry carried throughout. Its accuracy is the odometry's: in the reference test (the Eurobot base in the simulated drive, judged by the physics, not the odometry) a full lap of a 600 × 400 mm rectangle ends 9.5 mm from its start, and single targets 0.5 to 0.6 m away 11 to 13 mm off (20 mm allowed); wheel slip on a real table adds to that, and the bench hasn't measured it.`]
		: []
	return [
		`- Firmware (product build of templates/fw-rover, the same control logic the simulated drive runs): never sleeps while powered. Every ${def("ROVER_PERIOD_MS")} ms tick it reads the VL53L0X distance (up to ${def("ROVER_RANGE_MM")} mm), drives both motors through the DRV8833 at cruise duty ${def("ROVER_CRUISE_DUTY")?.replace("f", "")}, slows inside ${def("ROVER_SLOW_MM")} mm and, inside ${def("ROVER_STOP_MM")} mm of a wall, turns in place for ${def("ROVER_TURN_MS")} ms, then drives on.`,
		// The payload as the parts have it (run 20b: the fact named a temperature/humidity sensor the Eurobot base doesn't carry).
		((sensor) => sensor
			? `- Firmware payload: every 5 s it reads the ${sensor.ref} ${sensor.mpn} temperature/humidity sensor, prints it and broadcasts it over BLE as BTHome v2 service data (and sends it over the board's links, if any).`
			: "- Firmware payload: none. The design has no temperature/humidity sensor, so the firmware reads, prints and sends no reading; its BLE beacon carries only its packet count.")((s.values.parts ?? []).find((p) => p.role === "sensor" && sensorDriver(p.mpn))),
		led
			? start
				? `- Firmware status LED: STATUS_LED on GPIO${led.gpio} shows the match: two short flashes every 2 s while it waits for the start cord, steady on when ready (cord in, armed), a fast 4 Hz blink while running, a slow 0.5 Hz blink once the match is over (templates/fw-rover/src/status_led.h).`
				: `- Firmware status LED: STATUS_LED on GPIO${led.gpio} blinks a 1 Hz heartbeat while the control loop runs.`
			: "- Firmware status LED: the rover firmware drives a pin named exactly STATUS_LED as a 1 Hz heartbeat; this design has none, so no LED shows the rover running.",
		...startFact,
		...holdFact,
		// Servos and a spare motor through a PCA9685 (pca9685.h), in the header's own numbers.
		...(def("PCA9685_ADDR") ? [`- Firmware servos${def("SPARE_MOTOR_CH") ? " and spare motor" : ""}: a PCA9685 at I2C address ${def("PCA9685_ADDR")} runs at 50 Hz; ${def("SERVO_COUNT")} servo(s) on its channels 0.. start centred (1500 us) and a host moves one with \`V <n> <us>\` (500-2500 us)${def("SPARE_MOTOR_CH") ? `; the spare motor (a second DRV8833's channel A on channels ${def("SPARE_MOTOR_CH")} and ${Number(def("SPARE_MOTOR_CH")) + 1}) runs with \`W <duty>\` (-1..1, PWM at the same 50 Hz)` : ""}.${servoSupplyFact(s)}`] : []),
		...gotoFact,
	]
}

// A robot's battery is sized by its runtime while driving, which the mechanics check computes (motors at cruise plus the
// electronics), not by a sleep duty cycle: its power budget says so instead of "unknown" (rover runs cc-rover-8 and -9 on
// the Claude subscription, 16 Nov 2026: the reviewer twice noted "no duty cycle, so the power budget shows unknown").
export function robotRuntime(s: ContractSnapshot, lines: string[]): string[] {
	if (!s.values.motion || !s.values.mechanics) return lines
	const runtime = mechanicsFigures(s).find((f) => f.check === "Runtime")
	if (!runtime) return lines
	const line = `- Estimated battery life (a robot: its runtime while driving, from the mechanics check): ${runtime.value} against ${runtime.limit} (${runtime.ok ? "met" : "NOT met"}; ${runtime.note ?? "at cruise"}). A robot awake while driving has no sleep duty cycle, so none is needed.`
	return lines.map((l) => (l.startsWith("- Estimated battery life:") ? line : l))
}
