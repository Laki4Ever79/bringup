import { pathHash, sensorPath } from "../contract/sensor-path.ts"
import { LINK_CONNECTOR, CAN_TRANSCEIVER, canName, canSignals } from "../contract/links.ts"
import { FREE_GPIOS } from "../contract/link-kinds.ts"
import { defaultTestSpec, expectedCurrents, probeableNets } from "../contract/testkit.ts"
import { supportParts, testPoints, nativeUsbIndexes } from "../codegen/circuit.ts"
import { FunctionCallOutputItem, ModelMessageItem, UserMessageItem, type ContextItem } from "@mozaik-ai/core"
import type { CaseSpec, ContractSnapshot, ContractValues, EnclosureMode, FieldName } from "../contract/types.ts"
import { boardWidthFor, caseChecks, caseOf, LID, minCaseHeight } from "../contract/case.ts"
import { compactOutline, ROUTING_FAILURE, SLACK_LIMIT, sizeReasonHolds } from "../contract/space.ts"
import { state } from "../runtime.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import type { Part } from "../contract/types.ts"
import { isCncPlug } from "../cnc/wiring-auto.ts"
import { parseSwap } from "../tools/sourcing.ts"
import { armLinksForReach, armTargetsFromRequest, mechanicsFromRequest, partsAfterSwap } from "../runner/request-map.ts"
import { parseMoves, type PartMove, type Release } from "../board-edit/board-move.ts"
import { resolve } from "node:path"
import { toolCall, type Script } from "./scripted-runner.ts"
import { DEFAULT_BEHAVIOR } from "../codegen/firmware.ts"
import { LEGACY_MCU_ID, mcuProfileOf, profileById } from "../mcu/profile.ts"
import { chipPartPins } from "../mcu/board.ts"
import { solvePins, type Need } from "../mcu/solver.ts"
import { defaultCheckCatalog, type CheckCatalog } from "../mechanics/checks.ts"
import { byMpn } from "../mechanics/catalog.ts"
import { laidOut, solveChassis } from "../mechanics/solve.ts"
import { armTargetsFromBrief } from "../mechanics/brief.ts"
import type { ArmSpec } from "../arm/types.ts"
import { armInputNet } from "../contract/power-auto.ts"
import { pinIndex } from "../mcu/pins.ts"

// The logger design the mock agents produce: ESP32-C3, SHT40 over I2C, USB-C power, LDO, LED.
export const LOGGER_DESIGN: Omit<ContractValues, "parts" | "behavior" | "model" | "test" | "case" | "connectivity" | "links" | "motion" | "mechanics"> & { parts: ContractValues["parts"] } = {
	// ESP32-C3 deep sleep about 10 µA; every 5 min it wakes for a 30 ms reading and a 300 ms BLE advertising burst at
	// about 25 mA. Average: 25 mA × 330 ms / 300 s + 10 µA = 37.5 µA, before the LDO's own quiescent current.
	requirements: {
		summary: "BLE temperature and humidity logger",
		peripherals: ["i2c-sensor", "usb-c", "status-led"],
		batteryLifeDays: 180,
		dutyCycle: { activeMs: 330, periodS: 300, sleepUa: 10 },
	},
	// Unit tests use this design as one fixed 50 × 30 mm board. A scripted run takes the size and its reason from the
	// brief instead: the logger brief's "about 50 × 30 mm" is a limit, so that run ends compact (space rules, 13 Nov 2026).
	outline: { widthMm: 50, heightMm: 30, thicknessMm: 1.6, sizeReason: { kind: "engineer-size", detail: "the test design is held at exactly 50 × 30 mm" } },
	connectors: [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 15, widthMm: 9, heightMm: 3.5 }],
	// loadMa: the module transmitting Bluetooth LE at 0 dBm peaks at 170 mA (ESP32-C3-MINI-1 datasheet v2.2), plus the rest.
	rails: [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 200, averageMa: 0.0375 }],
	pins: [
		{ signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 9, partRef: "U2", partPin: "SCL" },
	],
	parts: [
		{ ref: "U1", role: "mcu", mpn: "ESP32-C3-MINI-1", lcsc: "C2838502", footprint: "esp32_c3_mini_1", pins: ["GPIO0", "GPIO1", "GPIO2", "GPIO3", "GPIO4", "GPIO5", "GPIO6", "GPIO7", "GPIO8", "GPIO9", "GPIO10", "GPIO18", "GPIO19", "EN", "3V3", "GND"], reason: "Brief: \"Bluetooth Low Energy. A phone app reads the latest value and downloads the stored history\": a BLE module with 4 MB flash for the history and native USB for flashing" },
		{ ref: "U2", role: "sensor", mpn: "SHT40-AD1B-R2", lcsc: "C2909890", footprint: "dfn4", pins: ["SDA", "SCL", "VDD", "VSS"], reason: "Brief: \"Temperature and humidity sensing ... about ±0.2 °C and ±2 %RH\": the SHT40 gives ±0.2 °C and ±1.8 %RH typical over I2C" },
		{ ref: "U3", role: "ldo", mpn: "RT9080-33GJ5", lcsc: "C841192", footprint: "sot23_5", pins: ["VIN", "GND", "EN", "NC", "VOUT"], reason: "Brief: \"Runs on one Li-ion cell for at least 6 months\": a 2 µA quiescent regulator for the 3.3 V rail, rated for the module's 0.5 A" },
		{ ref: "U4", role: "charger", mpn: "TP4054-42-SOT25R", lcsc: "C32574", footprint: "sot23_5", pins: ["CHRG", "GND", "BAT", "VCC", "PROG"], reason: "Brief: \"USB-C for charging\": a single-cell Li-ion charger fed from VBUS" },
		{ ref: "J1", role: "usb-c", mpn: "TYPE-C-31-M-12", lcsc: "C165948", footprint: "usbcmidmount", pins: ["VBUS", "GND", "CC1", "CC2", "DP", "DN"], reason: "Brief: \"USB-C for charging and for flashing firmware. Nobody should need a special cable\"" },
		{ ref: "J2", role: "battery", mpn: "S2B-PH-K-S(LF)(SN)", lcsc: "C173752", footprint: "jst2_ph", pins: ["VBAT", "GND"], reason: "Brief: \"one Li-ion cell ... a small single-cell pouch, around 500 mAh\": a JST PH socket for the cell's lead" },
		{ ref: "D1", role: "led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: ["A", "K"], reason: "Brief: \"A status LED that blinks briefly on each reading\"" },
		{ ref: "D2", role: "charge-led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: ["A", "K"], reason: "Brief: \"... and shows charging state\": lit by the charger itself while charging, even with the MCU asleep" },
		// Support passives. Codegen claims them by LCSC number in job order: LED (R1), charge LED (R7), CC1, CC2, PROG,
		// I2C pull-ups, bypass caps, the module's EN reset RC (R10 10k, C4 1uF), the USB-sense divider (R8 68k, R9 100k).
		{ ref: "R1", role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R2", role: "resistor", mpn: "0402WGF5101TCE", lcsc: "C25905", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R3", role: "resistor", mpn: "0402WGF5101TCE", lcsc: "C25905", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R4", role: "resistor", mpn: "0402WGF4701TCE", lcsc: "C25900", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R5", role: "resistor", mpn: "0402WGF1002TCE", lcsc: "C25744", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R6", role: "resistor", mpn: "0402WGF1002TCE", lcsc: "C25744", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R7", role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R8", role: "resistor", mpn: "0402WGF6802TCE", lcsc: "C36871", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R9", role: "resistor", mpn: "0402WGF1003TCE", lcsc: "C25741", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "C1", role: "capacitor", mpn: "CL05A105KA5NQNC", lcsc: "C52923", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "C2", role: "capacitor", mpn: "CL05A105KA5NQNC", lcsc: "C52923", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "C3", role: "capacitor", mpn: "CL10A106KP8NNNC", lcsc: "C19702", footprint: "0603", pins: ["pin1", "pin2"] },
		{ ref: "R10", role: "resistor", mpn: "0402WGF1002TCE", lcsc: "C25744", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "C4", role: "capacitor", mpn: "CL05A105KA5NQNC", lcsc: "C52923", footprint: "0402", pins: ["pin1", "pin2"] },
	],
}

// The second scripted design, for briefs/beacon.md: the logger's board without the sensor (and its I2C pull-ups), plus
// a button on the top edge that wakes it. ESP32-C3 deep sleep about 10 µA; every 60 s it wakes for a 300 ms BLE
// advertising burst (plus the 30 ms wake) at about 25 mA: 25 mA × 330 ms / 60 s + 10 µA = 147.5 µA. With the
// RT9080's 2 µA, one phone connection a day (about 30 µA) and the charger's 6 µA, a 500 mAh cell lasts about 112 days,
// past the brief's 3 months. (With the AP2112K's 55 µA it fell short once phone use and the charger were counted.)
export const BEACON_DESIGN: typeof LOGGER_DESIGN = {
	requirements: {
		summary: "BLE beacon with a wake button",
		peripherals: ["usb-c", "status-led", "button"],
		batteryLifeDays: 90,
		dutyCycle: { activeMs: 330, periodS: 60, sleepUa: 10 },
	},
	outline: LOGGER_DESIGN.outline,
	connectors: [...LOGGER_DESIGN.connectors, { ref: "SW1", kind: "button", edge: "top", offsetMm: 25, widthMm: 4, heightMm: 3 }],
	rails: [{ ...LOGGER_DESIGN.rails[0], averageMa: 0.1475 }],
	pins: [{ signal: "BUTTON", gpio: 3, partRef: "SW1", partPin: "A" }],
	parts: [
		...LOGGER_DESIGN.parts.filter((p) => !["U2", "R5", "R6"].includes(p.ref)),
		{ ref: "SW1", role: "button", mpn: "TS-1187A-B-A-B", lcsc: "C318884", footprint: "pushbutton", pins: ["A", "B"] },
	],
}

// The logger's parts that serve only its ESP32-C3 module: the USB-sense divider (R8, R9) and the module's EN reset RC
// (R10, C4). A design on another chip takes the logger's parts without these (a bare chip's reset capacitor and
// decoupling come from its profile, src/mcu/board.ts); an ESP32-only part added to the logger belongs here too.
export const ESP32_MODULE_PARTS = ["R8", "R9", "R10", "C4"]

// A bare MCU as the parts list carries it: footprint and pin labels from its profile, as catalog/parts.json has it
// (scripts/mcu/catalog.ts), so a scripted contract builds on its own (npm run board) without a run filling them in.
function chipPart(id: string, ref = "U1") {
	const p = profileById(id)
	if (!p) throw new Error(`no MCU profile ${id}`)
	return { ref, role: "mcu", mpn: p.mpn, lcsc: p.lcsc ?? "", footprint: p.package.footprint, pins: chipPartPins(p) }
}

// The third scripted design, for a brief that names an STM32 (briefs/logger-stm32.md): the logger on an STM32G031K8, a
// chip without a radio, so the readings stay in its history (read out over its console or SWD). Its pins come from the
// chip's profile: the SHT40 on I2C1 (PB7 = 23, PB6 = 22). Sleep in Stop 1 about 3.7 µA (DS12992 Table 29) plus the
// sensor's idle; every 5 min an 80 ms wake at about 15 mA (5.2 mA core, the SHT40 measuring, the LED blink):
// 15 mA × 80 ms / 300 s + 5 µA ≈ 9 µA average, before the LDO's own quiescent current.
export const STM32_LOGGER_DESIGN: typeof LOGGER_DESIGN = {
	requirements: {
		summary: "Wired temperature and humidity logger on an STM32 (no radio)",
		peripherals: ["i2c-sensor", "usb-c", "status-led"],
		batteryLifeDays: 365,
		dutyCycle: { activeMs: 80, periodS: 300, sleepUa: 5 },
	},
	outline: LOGGER_DESIGN.outline,
	connectors: LOGGER_DESIGN.connectors,
	rails: [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 15, averageMa: 0.009 }],
	pins: [
		{ signal: "I2C_SDA", gpio: 23, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 22, partRef: "U2", partPin: "SCL" },
	],
	parts: [
		chipPart("stm32g031k8t6"),
		...LOGGER_DESIGN.parts.filter((p) => p.role !== "mcu" && !ESP32_MODULE_PARTS.includes(p.ref)),
	],
}
// A catalog part as the parts list carries it, under a ref (and its own nets, when it has them).
function catalogPart(mpn: string, ref: string, nets?: Record<string, string>): Part {
	const d = (loadCatalog(process.cwd()) as unknown as (Part & { lcsc: string })[]).find((p) => p.mpn === mpn)
	if (!d) throw new Error(`catalog/parts.json has no ${mpn}`)
	return { ref, role: d.role, mpn: d.mpn, lcsc: d.lcsc, footprint: d.footprint, pins: d.pins, ...(nets ? { nets } : {}) } as Part
}
// One stepper driver per motor (X, Y ×2, Z): the catalog's TMC2209-LA.
const cncDriver = (ref: string) => catalogPart("TMC2209-LA", ref)
// The motors in the drivers' order (src/cnc/board.ts cncMotors) and each one's MCU pins (UFQFPN48 names): STEP and DIR
// (their ENN is one shared line from the e-stop's OR gate, gap 7).
const CNC_MOTORS: { label: string; driver: string; plug: string; step: string; dir: string }[] = [
	{ label: "X", driver: "U4", plug: "JX1", step: "PA0", dir: "PA1" },
	{ label: "Y1", driver: "U5", plug: "JX2", step: "PA3", dir: "PA4" },
	{ label: "Y2", driver: "U6", plug: "JX3", step: "PA6", dir: "PA7" },
	{ label: "Z", driver: "U7", plug: "JX4", step: "PB1", dir: "PB10" },
]
const f411 = (name: string) => {
	const i = pinIndex(profileById("stm32f411ceu6"), name)
	if (i === null) throw new Error(`STM32F411CEU6 has no ${name}`)
	return i
}

// The CNC's controller board as the mock can write it today (docs/cnc.md step 0): the STM32F411CEU6 (grblHAL's chip; the
// ESP32-WROOM-32E FluidNC runs on has no buildable board yet: its profile's board.supported is false, mock run 2) on USB
// with the logger's regulator, USB-C and LED, and the four TMC2209s (unwired: the board generator doesn't know them yet,
// gap 5). No spindle switch, 24 V input or limit inputs: the catalog has none yet (gaps 6–7).
export const CNC_DESIGN: typeof LOGGER_DESIGN = {
	requirements: {
		summary: "Desktop 3-axis CNC engraver: three NEMA 17 steppers on T8 lead screws, a 24 V spindle, limit switches and an emergency stop, grblHAL on an STM32F411",
		peripherals: ["stepper-drivers", "spindle", "limit-switches", "estop", "usb-c", "status-led"],
		batteryLifeDays: null,
		enclosure: "none",
	},
	outline: { widthMm: 100, heightMm: 80, thicknessMm: 1.6 },
	connectors: LOGGER_DESIGN.connectors,
	// The motors' 24 V from the brick's jack (its whole 6.67 A; their coils ~1.1 A at the run current, cnc checks' estimate).
	rails: [
		{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 350, averageMa: 120 },
		{ name: "VMOT", voltageV: 24, regulatorMaxMa: 6670, loadMa: 1100 },
	],
	// Each driver's STEP, DIR and ENN on a GPIO; one single-wire UART for all four (USART1 TX, PA9, on PDN_UART); the LED.
	pins: [
		...CNC_MOTORS.flatMap((m) => [
			{ signal: `${m.label}_STEP`, gpio: f411(m.step), partRef: m.driver, partPin: "STEP" },
			{ signal: `${m.label}_DIR`, gpio: f411(m.dir), partRef: m.driver, partPin: "DIR" },
		]),
		// One enable for every driver (gap 7): the MCU's STEPPERS_EN on the OR gate's B, the e-stop's ESTOP_TRIP on its A;
		// the MCU reads ESTOP_TRIP too (grblHAL's E-stop alarm), and each axis' limit switch.
		{ signal: "STEPPERS_EN", gpio: f411("PA2"), partRef: "U9", partPin: "B" },
		{ signal: "ESTOP_TRIP", gpio: f411("PB12"), partRef: "U9", partPin: "A" },
		{ signal: "LIMIT_X", gpio: f411("PB13"), partRef: "JL1", partPin: "SIG" },
		{ signal: "LIMIT_Y", gpio: f411("PB14"), partRef: "JL2", partPin: "SIG" },
		{ signal: "LIMIT_Z", gpio: f411("PB15"), partRef: "JL3", partPin: "SIG" },
		// The spindle's current on ADC1_IN5 (PA5, freed by the shared enable): its stall stop.
		{ signal: "SPINDLE_I", gpio: f411("PA5"), partRef: "U10", partPin: "OUT" },
		// The drivers' one single-wire UART (TMC2209 §4: PDN_UART): grblHAL's shared Trinamic stream is a full-duplex USART
		// (TRINAMIC_UART_ENABLE 1, addresses by motor index), so RX (PA10) sits on the line and TX (PA9) joins it through
		// 1 kΩ (R20). PA9 straight onto the line, as before, could write the drivers and never read them back.
		{ signal: "STEPPER_UART", gpio: f411("PA10"), partRef: "U4", partPin: "PDN_UART" },
		{ signal: "STEPPER_UART_TX", gpio: f411("PA9"), partRef: "R20", partPin: "pin1" },
		{ signal: "STATUS_LED", gpio: f411("PC13"), partRef: "D1", partPin: "A" },
		// The spindle's speed: TIM1_CH1 PWM on PA8, into the 5 V gate driver (gap 6).
		{ signal: "SPINDLE_PWM", gpio: f411("PA8"), partRef: "U8", partPin: "A" },
	],
	parts: [
		chipPart("stm32f411ceu6"),
		// Not the logger's C4 (the C3 module's EN reset capacitor): on the S3 board the generator adds its own (C27 beside
		// R10), so a copy here was a surplus part wired to nothing (the 4-layer arm mock, 27 Nov 2026: part-unconnected C4).
		...LOGGER_DESIGN.parts.filter((p) => ["U3", "J1", "D1", "R1", "R2", "R3", "C1", "C3"].includes(p.ref)),
		...CNC_MOTORS.map((m) => cncDriver(m.driver)),
		// The brick's jack: its VIN on the motors' rail.
		catalogPart("DC-091-A250", "J2", { VIN: "VMOT", GND: "GND", GND_2: "GND", GND_3: "GND", GND_4: "GND" }),
		// Each motor's plug, its pins on the driver's output nets (catalog TMC2209-LA nets, src/cnc/board.ts).
		...CNC_MOTORS.map((m) => catalogPart("B4B-XH-A(LF)(SN)", m.plug, { A1: `@${m.label}_A1`, A2: `@${m.label}_A2`, B1: `@${m.label}_B1`, B2: `@${m.label}_B2` })),
		// The spindle switch (gap 6): the AHCT gate driver (its support: gate resistor, pull-down, flyback; catalog), the
		// low-side MOSFET between the spindle's minus lead and ground, and the spindle's screw terminal on the motor rail.
		catalogPart("SN74AHCT1G125DBVR", "U8"),
		catalogPart("AO4468", "Q1", { S: "@SPINDLE_SHUNT", S_2: "@SPINDLE_SHUNT", S_3: "@SPINDLE_SHUNT", G: "@SPINDLE_GATE", D: "@SPINDLE_N", D_2: "@SPINDLE_N", D_3: "@SPINDLE_N", D_4: "@SPINDLE_N" }),
		catalogPart("KF128R-5.08-2P", "J3", { POS: "@VMOT_SW", NEG: "@SPINDLE_N" }),
		// The emergency stop (gap 7): its power switch (VMOT to VMOT_SW, gate held on through the e-stop's NC loop), the OR
		// gate that disables every driver on a stop, the e-stop's plug, and a limit switch's plug per axis.
		{ ref: "R20", role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: ["pin1", "pin2"], nets: { pin2: "@STEPPER_UART" } },
		// The spindle's current (its stall stop): the shunt under Q1's source, its amplifier to an ADC pin.
		catalogPart("INA180A1IDBVR", "U10"),
		catalogPart("AO4407A", "Q2"),
		catalogPart("SN74LVC1G32DBVR", "U9"),
		catalogPart("B2B-XH-A-R(LF)(SN)", "JE1", { LOOP: "@ESTOP_LOOP" }),
		catalogPart("S2B-XH-A(LF)(SN)", "JL1"),
		catalogPart("S2B-XH-A(LF)(SN)", "JL2"),
		catalogPart("S2B-XH-A(LF)(SN)", "JL3"),
	],
}
// The CNC on FluidNC (briefs/cnc-fluidnc.md, docs/cnc.md gap 14): the same machine and board on the ESP32-WROOM-32E, its
// pins GPIO numbers. Outputs stay off the input-only 34-39, the strapping pins (0, 2, 5, 12, 15 but the LED's 2, low at
// reset as that strap wants), UART0 (1, 3) and the flash (6-11); the e-stop's trip (the OR gate drives it) on input-only
// 36, the spindle's current on ADC1's 39 (ADC2 is lost to Wi-Fi). The USB-UART bridge and the auto-reset pair come with
// the module (src/contract/usb-bridge-auto.ts); the 3.3 V load is the module's Wi-Fi peak.
export const CNC_FLUIDNC_PINS: Record<string, number> = { X_STEP: 26, X_DIR: 27, Y1_STEP: 14, Y1_DIR: 13, Y2_STEP: 33, Y2_DIR: 32, Z_STEP: 25, Z_DIR: 4, STEPPERS_EN: 23, ESTOP_TRIP: 36, LIMIT_X: 18, LIMIT_Y: 19, LIMIT_Z: 21, SPINDLE_I: 39, STEPPER_UART: 16, STEPPER_UART_TX: 17, STATUS_LED: 2, SPINDLE_PWM: 22 }
export const CNC_FLUIDNC_DESIGN: typeof LOGGER_DESIGN = {
	...CNC_DESIGN,
	requirements: { ...CNC_DESIGN.requirements, summary: "Desktop 3-axis CNC engraver: three NEMA 17 steppers on T8 lead screws, a 24 V spindle, limit switches and an emergency stop, FluidNC on an ESP32-WROOM-32E" },
	rails: CNC_DESIGN.rails!.map((r) => (r.name === "3V3" ? { ...r, loadMa: 500 } : r)),
	pins: CNC_DESIGN.pins!.map((p) => {
		const gpio = CNC_FLUIDNC_PINS[p.signal]
		if (gpio === undefined) throw new Error(`CNC_FLUIDNC_PINS has no ${p.signal}`)
		return { ...p, gpio }
	}),
	parts: CNC_DESIGN.parts!.map((p) => (p.role === "mcu" ? catalogPart("ESP32-WROOM-32E", p.ref) : p)),
}
// The CNC's parts as an agent writes them: no plugs, no nets but the MCU's. The contract tools add the plugs the machine
// needs and wire the rest (cnc/wiring-auto.ts), so the mock proves that code, not the hand-written plugs and nets
// CNC_DESIGN keeps as the tests' fixture (docs/cnc.md gap 2).
const withoutCncWiring = (parts: Part[]) => parts.filter((p) => !isCncPlug(p)).map((p) => (p.role === "mcu" || !p.nets ? p : (({ nets: _n, ...rest }) => rest as Part)(p)))
const isCnc = () => !!state().contract.get("cncTargets") || CNC_BRIEF.test(state().contract.get("requirements")?.summary ?? "")
const isCncFluidnc = () => isCnc() && /\bESP32\b/.test(state().contract.get("requirements")?.summary ?? "")
const isStm32 = () => /\bSTM32\b/.test(state().contract.get("requirements")?.summary ?? "")

// The scripted rover (briefs/rover.md, docs/mechanics.md): the logger's board without its case, plus a DRV8833 driving
// two Pololu 100:1 micro gearmotors from the cell (JM1 left, JM2 right), and a JST SH plug (JT1) for the VL53L0X
// breakout standing at the chassis front, on the I2C bus with the SHT40 payload sensor. Always awake while driving:
// about 25 mA for the MCU with BLE advertising plus 19 mA for the VL53L0X ranging (ST datasheet Table 8) ≈ 45 mA
// average; the cell's runtime is the mechanics check's, not a battery-life target.
const ROVER_PINS = [
	{ signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" },
	{ signal: "I2C_SCL", gpio: 9, partRef: "U2", partPin: "SCL" },
	{ signal: "MOT_AIN1", gpio: 4, partRef: "U5", partPin: "AIN1" },
	{ signal: "MOT_AIN2", gpio: 5, partRef: "U5", partPin: "AIN2" },
	{ signal: "MOT_BIN1", gpio: 6, partRef: "U5", partPin: "BIN1" },
	{ signal: "MOT_BIN2", gpio: 7, partRef: "U5", partPin: "BIN2" },
]
export const ROVER_MOTION: ContractValues["motion"] = { speedMps: 0.3, runtimeMin: 30, edgeMm: 3, maxSlopeDeg: 5, stopBeforeWallMm: 150, payloadG: 20, maxSizeMm: [150, 120], maxMassG: 500 }
export const ROVER_MECHANICS: ContractValues["mechanics"] = {
	// 80 mm wheels and a 38 mm caster. The brief's edge is 3 mm (floor seams, tile and rug edges), not 1 cm: the caster
	// carries about 43 % of the weight (its own 71 g, the plate and the board sit behind the axle); from rest the
	// simulation pushes it up 1 cm only under about 28 % (the mech-climb check: 21 %). At cruise its momentum carries it
	// over 1 cm, but a rover that stops on such an edge stays there (docs/mechanics.md). Door thresholds are out of scope.
	drive: { kind: "differential", motor: "POLOLU-2367 100:1 MP 6V", wheel: "POLOLU-1430 wheel 80x10 mm", caster: "TENTE 1430POI038P60-46x38 swivel caster 38 mm", trackMm: 110, wheelbaseMm: 90, axleXMm: 40 },
	battery: { pack: "ADAFRUIT-2011 LP-803860 2000 mAh", at: { xMm: 40, yMm: 0 } },
	sensor: { module: "ADAFRUIT-3317 VL53L0X breakout (STEMMA QT)", at: { xMm: 73.6, yMm: 0, zMm: 66 }, connector: "JT1" },
	// The plate's underside at the caster's 50.5 mm (the motors' brackets drop 10.5 mm to the 40 mm axle). Within the
	// brief's 150 × 120 mm with the wheels: a 110 mm track and 10 mm wheels leave a 96 mm plate (the layout solver's
	// answer for these parts; the old 150 × 110 plate on a 130 mm track was 140 mm wide and was laid out again each run).
	// The board 20 mm back, the axle at 40 and a 90 mm wheelbase (the solver's answer, 19 Nov 2026): with the board at 0
	// its standoffs stood in the pack and the pack's front in the sensor's bracket (the interference check found both).
	chassis: { plateMm: [150, 96], thicknessMm: 3, material: "PLA", clearanceMm: 50.5, boards: [{ name: "main", at: { xMm: -20, yMm: 0 }, rotDeg: 0 }] },
}
export const ROVER_BOARD = {
	requirements: { summary: "indoor rover that avoids walls and carries a temperature and humidity sensor", peripherals: ["i2c-sensor", "usb-c", "status-led", "motors", "distance-sensor"], batteryLifeDays: null, enclosure: "none" as const },
	outline: { widthMm: 60, heightMm: 40, thicknessMm: 1.6, sizeReason: { kind: "engineer-size" as const, detail: "the rover's chassis takes a 60 × 40 mm board" } },
	connectors: [
		LOGGER_DESIGN.connectors[0],
		{ ref: "JM1", kind: "header" as const, edge: "top" as const, offsetMm: 15, widthMm: 6, heightMm: 6 },
		{ ref: "JM2", kind: "header" as const, edge: "bottom" as const, offsetMm: 20, widthMm: 6, heightMm: 6 },
		{ ref: "JT1", kind: "header" as const, edge: "top" as const, offsetMm: 42, widthMm: 6, heightMm: 4.3 },
	],
	rails: [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 250, averageMa: 45 }],
	pins: ROVER_PINS,
	// The logger's parts without the USB-wake divider (R8, R9): the rover never deep-sleeps, so USB needs no wake line.
	parts: [
		...LOGGER_DESIGN.parts.filter((p) => !["R8", "R9"].includes(p.ref)),
		{ ref: "U5", role: "motor-driver", mpn: "DRV8833PWPR", lcsc: "C50506", footprint: "tssop16_w6.4mm_p0.65mm_thermalpad2.31mmx2.46mm", pins: ["nSLEEP", "AOUT1", "AISEN", "AOUT2", "BOUT2", "BISEN", "BOUT1", "nFAULT", "BIN1", "BIN2", "VCP", "VM", "GND", "VINT", "AIN2", "AIN1"] },
		{ ref: "JM1", role: "connector", mpn: "B2B-PH-K-S(LF)(SN)", lcsc: "C131337", footprint: "jst2_ph", pins: ["1", "2"] },
		{ ref: "JM2", role: "connector", mpn: "B2B-PH-K-S(LF)(SN)", lcsc: "C131337", footprint: "jst2_ph", pins: ["1", "2"] },
		{ ref: "JT1", role: "connector", mpn: "SM04B-SRSS-TB(LF)(SN)", lcsc: "C160404", footprint: "jst4_sh", pins: ["GND", "VCC", "IO1", "IO2"] },
	],
	motion: ROVER_MOTION,
	mechanics: ROVER_MECHANICS,
}

// The scripted four-wheel rover (briefs/rover-4wd.md): the reference rover's board with a second DRV8833 (U6) for the
// rear motors, whose inputs the generator ties to U5's (each side's two motors on one PWM), and plugs JM3 (rear left)
// and JM4 (rear right); skid-steer mechanics (drive.kind "skid4": four driven wheels, no caster) laid out by the solver
// for the brief's 8 mm edges, 200 × 180 mm and 1 kg. The firmware is the reference rover's, unchanged.
const encoderPlug = (ref: string) => ({ ref, role: "connector", mpn: "SM06B-SRSS-TB(LF)(SN)", lcsc: "C160405", footprint: "jst6_sh", pins: ["GND", "ENCB", "ENCA", "VCC", "M2", "M1"] })
export const FOUR_WD = /\b(4\s?wd|four[- ]wheel[- ]drive|skid[- ]steer)\b/i
const isRover4 = () => /four-wheel/i.test(state().contract.get("requirements")?.summary ?? "")
export const ROVER4_MOTION: ContractValues["motion"] = { ...ROVER_MOTION!, edgeMm: 8, maxSizeMm: [200, 180], maxMassG: 1000, drive: "skid4" }
// The layout solver's answer for these parts (src/mechanics/solve.ts, skid steer): wheelbase 0.71× the track, 22.7 mN·m
// per wheel for the 8 mm edge and 13.1 mN·m to turn in place against the 56.9 mN·m stall, 24 mm tipping margin.
export const ROVER4_MECHANICS: ContractValues["mechanics"] = {
	drive: { kind: "skid4", motor: "POLOLU-5139 100:1 MP 6V 12 CPR encoder", wheel: "POLOLU-1430 wheel 80x10 mm", caster: "", trackMm: 170, wheelbaseMm: 120, axleXMm: 60 },
	battery: { pack: "ADAFRUIT-2011 LP-803860 2000 mAh", at: { xMm: 65, yMm: 0 } },
	sensor: { module: "ADAFRUIT-3317 VL53L0X breakout (STEMMA QT)", at: { xMm: 98.6, yMm: 0, zMm: 62.7 }, connector: "JT1" },
	chassis: { plateMm: [200, 156], thicknessMm: 3, material: "PLA", clearanceMm: 45, boards: [{ name: "main", at: { xMm: 0, yMm: 0 }, rotDeg: 0 }] },
}
export const ROVER4_BOARD = {
	...ROVER_BOARD,
	requirements: { ...ROVER_BOARD.requirements, summary: "four-wheel skid-steer rover for rough floors that avoids walls and carries a temperature and humidity sensor" },
	outline: { widthMm: 70, heightMm: 45, thicknessMm: 1.6, sizeReason: { kind: "engineer-size" as const, detail: "the rover's chassis takes a 70 × 45 mm board" } },
	// Encoder gearmotors (the 5139: the 2367 with a 12 CPR encoder): the skid turn ends on the front wheels' counts, not
	// on a time (an open-loop skid turn tuned on one simulation cleared a wall by 20 mm). All four plugs are the 6-pin
	// SH; the front pair's channel A goes to GPIO0/GPIO1 (ENC_LA, ENC_RA); the rear encoders stay unwired.
	connectors: [
		...ROVER_BOARD.connectors.map((c) => (c.ref === "JM1" || c.ref === "JM2" ? { ...c, widthMm: 8, heightMm: 4.3 } : c)),
		{ ref: "JM3", kind: "header" as const, edge: "left" as const, offsetMm: 15, widthMm: 8, heightMm: 4.3 },
		{ ref: "JM4", kind: "header" as const, edge: "right" as const, offsetMm: 15, widthMm: 8, heightMm: 4.3 },
	],
	pins: [...ROVER_PINS, { signal: "ENC_LA", gpio: 0, partRef: "JM1", partPin: "ENCA" }, { signal: "ENC_RA", gpio: 1, partRef: "JM2", partPin: "ENCA" }],
	parts: [
		...ROVER_BOARD.parts.map((p) => (p.ref === "JM1" || p.ref === "JM2" ? encoderPlug(p.ref) : p)),
		{ ...ROVER_BOARD.parts.find((p) => p.ref === "U5")!, ref: "U6" },
		encoderPlug("JM3"),
		encoderPlug("JM4"),
	],
	motion: ROVER4_MOTION,
	mechanics: ROVER4_MECHANICS,
}

// The scripted Eurobot base (briefs/eurobot-base.md): the reference rover's board and drive with the competition's safety
// parts and rules. The emergency stop (catalog safety, the Omron A22E-M-01) on its printed deck 125 mm up, 20 mm ahead of
// the centre (its 54.7 mm body clears the board under it; with the deck's PLA, further forward tips it braking), with a 7 mm collar so its 32 mm head stands at most 25 mm over the robot (Eurobot General Rules
// 1.2 F.4.c); its plug JE1 in the motors' supply. The pull-cord start JS1 with START on GPIO10, a 600 mm cord and the
// 100 s match (F.6, H.3). motion.rules "eurobot-2026" checks it against the rules; 290 × 290 mm is the brief's square.
export const EUROBOT_BOARD = {
	...ROVER_BOARD,
	requirements: { ...ROVER_BOARD.requirements, summary: "Eurobot base robot: two-wheeled, finds its way on the table, stops for the opponent, with an emergency stop and a pull-cord start" },
	// Each encoder's channel A on a free pin (GPIO0, GPIO1: the ESP32-C3's last two besides the LED's GPIO3).
	// STATUS_LED on GPIO3 (the module's last free pin besides the GPIO2 strap): ready / running / stopped (status_led.h).
	pins: [...ROVER_PINS, { signal: "START", gpio: 10, partRef: "JS1", partPin: "START" }, { signal: "STATUS_LED", gpio: 3, partRef: "D1", partPin: "A" }, { signal: "ENC_LA", gpio: 0, partRef: "JM1", partPin: "ENCA" }, { signal: "ENC_RA", gpio: 1, partRef: "JM2", partPin: "ENCA" }],
	// The brief's "encoders on both drive wheels": the same 100:1 motors with a 12 CPR encoder, each on a 6-pin JST SH plug.
	// The brief's nice-to-haves: two servo plugs (JV1, JV2) and a spare motor plug (JM3, the 6-pin SH like the drive's).
	connectors: [
		...ROVER_BOARD.connectors.map((c) => (c.ref === "JM1" || c.ref === "JM2" ? { ...c, widthMm: 8, heightMm: 4.3 } : c)),
		{ ref: "JM3", kind: "header" as const, edge: "bottom" as const, offsetMm: 38, widthMm: 8, heightMm: 4.3 },
		{ ref: "JV1", kind: "header" as const, edge: "bottom" as const, offsetMm: 50, widthMm: 8.6, heightMm: 3.6 },
		{ ref: "JV2", kind: "header" as const, edge: "top" as const, offsetMm: 28, widthMm: 8.6, heightMm: 3.6 },
	],
	parts: [
		// Two servos and a spare motor through a PCA9685 on the I2C bus (the ESP32-C3 has no pins left: GPIO2 is a strap,
		// GPIO3 the LED): U7 drives JV1/JV2 on channels 0-1 and U6 (a second DRV8833) on 2-3; U9, a 5 V 5.5 A step-down
		// module, powers the servos and is switched off by the emergency stop through its EN.
		{ ref: "U6", role: "motor-driver", mpn: "DRV8833PWPR", lcsc: "C50506", footprint: "tssop16_w6.4mm_p0.65mm_thermalpad2.31mmx2.46mm", pins: ["nSLEEP", "AOUT1", "AISEN", "AOUT2", "BOUT2", "BISEN", "BOUT1", "nFAULT", "BIN1", "BIN2", "VCP", "VM", "GND", "VINT", "AIN2", "AIN1"], reason: "Brief (nice to have): \"a spare motor output\": its channel A, inputs from U7 channels 2-3" },
		{ ref: "U7", role: "pwm-driver", mpn: "PCA9685PW,118", lcsc: "C2678753", footprint: "tssop28_w6.4mm_p0.65mm", pins: ["A0", "A1", "A2", "A3", "A4", "LED0", "LED1", "LED2", "LED3", "LED4", "LED5", "LED6", "LED7", "VSS", "LED8", "LED9", "LED10", "LED11", "LED12", "LED13", "LED14", "LED15", "OE", "A5", "EXTCLK", "SCL", "SDA", "VDD"], reason: "Brief (nice to have): servo outputs and a spare motor: 16 PWM channels on the I2C bus, address 0x40" },
		{ ref: "U9", role: "servo-supply", mpn: "POLOLU-4091 D36V50F5", lcsc: null, footprint: "pinrow4", pins: ["EN", "VIN", "GND", "VOUT"], reason: "The servos' 5 V from the 2S pack, off when the emergency stop opens (its EN)" },
		{ ref: "JV1", role: "servo", mpn: "PZ254V-11-03P", lcsc: "C492402", footprint: "pinrow3", pins: ["SIG", "V5", "GND"], reason: "Brief (nice to have): servo output 1" },
		{ ref: "JV2", role: "servo", mpn: "PZ254V-11-03P", lcsc: "C492402", footprint: "pinrow3", pins: ["SIG", "V5", "GND"], reason: "Brief (nice to have): servo output 2" },
		{ ref: "JM3", role: "connector", mpn: "SM06B-SRSS-TB(LF)(SN)", lcsc: "C160405", footprint: "jst6_sh", pins: ["GND", "ENCB", "ENCA", "VCC", "M2", "M1"], reason: "Brief (nice to have): a spare motor output, the drive motors' 6-pin plug" },
		// The 2S pack ends in an XT60: the battery plug is the XT60PW-M that mates it, as the contract tools make it (power-auto.ts).
		...ROVER_BOARD.parts.map((p) => (p.role === "battery" ? { ...p, mpn: "XT60PW-M", lcsc: "C98732", footprint: "xt60pw_m", pins: ["GND", "VBAT"], reason: "The 2S pack's XT60 mates it directly: 30 A, where a JST PH carries 2 A (two servos at stall: 5.07 A)" } : p)).map((p) => (p.ref === "JM1" || p.ref === "JM2" ? { ...p, mpn: "SM06B-SRSS-TB(LF)(SN)", lcsc: "C160405", footprint: "jst6_sh", pins: ["GND", "ENCB", "ENCA", "VCC", "M2", "M1"], reason: `Brief: "encoders on both drive wheels": the ${p.ref === "JM1" ? "left" : "right"} encoder gearmotor's 6-pin plug (motor and encoder)` } : p)),
		{ ref: "JE1", role: "estop", mpn: "B2B-XH-A(LF)(SN)", lcsc: "C158012", footprint: "pinrow2_p2.5_id1_od1.8", pins: ["VBAT", "VM"], reason: "Brief: \"Pressing it cuts power to the motors at once\": the emergency stop's NC contact between the cell and the motor driver's VM" },
		{ ref: "JS1", role: "start", mpn: "PZ254V-11-02P", lcsc: "C492401", footprint: "pinrow2", pins: ["START", "GND"], reason: "Brief: \"Starts from a pull cord\": the cord's plug shorts START to GND until it is pulled" },
	],
	// The rules set no mass: 1500 g is this base's own target (it weighs about 1.2 kg with the beacon it must carry).
	motion: { ...ROVER_MOTION!, maxSizeMm: [290, 290] as [number, number], maxMassG: 1500, rules: "eurobot-2026", encoders: true as const },
	// Sized for the opponent's 400 g beacon at 430 mm (F.6) on a 70 mm printed mast at the centre (16 Nov): a 260 x 256 mm
	// plate on a 270 mm track (280 mm with the wheels, inside the 290 mm square), the axle 75 mm ahead of centre and the
	// caster 185 mm behind it (38 % of the weight on it), a two-cell pack and 150:1 12 V encoder gearmotors (64.8 of 72.6
	// mN·m per wheel at the 1.5x margin, 0.54 m/s), and the firmware's 1.5 m/s² ramp (braking hard at the floor's grip it
	// would tip: -34.7 mm; with the ramp the margin is 37.5 mm). The board behind the mast, the pack beside it, the e-stop
	// ahead of it, the sensor at the front edge.
	mechanics: {
		...ROVER_MECHANICS!,
		// The plate and track within a 256 mm printer bed (estimate printBedMm, 22 Nov 2026): 260 × 256 on a 270 mm track
		// printed 260 × 260 mm with the motor cradles; now 256 × 252 on 266 mm, the caster 180 mm behind the axle.
		drive: { ...ROVER_MECHANICS!.drive, motor: "POLOLU-5219 150:1 HPCB 12V 12 CPR encoder", trackMm: 266, wheelbaseMm: 180, axleXMm: 75, maxAccelMps2: 1.5 },
		battery: { pack: "GENSACE-GEA22002S20X6 2S 2200 mAh 20C LiPo XT60", at: { xMm: 0, yMm: 70 }, enclosure: "fireproof-bag" as const },
		sensor: { ...ROVER_MECHANICS!.sensor, at: { ...ROVER_MECHANICS!.sensor.at, xMm: 126.6 } },
		// gridMm: the brief's mounting grid (M3 holes on 20 mm wherever nothing stands) for the team's mechanism.
		chassis: { ...ROVER_MECHANICS!.chassis, plateMm: [256, 252] as [number, number], boards: [{ name: "main", at: { xMm: -90, yMm: 0 }, rotDeg: 0 as const }], gridMm: 20 },
		beacon: { at: { xMm: 0, yMm: 0 }, topMm: 430, sizeMm: 70, mastWallMm: 1.2, loadG: 400 },
		// The organisers' sticker (F.6: 100 × 70 mm left free on a side face): a panel on the rear, where nothing stands
		// outside it (the wheels are on the sides, the sensor at the front).
		sticker: { face: "rear" as const, widthMm: 100, heightMm: 70 },
		safety: { estop: { part: "OMRON A22E-M-01", at: { xMm: 75, yMm: 0, zMm: 125 }, connector: "JE1", collarMm: 7 }, start: { connector: "JS1", cordMm: 600, matchS: 100 } },
	},
}
const EUROBOT = /\beurobot\b/i
// A CNC brief (briefs/cnc.md, docs/cnc.md): the scripted design is the pipeline's test, not the product: what it writes by
// hand here is what the agents must learn to write (docs/cnc.md gap 2).
export const CNC_BRIEF = /\bCNC\b/
export const CNC_TARGETS: NonNullable<ContractValues["cncTargets"]> = { travelMm: { x: 300, y: 200, z: 50 }, footprintMm: [450, 350], rapidMmMin: 1500, feedMmMin: 600, cut: { material: "plywood", depthMm: 3, toolMm: 3.175 }, spindleW: 100, repeatMm: 0.05 }
const cncScrew = (mm: number) => `GOBILDA-3501-0804-0${mm} lead screw 8 mm lead ${mm} mm`
const cncAxis = (name: "x" | "y" | "z", travelMm: number, screwMm: number, uartAddr: number, motors: 1 | 2 = 1): NonNullable<ContractValues["cnc"]>["axes"][number] => ({ name, motor: "17HS15-1504S1", motors, screw: cncScrew(screwMm), rail: "HIWIN MGN12H", travelMm, homeAt: name === "z" ? "max" : "min", driver: { currentA: 1.2, microsteps: 16, uartAddr } })
// The machine meeting CNC_TARGETS from catalog/mechanics.json: each screw its travel plus 40 mm, Y a gantry on two motors.
export const CNC_MACHINE: NonNullable<ContractValues["cnc"]> = {
	axes: [cncAxis("x", 300, 400, 0), cncAxis("y", 200, 300, 1, 2), cncAxis("z", 50, 200, 2)],
	spindle: { part: "Genmitsu GS-775MR", volts: 24, watts: 75 },
	estop: "OMRON A22E-M-01 emergency stop 40 mm red, 1 NC",
	input: { kind: "dc-brick", volts: 24, amps: 6.67 },
	frame: { footprintMm: [450, 350], heightMm: 300 },
	boards: [{ name: "controller", at: { xMm: 380, yMm: 300 }, rotDeg: 0 }],
	firmware: "grblhal",
}

// The scripted desktop arm (briefs/arm.md; docs/superpowers/specs/2026-11-25-robot-arm-design.md). The architect's
// armTargets come from the brief (src/mechanics/brief.ts armTargetsFromBrief): reach 280 mm, 100 g, the cube picked at
// (150, -125, 15) and dropped at (150, 125, 60) mm, 250 mm apart, 5 times. The mechanics engineer's arm is the brief's
// servos as it names them (MG996R at the base, shoulder and elbow; SG90 at the wrist and gripper) on links of 120 + 110
// + 20 + 30 mm (280 mm from the shoulder axis to the grip point), the shoulder 60 mm over a 200 × 160 mm plate held down
// by its mass and 300 g of ballast, on PCA9685 channels 0..5, a 6 V rail and the brick the brief names: the Mean Well
// GST120A20, 20 V 6 A (120 W), ±5 % (catalog/mechanics.json powerBricks). The checks then say whether the brief's servos carry it (arm-torque names the servo that
// does when one doesn't), and the scripted engineer takes that servo.
export const ARM_SPEC: ArmSpec = {
	base: { plateMm: [200, 160], thicknessMm: 5, shoulderZMm: 60, holdDown: "mass", ballastG: 300 },
	joints: [
		{ name: "base-yaw", servo: "MG996R", channel: 0, linkMm: 0, minDeg: -60, maxDeg: 60 },
		{ name: "shoulder", servo: "MG996R", channel: 1, linkMm: 120, minDeg: 0, maxDeg: 120 },
		{ name: "elbow", servo: "MG996R", channel: 2, linkMm: 110, minDeg: -90, maxDeg: 30 },
		{ name: "wrist-pitch", servo: "SG90", channel: 3, linkMm: 20, minDeg: -120, maxDeg: 60 },
		{ name: "wrist-roll", servo: "SG90", channel: 4, linkMm: 30, minDeg: -90, maxDeg: 90 },
	],
	gripper: { servo: "SG90", channel: 5, openMm: 40, fingerMm: 30 },
	railV: 6,
	input: { kind: "dc-brick", volts: 20, amps: 6, mpn: "MEANWELL-GST120A20-P1M 20V 6A 120W power supply", tolerancePct: 5 },
	boards: [{ name: "main", at: { xMm: -60, yMm: 0 }, rotDeg: 0 }],
}
// The arm's controller: an ESP32-S3 (the plan's controller; its native USB programs it over the one USB-C) with the
// PCA9685 (U7) on its I2C bus, the 3.3 V LDO and the status LED. What the PCA9685 drives comes in code with each parts
// write once the arm exists (contract/power-auto.ts armOutputs: one plug per servo JV1..JV6, a 6 V SY8368A per rail and
// the brick's jack; armLogicTree: the logic's 5 V from the brick, OR'd with VBUS). No cell, so no charger, battery plug
// or charge LED, nor the passives only they use (the charge LED's R7 and PROG's R4); always awake, so no USB-sense
// divider (R8, R9). The 3V3 rail's peak covers the S3's 189 mA Bluetooth LE transmit with a fifth on top.
export const ARM_SUMMARY = /\bdesktop arm\b/i
export const ARM_BOARD = {
	requirements: { summary: "desktop arm that picks a cube and drops it into a cup: six hobby servos on a PCA9685, a 20 V 120 W brick, one USB-C", peripherals: ["usb-c", "status-led"], batteryLifeDays: null, enclosure: "none" as const },
	outline: { widthMm: 70, heightMm: 50, thicknessMm: 1.6 },
	connectors: [{ ref: "J1", kind: "usb-c" as const, edge: "left" as const, offsetMm: 25, widthMm: 9, heightMm: 3.5 }],
	// The brick's input as a rail, so the parts' nets on it (the rail chips' IN, the logic buck's VIN, the jack's VIN) are
	// wired: rated the brick's 6 A, its peak the servos at stall plus the logic (4.28 A at 20 V: the 4.39 A at 19.5 V of the
	// arm-supply figure at the same power).
	rails: [
		{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 230, averageMa: 100 },
		{ name: armInputNet, voltageV: 20, regulatorMaxMa: 6000, loadMa: 4280 },
	],
	pins: [
		{ signal: "I2C_SDA", gpio: 8, partRef: "U7", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 9, partRef: "U7", partPin: "SCL" },
	],
	parts: [
		{ ref: "U1", role: "mcu", mpn: "ESP32-S3-MINI-1", lcsc: "C2913206", footprint: "esp32_s3_mini_1", pins: ["GPIO0", "GPIO1", "GPIO2", "GPIO3", "GPIO4", "GPIO5", "GPIO6", "GPIO7", "GPIO8", "GPIO9", "GPIO10", "GPIO11", "GPIO12", "GPIO13", "GPIO14", "GPIO15", "GPIO16", "GPIO17", "GPIO18", "GPIO19", "GPIO20", "GPIO21", "GPIO26", "GPIO33", "GPIO34", "GPIO35", "GPIO36", "GPIO37", "GPIO38", "GPIO39", "GPIO40", "GPIO41", "GPIO42", "GPIO43", "GPIO44", "GPIO45", "GPIO46", "GPIO47", "GPIO48", "EN", "3V3", "GND"], reason: "Brief: \"One USB-C cable to program and talk to the board\": the ESP32-S3's native USB programs it with no bridge, and its dual core runs the arm's inverse kinematics and moves" },
		{ ref: "U7", role: "pwm-driver", mpn: "PCA9685PW,118", lcsc: "C2678753", footprint: "tssop28_w6.4mm_p0.65mm", pins: ["A0", "A1", "A2", "A3", "A4", "LED0", "LED1", "LED2", "LED3", "LED4", "LED5", "LED6", "LED7", "VSS", "LED8", "LED9", "LED10", "LED11", "LED12", "LED13", "LED14", "LED15", "OE", "A5", "EXTCLK", "SCL", "SDA", "VDD"], reason: "Brief: \"5 joints plus a gripper\" on \"hobby PWM servos\": six 50 Hz servo pulses on channels 0-5 from the I2C bus, address 0x40" },
		...LOGGER_DESIGN.parts.filter((p) => ["U3", "J1", "D1", "R1", "R2", "R3", "R5", "R6", "C1", "C2", "C3", "R10"].includes(p.ref)).map((p) =>
			p.ref === "J1" ? { ...p, reason: "Brief: \"One USB-C cable to program and talk to the board\"" } : p.ref === "D1" ? { ...p, reason: "Brief (nice to have): \"A status LED that shows ready, moving and fault\"" } : p.ref === "U3" ? { ...p, reason: "The 3.3 V rail for the S3 and the PCA9685 from the logic's 5 V, rated for the module's 0.5 A" } : p,
		),
	],
}
const isArm = () => ARM_SUMMARY.test(state().contract.get("requirements")?.summary ?? "") || Boolean(state().contract.get("armTargets"))
// The servo a joint's arm-torque violation names as the weakest that carries it ("the shoulder joint carries … the
// weakest catalog servo that carries it is DS3218MG"): the scripted engineer takes it.
export function armServoFixes(instruction: string): { joint: string; servo: string }[] {
	return [...instruction.matchAll(/^- arm-torque: the (base-yaw|shoulder|elbow|wrist-pitch|wrist-roll) joint carries .*the weakest catalog servo that carries it is (.+?)$/gm)].map((m) => ({ joint: m[1], servo: m[2] }))
}

// The brief's own size and mass over the reference rover's motion (briefs/rover.md: "about 15 × 12 cm", "under 500 g";
// briefs/rover-pi.md: a bigger rover for a Raspberry Pi). The other targets stay the reference rover's.
export function motionFromBrief(brief: string): NonNullable<ContractValues["motion"]> {
	if (EUROBOT.test(brief)) return EUROBOT_BOARD.motion
	if (FOUR_WD.test(brief)) return ROVER4_BOARD.motion
	const base = ROVER_MOTION!
	const size = /(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*cm\b/.exec(brief)
	const mass = /\bunder\s+(\d+(?:\.\d+)?)\s*(kg|g)\b/i.exec(brief)
	return {
		...base,
		...(size ? { maxSizeMm: [Number(size[1]) * 10, Number(size[2]) * 10] as [number, number] } : {}),
		...(mass ? { maxMassG: Number(mass[1]) * (mass[2].toLowerCase() === "kg" ? 1000 : 1) } : {}),
	}
}

// A robot with a bought compute board (a Raspberry Pi…, src/system/bought.ts) runs on the catalog's 2S pack through the
// catalog's 5 V regulator, with 12 V gearmotors (the 6 V ones see 1.4× their rating on a full 2S pack). Each is read
// from catalog/mechanics.json by its mpn; no number is copied here.
export const COMPUTE_ROVER_MOTOR = "POLOLU-3041 100:1 HPCB 12V"
export const COMPUTE_ROVER_PACK = "GENSACE-GEA22002S20X6"
export const COMPUTE_ROVER_REGULATOR = "POLOLU-4091 D36V50F5"

// True when the robot's body holds a bought board: a HAT carrier carries one, and a bought board brings its record's
// mounting holes (src/system/assembly.ts defaultAssembly).
export const carriesCompute = (a: ContractValues["assembly"] | undefined): boolean => Boolean(a?.boards.some((b) => b.carries || (b.holes && b.name !== a.self)))

// The compute rover's mechanics: the reference rover's wheels, caster and sensor with the motor, pack and regulator above,
// laid out by the chassis solver on the system's plate (the pack beside the boards: it is too thick to go under them).
export function computeRoverMechanics(c: ContractSnapshot, cat: CheckCatalog | null = defaultCheckCatalog()): (NonNullable<ContractValues["mechanics"]> & { regulator: string }) | null {
	if (!cat) return null
	const motor = byMpn(cat.mech.motors, COMPUTE_ROVER_MOTOR), pack = byMpn(cat.mech.batteries, COMPUTE_ROVER_PACK), reg = byMpn(cat.mech.regulators ?? [], COMPUTE_ROVER_REGULATOR)
	if (!motor || !pack || !reg) return null
	const r = ROVER_MECHANICS!
	const s = solveChassis(c, { motor: motor.mpn, wheel: r.drive.wheel, caster: r.drive.caster, pack: pack.mpn, sensor: r.sensor.module, connector: r.sensor.connector }, cat)
	return s.mechanics ? { ...s.mechanics, regulator: reg.mpn } : null
}

// Whether the scripted mechanics engineer lays out the compute rover (the 2S pack, regulator, 12 V motors) now: once per
// run, when there is no mechanics yet or only the reference rover it chose before the system's body arrived. Never
// again after that: a pack a change request chose stays (premerge review, 15 Nov: every consistency wake re-proposed
// the 2S layout, reverting the engineer's pack).
export function picksComputeMechanics(current: ContractValues["mechanics"] | undefined, pickedBefore: boolean): boolean {
	if (pickedBefore) return false
	if (!current) return true
	const ref = ROVER_MECHANICS!
	return current.battery.pack === ref.battery.pack && current.drive.motor === ref.drive.motor
}

// The scripted HAT: a carrier brief (src/system/carrier.ts carrierBrief) read back into a design. Every number comes
// from the brief, which is written from the module record, so any compute module's carrier gets its own.
export const HAT_HEADER_MPN = "ADAFRUIT-2223"
// The HAT's 5 V input: a 2-pin screw terminal rated well above the module's 5 A (catalog/parts.json).
export const HAT_INPUT_MPN = "KF301-5.0-2P"
export interface HatBrief {
	module: string
	outline: { widthMm: number; heightMm: number }
	holes: { x: number; y: number; dia: number | null }[]
	header: { xMm: number; yMm: number }
	supply: { volts: number; amps: number; pins: number[]; ground: number[] }
}
const numbers = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
// null when the brief isn't a carrier brief at all; a carrier brief missing a value the HAT needs (no holes, an unknown
// peak current, "?" for the supply pins) throws, naming it, instead of the architect falling back to the generic logger.
export function hatFromBrief(brief: string): HatBrief | null {
	const title = /^# Brief: carrier for the (.+) \(.+\)$/m.exec(brief)
	if (!title) return null
	const outline = /own outline and holes, so the two stack:\*\* ([\d.]+) × ([\d.]+) mm, with \d+ (?:Ø([\d.]+) mm mounting holes|mounting holes of unknown diameter[^)]*\)) at ((?:\([\d.]+, [\d.]+\)(?:, )?)+) mm/.exec(brief)
	const header = /female stacking header[^\n]*?centred at \(([\d.]+), ([\d.]+)\) mm/.exec(brief)
	const supply = /5 V supply: ([\d.]+) A at ([\d.]+) V\*\*[^\n]*?into header pins ([\d, and]+) \(5V\), ground on pins ([\d, and]+)\./.exec(brief)
	const missing = [
		!outline && "the module's outline and mounting holes (\"own outline and holes, so the two stack: W × H mm, with N ØD mm mounting holes at (x, y), … mm\")",
		!header && "the 40-pin header's place (\"female stacking header … centred at (x, y) mm\")",
		!supply && "the 5 V supply's current and header pins (\"5 V supply: A at V … into header pins …, ground on pins ….\"; the module's peak current or its 5 V and ground pins are unknown)",
	].filter(Boolean)
	if (!outline || !header || !supply) throw new Error(`the carrier brief for the ${title[1]} lacks ${missing.join("; and ")}: the scripted HAT reads every number from it, so it can't design the carrier`)
	const xy = numbers(outline[4])
	const dia = outline[3] === undefined ? null : Number(outline[3])
	const holes = Array.from({ length: xy.length / 2 }, (_, i) => ({ x: xy[2 * i], y: xy[2 * i + 1], dia }))
	return {
		module: title[1],
		outline: { widthMm: Number(outline[1]), heightMm: Number(outline[2]) },
		holes,
		header: { xMm: Number(header[1]), yMm: Number(header[2]) },
		supply: { amps: Number(supply[1]), volts: Number(supply[2]), pins: numbers(supply[3]), ground: numbers(supply[4]) },
	}
}

// The HAT's contract: the module's outline and holes (a standard fit: the space rules keep it), the 40-pin header at the
// record's place, and the 5 V rail sized from the module's peak. No MCU: the board only carries power.
export function hatDesign(h: HatBrief) {
	const header = CATALOG.find((p) => p.mpn === HAT_HEADER_MPN)
	if (!header) throw new Error(`catalog/parts.json has no ${HAT_HEADER_MPN}`)
	const input = CATALOG.find((p) => p.mpn === HAT_INPUT_MPN)
	if (!input) throw new Error(`catalog/parts.json has no ${HAT_INPUT_MPN}`)
	// The header's pins are the module's own numbers: the brief's 5 V pins carry the rail, its ground pins ground.
	const headerNets = Object.fromEntries([...h.supply.pins.map((n) => [String(n), "5V"]), ...h.supply.ground.map((n) => [String(n), "GND"])])
	const and = (xs: number[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : String(xs[0]))
	return {
		requirements: { summary: `HAT for the ${h.module}: ${h.supply.volts} V from the robot's battery into its 40-pin header`, peripherals: [] as string[], batteryLifeDays: null, enclosure: "none" as const, size: { ...h.outline, exact: true } },
		outline: { ...h.outline, thicknessMm: 1.6, holes: h.holes, sizeReason: { kind: "standard-fit" as const, detail: `the ${h.module}'s own outline and mounting holes, so the HAT stacks on it` } },
		connectors: [] as ContractValues["connectors"],
		rails: [{ name: "5V", voltageV: h.supply.volts, regulatorMaxMa: h.supply.amps * 1000, loadMa: h.supply.amps * 1000 }],
		pins: [] as ContractValues["pins"],
		parts: [
			{
				ref: "J1",
				role: "connector",
				mpn: header.mpn,
				lcsc: header.lcsc ?? null,
				footprint: header.footprint,
				pins: [...header.pins],
				at: { xMm: h.header.xMm, yMm: h.header.yMm },
				reason: `The ${h.module}'s 40-pin header, female, on the underside where the ${h.module}'s pins meet it: ${h.supply.volts} V in on pins ${and(h.supply.pins)}, ground on pins ${and(h.supply.ground)} (the carrier brief)`,
				nets: headerNets,
			},
			{
				ref: "J2",
				role: "connector",
				mpn: input.mpn,
				lcsc: input.lcsc ?? null,
				footprint: input.footprint,
				pins: [...input.pins],
				reason: `The ${h.supply.volts} V input from the robot's step-down regulator: ${h.supply.amps} A for the ${h.module}, on a screw terminal rated 17 A (the carrier brief)`,
				nets: { VIN: "5V" },
			},
		] as NonNullable<ContractValues["parts"]>,
	}
}

// "add a temperature/humidity sensor": the logger's SHT40 with its two I2C pull-ups, on the logger's I2C pins.
export const ADD_SENSOR_REQUEST = /add .*(temp|humid|sensor)/i
const SENSOR_PARTS = LOGGER_DESIGN.parts.filter((p) => ["U2", "R5", "R6"].includes(p.ref))
const SENSOR_PINS = LOGGER_DESIGN.pins.filter((p) => p.partRef === "U2")

// Which scripted design a brief gets: the beacon for a brief that says so, the logger for anything else.
export const scriptedDesignFor = (brief: string): typeof LOGGER_DESIGN & Partial<Pick<ContractValues, "motion">> =>
	armTargetsFromBrief(brief) ? (ARM_BOARD as unknown as typeof LOGGER_DESIGN) : EUROBOT.test(brief) ? (EUROBOT_BOARD as unknown as typeof LOGGER_DESIGN & Pick<ContractValues, "motion">) : FOUR_WD.test(brief) ? (ROVER4_BOARD as unknown as typeof LOGGER_DESIGN & Pick<ContractValues, "motion">) : /\brover\b/i.test(brief) ? (ROVER_BOARD as unknown as typeof LOGGER_DESIGN & Pick<ContractValues, "motion">) : CNC_BRIEF.test(brief) ? (/\bESP32\b/.test(brief) ? CNC_FLUIDNC_DESIGN : CNC_DESIGN) : /\bbeacon\b/i.test(brief) ? BEACON_DESIGN : /\bSTM32\b/i.test(brief) ? STM32_LOGGER_DESIGN : LOGGER_DESIGN
// A robot's requirements ask for motors (briefs/rover.md).
const isRover = () => (state().contract.get("requirements")?.peripherals ?? []).includes("motors")
const isEurobot = () => EUROBOT.test(state().contract.get("requirements")?.summary ?? "")

// The beacon's parts for its current requirements: with a sensor once the requirements ask for one.
function beaconParts(): ContractValues["parts"] {
	const sensing = state().contract.get("requirements")?.peripherals.includes("i2c-sensor")
	return sensing ? [...BEACON_DESIGN.parts, ...SENSOR_PARTS] : BEACON_DESIGN.parts
}
const isBeacon = () => (state().contract.get("requirements")?.peripherals ?? []).includes("button")

const STATUS_LED = { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }

// "add a wake word": the ml agent writes a keyword-spotting model (sizes planned from MLPerf Tiny's DS-CNN keyword
// spotter, int8), always listening; the checks then wake parts (no microphone), the architect (its I2S lines, and the
// battery target always-on listening can't meet). Each step is the owner's own field.
export const DATA_RECORDED_REQUEST = /\bdata (?:is |was |has been )?recorded|recorded the (?:training )?data/i
// "add a production test" / "we need a test fixture": the test agent's request.
export const TEST_REQUEST = /(production|factory|end.of.line) test|test (fixture|jig|kit|pads?)|bed.of.nails|pogo/i

// The test agent's fix for its own violations: probe every net the design has (dropping ones it lost, adding new ones,
// in the design's order), keep limits at least the design's own currents with margin, and drop what can't be placed.
function followDesign(t: ContractValues["test"]): ContractValues["test"] {
	const s = state().contract.snapshot()
	const { signals, power } = probeableNets(s)
	const wanted = [...signals, ...power.filter((n) => n !== "VBUS" || t.points.includes("VBUS"))]
	const { awakeMa, sleepUa } = expectedCurrents(s)
	const next = {
		points: [...t.points.filter((p) => wanted.includes(p)), ...wanted.filter((p) => !t.points.includes(p))],
		awakeMaxMa: awakeMa !== null && t.awakeMaxMa < awakeMa ? Math.ceil(awakeMa * 1.2) : t.awakeMaxMa,
		sleepMaxUa: sleepUa !== null && t.sleepMaxUa < sleepUa ? Math.ceil(sleepUa * 1.5) : t.sleepMaxUa,
	}
	const { unplaced } = testPoints({ ...s, values: { ...s.values, test: next } })
	return { ...next, points: next.points.filter((p) => !unplaced.includes(p)) }
}

// The model's data on the sensor path the contract describes now, or null when there is none to record on.
function dataOn(status: "recorded" | "needed") {
	const s = state().contract.snapshot()
	const path = sensorPath(s)
	return path ? { status, revision: s.revision, pathHash: pathHash(path), path } : null
}
// A request about the case: the case designer's. Its size, walls, height, lid, lettering, tabs, loops and holes.
// Who houses the board, from a brief or a request: "none" for a bare board, "own" for the engineer's own housing,
// "case" when it asks for ours; null when it doesn't say.
export function enclosureFromText(t: string): EnclosureMode | null {
	if (/bare board|no (case|enclosure|housing)\b|without (a |any )?(case|enclosure)|drop the case|remove the case/i.test(t)) return "none"
	if (/\b(our|my|their) own (housing|enclosure|case)\b|existing (housing|enclosure|product)/i.test(t)) return "own"
	if (/\bcase\b/i.test(t)) return "case"
	return null
}
// A request that changes whether there is a case at all: the architect's requirements.enclosure, not the case field.
export const ENCLOSURE_MODE_REQUEST = /bare board|no (case|enclosure)\b|without (a |any )?(case|enclosure)|drop the case|remove the case|own (housing|enclosure)|existing (housing|enclosure|product)|(add|bring back|we want) (a|the) case/i
// The scripted architect's answer to a board's links (docs/system.md): the link connector on an edge (the link's own, or
// the first with no connector, top first), then a UART link's TX and RX on free GPIOs. One field per turn.
// Free pins for a link's signals, in the order asked: the ESP32-C3's link GPIOs as always (its matrix routes any
// peripheral anywhere); on another chip its profile's solver, so a UART's TX and RX land on one instance's pins.
function linkPins(s: ContractSnapshot, needs: Need[], taken: number[]): number[] | null {
	const chip = mcuProfileOf(s.values.parts)
	if (!chip || chip.id === LEGACY_MCU_ID) return FREE_GPIOS.filter((g) => !taken.includes(g))
	const r = solvePins(chip, needs, [...taken, ...nativeUsbIndexes(s)])
	return r.ok ? r.pins.map((p) => p.index) : null
}

export function linkProposal(s: ContractSnapshot): { field: "connectors" | "pins"; value: unknown; reason: string } | null {
	const { connectors = [], pins = [], parts = [] } = s.values
	for (const l of s.values.links ?? []) {
		if (!parts.some((p) => p.ref === l.connector)) continue // the part selector adds it first
		if (!connectors.some((k) => k.ref === l.connector)) {
			const o = s.values.outline
			const edge = l.edge ?? (["top", "bottom", "right", "left"] as const).find((e) => !connectors.some((k) => k.edge === e)) ?? "top"
			const along = o ? (edge === "left" || edge === "right" ? o.heightMm : o.widthMm) / 2 : 10
			return { field: "connectors", value: [...connectors, { ref: l.connector, kind: "header", edge, offsetMm: along, widthMm: 5.8, heightMm: 3 }], reason: `${l.id}'s connector on the ${edge} edge, so the cable leaves there` }
		}
		// An I2C link on a board with no bus yet: I2C_SDA and I2C_SCL straight to the connector.
		if (l.kind === "i2c" && !pins.some((p) => p.signal === "I2C_SDA")) {
			const used = new Set(pins.map((p) => p.gpio))
			const free = linkPins(s, [{ signal: "I2C_SDA", kind: "i2c", role: "SDA", group: "I2C" }, { signal: "I2C_SCL", kind: "i2c", role: "SCL", group: "I2C" }], [...used])
			if (!free || free.length < 2) return null
			return { field: "pins", value: [...pins, { signal: "I2C_SDA", gpio: free[0], partRef: l.connector, partPin: "IO1" }, { signal: "I2C_SCL", gpio: free[1], partRef: l.connector, partPin: "IO2" }], reason: `${l.id}'s I2C bus: SDA and SCL to the connector` }
		}
		// A CAN link: the controller's TX to the transceiver's D and RX from its R, once per board (a bus's segments share
		// one transceiver and one controller, and the signals are named after the bus).
		if (l.kind === "can") {
			const xcvr = (s.values.parts ?? []).find((p) => p.role === "can-transceiver")
			if (!xcvr) continue
			const sig = canSignals(l)
			const want = [{ signal: sig.tx, partPin: "D" }, { signal: sig.rx, partPin: "R" }]
			if (want.every((w) => pins.some((p) => p.signal === w.signal && p.partRef === xcvr.ref && p.partPin === w.partPin))) continue
			const kept = pins.filter((p) => !want.some((w) => w.signal === p.signal))
			const used = new Set(kept.map((p) => p.gpio))
			const free = linkPins(s, want.map((w) => ({ signal: w.signal, kind: "can" as const, role: w.partPin === "D" ? "TX" : "RX", group: canName(l) })), [...used])
			if (!free || free.length < 2) return null
			return { field: "pins", value: [...kept, ...want.map((w, i) => ({ signal: w.signal, gpio: free[i], partRef: xcvr.ref, partPin: w.partPin }))], reason: `${canName(l)}'s CAN: the controller's TX to ${xcvr.ref}.D and RX from ${xcvr.ref}.R` }
		}
		if (l.kind === "uart" && l.txOn) {
			const want = [
				{ signal: `${l.id}_TX`, partPin: l.txOn },
				{ signal: `${l.id}_RX`, partPin: l.txOn === "IO1" ? "IO2" : "IO1" },
			]
			if (want.every((w) => pins.some((p) => p.signal === w.signal && p.partRef === l.connector && p.partPin === w.partPin))) continue
			const kept = pins.filter((p) => !want.some((w) => w.signal === p.signal))
			const used = new Set(kept.map((p) => p.gpio))
			const free = linkPins(s, want.map((w) => ({ signal: w.signal, kind: "uart" as const, role: w.signal.endsWith("_TX") ? "TX" : "RX", group: l.id })), [...used])
			if (!free || free.length < 2) return null
			return { field: "pins", value: [...kept, ...want.map((w, i) => ({ signal: w.signal, gpio: free[i], partRef: l.connector, partPin: w.partPin }))], reason: `${l.id}'s UART: TX and RX on the connector pins the system gives` }
		}
	}
	return null
}

export const CASE_REQUEST = /\b(case|enclosure|housing|lid)\b|wall.?mount|lanyard|key ?ring|cable gland/i
const EDGE_ORDER = ["right", "top", "bottom", "left"] as const

// The case's outer width a request asks for ("make the case 45 mm wide"), if any.
export function requestedCaseWidth(request: string): number | null {
	const m = /(\d+(?:\.\d+)?)\s*mm wide/i.exec(request)
	return m && CASE_REQUEST.test(request) ? Number(m[1]) : null
}

const clean = (c: CaseSpec, s: ContractSnapshot, id: string) => !caseChecks({ ...s, values: { ...s.values, case: c } }).some((v) => v.message.includes(` ${id} `) || v.message.startsWith(`${id} `))

// Puts a hole where it fits: its own edge first, from the middle outwards in 1 mm steps, then the other edges.
type Edge = (typeof EDGE_ORDER)[number]
function placeHole(c: CaseSpec, s: ContractSnapshot, id: string, edges: readonly Edge[]): CaseSpec {
	const outline = s.values.outline!
	for (const edge of edges) {
		const len = edge === "left" || edge === "right" ? outline.heightMm : outline.widthMm
		for (let k = 0; k <= len; k++) {
			const offsetMm = Math.round(len / 2 + (k % 2 === 0 ? k / 2 : -(k + 1) / 2))
			const next = { ...c, features: c.features.map((f) => (f.id === id && f.kind === "hole" ? { ...f, edge, offsetMm } : f)) }
			if (clean(next, s, id)) return next
		}
	}
	return c
}

// The scripted case designer's reading of a request: the new case field. Deterministic, like every mock script.
export function caseFromRequest(request: string, s: ContractSnapshot): CaseSpec {
	let c: CaseSpec = structuredClone(caseOf(s))
	const connectorEdges = new Set((s.values.connectors ?? []).map((k) => k.edge))
	const walls = /(\d+(?:\.\d+)?)\s*mm(?: thick)? walls?/i.exec(request)
	if (walls) c.wallMm = Number(walls[1])
	else if (/(thicker|sturdier|stronger) walls?/i.test(request)) c.wallMm = Math.min(4, c.wallMm + 1)
	else if (/thinner walls?/i.test(request)) c.wallMm = Math.max(1.2, c.wallMm - 0.5)
	const tall = /(\d+(?:\.\d+)?)\s*mm (?:tall|high)/i.exec(request)
	if (tall) c.heightMm = Number(tall[1])
	else if (/\b(taller|higher)\b/i.test(request)) c.heightMm += 4
	// The engineer's own height is the reason the body is that tall (space rules).
	if (tall || /\b(taller|higher)\b/i.test(request)) c.sizeReason = { kind: "engineer-size", detail: `the engineer asked: ${request}` }
	else if (/\b(lower|slimmer|flatter|thinner case)\b/i.test(request)) c.heightMm = Math.max(minCaseHeight(s, c), c.heightMm - 3)
	const add = (f: CaseSpec["features"][number]) => (c = { ...c, features: [...c.features.filter((x) => x.id !== f.id), f] })
	if (/wall.?mount|mounting (tabs?|ears?)|screw it to a wall/i.test(request))
		add({ id: "wall-mount", kind: "wall-mount", sides: connectorEdges.has("left") || connectorEdges.has("right") ? "top-bottom" : "left-right" })
	if (/lanyard|key ?ring|strap/i.test(request)) {
		const corner = (["top-right", "bottom-right", "top-left", "bottom-left"] as const).find((k) => !connectorEdges.has(k.endsWith("left") ? "left" : "right")) ?? "top-right"
		add({ id: "lanyard", kind: "lanyard", corner })
	}
	const quoted = /["“']([^"”']{1,24})["”']/.exec(request)?.[1]?.replace(/[^A-Za-z0-9 .,:!?&+#/-]/g, "").trim()
	if (quoted && /engrave|text|label|logo|write|name|letter/i.test(request)) add({ id: "label", kind: "text", text: quoted })
	if (/cable gland|\bhole\b/i.test(request)) {
		// An M12 cable gland (the common size for a 3-6.5 mm cable) wants a 12.2 mm hole: a typical figure, check the
		// gland's datasheet. A plain cable hole: 6 mm.
		const given = /(\d+(?:\.\d+)?)\s*mm (?:hole|gland|cable gland)/i.exec(request)
		const diameterMm = given ? Number(given[1]) : /gland/i.test(request) ? 12.2 : 6
		const asked = /on the (left|right|top|bottom)/i.exec(request)?.[1]?.toLowerCase() as Edge | undefined
		const edge = asked ?? EDGE_ORDER.find((e) => !connectorEdges.has(e)) ?? "right"
		const id = `hole-${c.features.filter((f) => f.kind === "hole").length + 1}`
		// A hole this big needs this much wall between the floor and the lid's lip.
		c.heightMm = Math.max(c.heightMm, Math.ceil(diameterMm + 1 + LID.lipMm + c.wallMm))
		add({ id, kind: "hole", edge, offsetMm: 0, diameterMm })
		c = placeHole(c, s, id, asked ? [asked] : [edge, ...EDGE_ORDER.filter((e) => e !== edge)])
	}
	return c
}

// The scripted case designer's fix for its own violations: a body tall enough, every hole moved to where it fits.
function caseFollows(s: ContractSnapshot): CaseSpec {
	let c: CaseSpec = structuredClone(caseOf(s))
	const need = minCaseHeight(s, c)
	// Compact by default: a body taller than its contents need, with no reason, comes down to what they need.
	c.heightMm = !c.sizeReason && c.heightMm > need * (1 + SLACK_LIMIT) ? Math.ceil(need) : Math.max(c.heightMm, need)
	for (const f of c.features) if (f.kind === "hole" && !clean(c, s, f.id)) c = placeHole(c, s, f.id, [f.edge, ...EDGE_ORDER.filter((e) => e !== f.edge)])
	return c
}

// A request about how the device connects: the connectivity engineer's.
export const CONNECTIVITY_REQUEST = /home assistant|bthome|wi-?fi|mqtt|bluetooth|\bble\b|\bota\b|firmware updates?|over.the.air|phone app/i

// The scripted connectivity engineer's reading of a request. Home Assistant without Wi-Fi: BTHome over Bluetooth LE
// (no app, no hub beyond Home Assistant's own Bluetooth). Wi-Fi or MQTT: MQTT with Home Assistant discovery, hourly
// unless the request says how often. Updates need Wi-Fi.
export function connectivityFromRequest(request: string, current: ContractValues["connectivity"] | undefined): ContractValues["connectivity"] {
	const wantsUpdates = /\bota\b|firmware updates?|over.the.air|update(?:s|d)? in the field/i.test(request)
	if (/wi-?fi|mqtt/i.test(request) || wantsUpdates) {
		const every = /every (\d+) ?(min|minute|minutes|h|hour|hours)\b/i.exec(request)
		const uploadPeriodS = every ? Number(every[1]) * (/^h/i.test(every[2]) ? 3600 : 60) : current?.uploadPeriodS ?? 3600
		return { radio: "wifi", report: ["mqtt"], uploadPeriodS, updates: wantsUpdates ? "ota" : current?.updates === "ota" ? "ota" : "none" }
	}
	const report = new Set<"gatt" | "bthome">(current?.radio === "ble" ? (current.report as ("gatt" | "bthome")[]) : ["gatt"])
	if (/home assistant|bthome/i.test(request)) report.add("bthome")
	return { radio: "ble", report: [...report], updates: "none" }
}

export const WAKE_WORD_REQUEST = /wake ?word|keyword|voice command|listen for/i
export const WAKE_WORD_MODEL = { task: "wake word", sensor: "microphone", sampleRateHz: 16000, windowMs: 1000, channels: 1, weightsKb: 53, arenaKb: 23, runtime: "tflite-micro", quantization: "int8", listening: "always" } as const
export const MIC_PART = { ref: "U5", role: "microphone", mpn: "ICS-43434", lcsc: "C5656610", footprint: "ics43434", pins: ["WS", "LR", "GND", "SCK", "VDD", "SD"] }
export const MIC_PINS = [
	{ signal: "MIC_SCK", gpio: 4, partRef: "U5", partPin: "SCK" },
	{ signal: "MIC_WS", gpio: 5, partRef: "U5", partPin: "WS" },
	{ signal: "MIC_SD", gpio: 6, partRef: "U5", partPin: "SD" },
]
const violationKinds = (instruction: string) => new Set([...instruction.matchAll(/^- ([\w-]+):/gm)].map((m) => m[1]))

function text(item: ContextItem | undefined): string {
	if (item instanceof UserMessageItem) return item.content.text
	if (item instanceof FunctionCallOutputItem) return item.output.text
	return ""
}

// Tool outputs since the last instruction to this turn.
function stepsTaken(items: ContextItem[]): number {
	const start = items.findLastIndex((i) => i instanceof UserMessageItem)
	return items.slice(start + 1).filter((i) => i instanceof FunctionCallOutputItem).length
}

const say = (t: string) => [ModelMessageItem.rehydrate({ text: t })]

function propose(field: FieldName, value: unknown, reason: string) {
	return [toolCall("propose_contract_change", { field, value, baseVersion: state().contract.version(field), reason })]
}

// The catalog the scripted parts agent swaps from (hand entries, then learned parts).
const CATALOG = loadCatalog(resolve(import.meta.dirname, "../.."))

const ARCHITECT_FIELDS = ["requirements", "outline", "connectors", "rails", "pins"] as const satisfies FieldName[]

// Deterministic stand-ins for each role's model, so a full run needs no API key.
export function mockScripts(): Record<string, Script> {
	// The outline the scripted architect shrank from, until it has moved the connectors to match (space rules).
	let shrinkFrom: { widthMm: number; heightMm: number; connectors: NonNullable<ContractValues["connectors"]> } | null = null
	// How many times the scripted architect has widened the board after a failed DRC in this run.
	let drcGrows = 0
	// Whether the compute rover's layout has reached the contract in this run (the scripted mechanics engineer picks it once).
	let computePicked = false
	// The scripted HAT this run designs, once the architect has read a carrier brief (the parts agent places its header).
	let hat: ReturnType<typeof hatDesign> | null = null
	// The engineer's swaps in this run (ref → the catalog part that took its place), kept so a later wake-up of the
	// scripted parts agent doesn't put the old part back.
	const swapped = new Map<string, NonNullable<ContractValues["parts"]>[number]>()
	// Parts the engineer placed on the board page (parts[].at): kept on every later wake, like a swap.
	const pinned = new Map<string, NonNullable<NonNullable<ContractValues["parts"]>[number]["at"]>>()
	const withSwaps = <T extends { ref: string }>(list: T[]): T[] =>
		list.map((p) => {
			const q = (swapped.get(p.ref) as T | undefined) ?? p
			const at = pinned.get(p.ref)
			return at ? { ...q, at } : q
		})
	return {
		"mock-architect": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			if (instruction.startsWith("Consistency violations for you")) {
				const kinds = violationKinds(instruction)
				const pins = state().contract.get("pins") ?? []
				const requirements = state().contract.get("requirements")
				const model = state().contract.get("model")
				if (step === 0 && (kinds.has("link-connector-missing") || kinds.has("link-unwired"))) {
					const next = linkProposal(state().contract.snapshot())
					if (next) return propose(next.field, next.value as never, next.reason)
				}
				if (step === 0 && kinds.has("model-sensor-unwired") && !pins.some((p) => p.signal === "MIC_SD")) return propose("pins", [...pins, ...MIC_PINS], "the microphone's I2S SCK, WS and SD on GPIO4-6, free of the I2C bus and the LED")
				// Always-on listening keeps the MCU awake: no cell this size meets the target, so the design runs from USB.
				if (step === 0 && kinds.has("battery-short") && model?.listening === "always" && requirements && requirements.batteryLifeDays !== null)
					return propose(
						"requirements",
						{ ...requirements, summary: `${requirements.summary}, listening for a wake word (always on, so powered from USB)`, peripherals: [...new Set([...requirements.peripherals, "microphone"])], batteryLifeDays: null },
						"always-on listening keeps the MCU awake at about 28 mA: the battery lasts under a day, so the target becomes USB power",
					)
				// No reason for the board's slack: shrink it to the smallest it can be, connectors first when the height changes.
				// The rail's peak below the radio's transmit peak: raise it to that, with a fifth on top for the rest.
				const under = /^- rail-underrated: rail (\S+) is sized for a [\d.]+ mA peak, below (\d+) mA/m.exec(instruction)
				const railsNow = state().contract.get("rails")
				if (step === 0 && under && railsNow) {
					const need = Math.ceil((Number(under[2]) * 1.2) / 10) * 10
					return propose("rails", railsNow.map((r) => (r.name === under[1] ? { ...r, loadMa: Math.max(r.loadMa, need) } : r)), `the radio's transmit peak is ${under[2]} mA: the rail's peak covers it, with a fifth on top for the rest of the board`)
				}
				// KiCad's DRC failed on the board at this size: room for the router, 2 mm wider at a time, with the failed
				// build as the reason (space rules: a measured routing failure). Five tries, then it stops and says so.
				const drcLine = /^- drc-errors: (.*)$/m.exec(instruction)?.[1]
				const now = state().contract.get("outline")
				if (step === 0 && drcLine && now) {
					if (drcGrows >= 5) return say("can't route it")
					drcGrows++
					const build = /^(the [\d.]+×[\d.]+ mm board \(rev \d+\))/.exec(drcLine)?.[1] ?? "the last build"
					// The first error runs to the sentence that follows it (it has decimals of its own: "actual 0.1412 mm").
					const first = /first: (.*?)\. Give the router room/.exec(drcLine)?.[1]
					return propose("outline", { ...now, widthMm: now.widthMm + 2, sizeReason: { kind: "routing", detail: `${build} failed KiCad DRC${first ? `: ${first}` : ""}` } }, `2 mm wider so the router has room: ${build} failed DRC`)
				}
				// The outline first, then the connectors scaled from the old outline to the new one: their place along each
				// edge stays the same. (Moving the connectors first changed the minimum under the next turn.)
				const o = state().contract.get("outline")
				if (step === 1 && shrinkFrom && o) {
					const from = shrinkFrom
					shrinkFrom = null
					const connectors = state().contract.get("connectors") ?? []
					// Only a connector still where it was when the board shrank: one placed since (a link's plug added on the
					// smaller board) or already moved onto the new edge (the contract packs connectors left past an edge's
					// end) is on the new outline already. Scaling those again crowded the scripted rover + climate's main
					// into its corners (JL1 right@14 → 10, JT1 top@39 → 28; its smallest board grew 43×28 → 49×38, 16 Nov).
					const scaled = connectors.map((c) => {
						if (!from.connectors.some((k) => k.ref === c.ref && k.edge === c.edge && k.offsetMm === c.offsetMm)) return c
						const [a, b] = c.edge === "left" || c.edge === "right" ? [from.heightMm, o.heightMm] : [from.widthMm, o.widthMm]
						return { ...c, offsetMm: Math.round(((c.offsetMm * b) / a) * 2) / 2 }
					})
					if (JSON.stringify(scaled) !== JSON.stringify(connectors)) return propose("connectors", scaled, `the connectors keep their place along the edges of the ${o.widthMm}×${o.heightMm} mm board`)
				}
				const target = step === 0 && ((kinds.has("space-slack") && o && !sizeReasonHolds(state().contract.snapshot(), o.sizeReason)) || (kinds.has("space-room") && o)) ? compactOutline(state().contract.snapshot()) : null
				if (target && o && ((o.widthMm * o.heightMm) / (target.widthMm * target.heightMm) - 1 > SLACK_LIMIT || kinds.has("space-room"))) {
					// The outline the connectors were placed on: a second shrink before they moved (43×28, then 44×28 on the
					// rover) keeps the first, or they scale from the wrong size (JT1 at top@43 of a 44 mm edge, 14 Nov 2026).
					shrinkFrom ??= { widthMm: o.widthMm, heightMm: o.heightMm, connectors: structuredClone(state().contract.get("connectors") ?? []) }
					const { sizeReason: _limit, ...rest } = o
					return propose("outline", { ...rest, widthMm: target.widthMm, heightMm: target.heightMm }, `compact by default: the parts place on ${target.widthMm}×${target.heightMm} mm, and nothing asks for more${o.sizeReason ? ` (the brief's size is a limit the board now fits within)` : ""}`)
				}
				return say("violations handled")
			}
			if (instruction.startsWith("Change request from the engineer:") && state().contract.get("armTargets")) {
				// An arm's reach (runner/request-map.ts, the one mapper the "what if" preview uses too).
				const change = armTargetsFromRequest(instruction.split("\n")[1] ?? "", state().contract.get("armTargets")!)
				if (change) return step === 0 ? propose("armTargets", change.value, change.reason) : say("arm targets updated")
			}
			if (instruction.startsWith("Change request from the engineer:")) {
				// A saved pins.h (runner/file-sync.ts): "edited pins.h: I2C_SDA GPIO8 → GPIO4; …".
				const moves = [...instruction.matchAll(/(\w+) GPIO(\d+) → GPIO(\d+)/g)]
				const current = state().contract.get("pins")
				if (moves.length > 0 && current) {
					if (step > 0) return say("pins updated")
					const value = current.map((p) => {
						const m = moves.find((x) => x[1] === p.signal)
						return m ? { ...p, gpio: Number(m[3]) } : p
					})
					return propose("pins", value, `engineer edited pins.h: ${moves.map((m) => m[0]).join("; ")}`)
				}
				// A saved board.kicad_pcb: "edited board.kicad_pcb: outline 50×30 → 45×30 mm; J1 left@15 → left@12 mm".
				const resized = /outline [\d.]+×[\d.]+ → ([\d.]+)×([\d.]+) mm/.exec(instruction)
				const shifts = [...instruction.matchAll(/(\w+) (left|right|top|bottom)@[\d.]+ → (left|right|top|bottom)@([\d.]+) mm/g)]
				// The board page's moves (dashboard/board-move.ts) name connectors the same way: "J1 left@15 → left@10 mm".
				if ((instruction.includes("edited board.kicad_pcb:") || instruction.includes("placed on the board page")) && (resized || shifts.length > 0)) {
					const outlineNow = state().contract.get("outline")
					const connectorsNow = state().contract.get("connectors") ?? []
					if (resized && outlineNow && (outlineNow.widthMm !== Number(resized[1]) || outlineNow.heightMm !== Number(resized[2])))
						return propose("outline", { ...outlineNow, widthMm: Number(resized[1]), heightMm: Number(resized[2]), sizeReason: { kind: "engineer-size", detail: `the engineer drew the board ${resized[1]}×${resized[2]} mm in KiCad` } }, `engineer edited the board outline: ${resized[0]}`)
					const moved = connectorsNow.map((c) => {
						const m = shifts.find((x) => x[1] === c.ref)
						return m ? { ...c, edge: m[3] as typeof c.edge, offsetMm: Number(m[4]) } : c
					})
					if (shifts.length > 0 && JSON.stringify(moved) !== JSON.stringify(connectorsNow)) return propose("connectors", moved, `engineer moved ${shifts.map((m) => m[1]).join(", ")} on the board`)
					return say("board edits applied")
				}
				// "add a temperature/humidity sensor": a requirement line, then the sensor's I2C pins (parts adds the part).
				if (ADD_SENSOR_REQUEST.test(instruction.split("\n")[1] ?? "")) {
					const requirements = state().contract.get("requirements")
					const pins = state().contract.get("pins") ?? []
					if (step < 2 && requirements && !requirements.peripherals.includes("i2c-sensor"))
						return propose("requirements", { ...requirements, summary: `${requirements.summary} and temperature/humidity sensing`, peripherals: [...requirements.peripherals, "i2c-sensor"] }, "engineer asked for a temperature/humidity sensor")
					if (step < 2 && !pins.some((p) => p.signal === "I2C_SDA")) return propose("pins", [...pins, ...SENSOR_PINS], "the sensor's I2C bus on GPIO8/GPIO9")
					return say("sensor and pins set")
				}
				// Whether there is a case at all is the architect's (requirements.enclosure); the case's shape is the case designer's.
				const line = instruction.split("\n")[1] ?? ""
				if (ENCLOSURE_MODE_REQUEST.test(line)) {
					const requirements = state().contract.get("requirements")
					const mode = /(add|bring back|we want) (a|the) case/i.test(line) ? "case" : enclosureFromText(line)
					if (step > 0 || !requirements || !mode || requirements.enclosure === mode) return say("housing set")
					return propose("requirements", { ...requirements, enclosure: mode }, `the engineer asked: ${line}`)
				}
				// The case designer's request; a board it needs comes back as its proposal.
				if (CASE_REQUEST.test(line)) return say("left to the case")
				const width = /(\d+(?:\.\d+)?)\s*mm wide/.exec(instruction)?.[1]
				const outline = state().contract.get("outline")
				if (step > 0 || !width || !outline) return say(width ? "outline updated" : "no outline change")
				return propose("outline", { ...outline, widthMm: Number(width), sizeReason: { kind: "engineer-size", detail: `the engineer asked for ${width} mm wide` } }, `engineer asked for ${width} mm wide`)
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				const why = /change "rails"/.test(instruction) ? "a measurement beats the estimate" : /change "outline"/.test(instruction) ? "the board takes the size the case needs; the board build shows whether the parts still fit" : "GPIO10 is free"
				return step === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: why })] : say("decided")
			}
			// The board didn't route at this size: the same answer as a failed DRC, 2 mm wider with the build as the reason.
			const routingFail = instruction.startsWith("Build failed: the board build failed at revision") && ROUTING_FAILURE.test(instruction)
			const grown = state().contract.get("outline")
			if (routingFail && grown) {
				if (stepsTaken(items) > 0) return say("board widened")
				if (drcGrows >= 5) return say("can't route it")
				drcGrows++
				const rev = /at revision (\d+)/.exec(instruction)?.[1]
				return propose("outline", { ...grown, widthMm: grown.widthMm + 2, sizeReason: { kind: "routing", detail: `the ${grown.widthMm}×${grown.heightMm} mm board (rev ${rev}) didn't route: tscircuit left pins without a trace` } }, `2 mm wider so the router has room: the rev ${rev} board didn't route`)
			}
			if (instruction.startsWith("Brief")) {
				// A carrier brief: the scripted HAT, every value read from the brief (and kept for the parts agent).
				const hb = hatFromBrief(instruction)
				if (hb) {
					hat = hatDesign(hb)
					const f = ARCHITECT_FIELDS[step]
					return f ? propose(f, hat[f], `initial ${f} from the carrier brief`) : say("contract drafted")
				}
				// A robot arm's brief: its targets (armTargets) after the board's fields, never a rover's motion.
				const armTargets = armTargetsFromBrief(instruction)
				const fields: FieldName[] = armTargets ? [...ARCHITECT_FIELDS, "armTargets"] : /\brover\b/i.test(instruction) || EUROBOT.test(instruction) ? [...ARCHITECT_FIELDS, "motion"] : CNC_BRIEF.test(instruction) ? [...ARCHITECT_FIELDS, "cncTargets"]: [...ARCHITECT_FIELDS]
				const field = fields[step] as (typeof ARCHITECT_FIELDS)[number] | "motion" | "armTargets" | "cncTargets" | undefined
				// Tournament variants may cap the width: "Board must be at most <N> mm wide".
				const maxWidth = Number(/Board must be at most (\d+(?:\.\d+)?) mm wide/i.exec(instruction)?.[1] ?? Infinity)
				const design = scriptedDesignFor(instruction)
				// The brief's own size is the engineer's: "exactly 50 × 30 mm" (or a housing, a chassis) is that very size, recorded
				// as the reason the board is that big; "about 50 × 30 mm" is a limit (requirements.size exact false), and the
				// space check then compacts the board within it.
				// Not a robot's: its brief's size is the robot's (the Eurobot base's 290 × 290 mm start square), not its board's.
				// A CNC's too: "a work area of about 300 × 200 × 50 mm" read as a 200 × 50 mm board (CNC mock 9, 26 Nov 2026).
				// The brief's own text too: when requirements are first written, neither cncTargets nor the summary is there yet
				// and mock 10 still set requirements.size to 200 × 50 mm.
				const robot = Boolean(design.motion || armTargets || isCnc() || CNC_BRIEF.test(instruction))
				const stated = robot ? null : /(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*mm/.exec(instruction)
				const line = stated ? (instruction.split("\n").find((l) => l.includes(stated[0])) ?? "") : ""
				const exact = /\bexact(ly)?\b|\bmust be\b|\bfixed\b|\bchassis\b|\b(existing|our own) (housing|enclosure|case)\b|\btakes a\b/i.test(line)
				const size = stated ? { widthMm: Number(stated[1]), heightMm: Number(stated[2]), exact } : undefined
				const { sizeReason: _reason, ...plain } = design.outline
				const sized = stated ? { widthMm: size!.widthMm, heightMm: size!.heightMm, sizeReason: { kind: "engineer-size" as const, detail: `the brief asks for ${exact ? "exactly" : "about"} ${stated[1]} × ${stated[2]} mm` } } : {}
				// A robot's chassis is its body (the agents' rule: no case unless the brief asks for one); its brief's "case" words
				// are about other things (the Eurobot base's battery "in a solid case", Eurobot General Rules 1.2 F.4.b).
				const housing = robot ? null : enclosureFromText(instruction)
				const { size: _s, ...req } = design.requirements as typeof design.requirements & { size?: unknown }
				const requirements = { ...req, ...(size ? { size } : {}), ...(housing ? { enclosure: housing } : {}) }
				const value = field === "outline" ? { ...plain, ...sized, widthMm: Math.min(stated ? size!.widthMm : design.outline.widthMm, maxWidth) } : field === "requirements" ? requirements : field === "motion" ? motionFromBrief(instruction) : field === "armTargets" ? armTargets : field === "cncTargets" ? CNC_TARGETS : field ? design[field] : undefined
				return field ? propose(field, value, `initial ${field} from the brief`) : say("contract drafted")
			}
			return say("noted")
		},
		"mock-parts": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			if (instruction.startsWith("Build failed:")) return say("noted")
			if (instruction.startsWith("Consistency violations for you")) {
				const parts = state().contract.get("parts") ?? []
				const linkRef = /needs its connector: a part (\w+), role connector/.exec(instruction)?.[1]
				if (stepsTaken(items) === 0 && linkRef && !parts.some((p) => p.ref === linkRef))
					return propose("parts", [...parts, { ref: linkRef, role: "connector", ...LINK_CONNECTOR }], `${linkRef}: the link's JST SH 4-pin connector (catalog)`)
				// The power tree's parts, as rail-battery-source names them: (role R, catalog M, refs A, B), each from the catalog.
				if (stepsTaken(items) === 0 && violationKinds(instruction).has("rail-battery-source")) {
					const cat = loadCatalog(process.cwd()) as unknown as (Part & { lcsc: string | null })[]
					const add: Part[] = []
					for (const m of instruction.matchAll(/\(role ([\w-]+), catalog ([^,]+), refs ([A-Z]+\d+(?:, [A-Z]+\d+)*)\)/g)) {
						const entry = cat.find((c) => c.role === m[1] && c.mpn === m[2].trim())
						if (entry) for (const ref of m[3].split(", ")) if (!parts.some((p) => p.ref === ref)) add.push({ ...entry, ref } as Part)
					}
					if (add.length) return propose("parts", [...parts, ...add], `${add.map((p) => p.ref).join(", ")}: the robot's power tree (the cell and VBUS into the 3V3 rail), as the check names them (catalog)`)
				}
				// A CAN link's transceiver (one per board, whatever its links: a middle board's two bus segments share it).
				if (stepsTaken(items) === 0 && /needs its transceiver: a part role can-transceiver/.test(instruction) && !parts.some((p) => p.role === "can-transceiver")) {
					const taken = new Set(parts.map((p) => p.ref))
					const ref = ["U9", "U10", "U11", "U12"].find((r) => !taken.has(r))!
					return propose("parts", [...parts, { ref, role: "can-transceiver", ...CAN_TRANSCEIVER }], `${ref}: the CAN link's ${CAN_TRANSCEIVER.mpn} transceiver (catalog)`)
				}
				// An arm whose parts lack its servo rails' chips or the brick's jack (the arm arrived after the parts list): the
				// same list written again, and the contract tools add them in code (power-auto.ts armOutputs).
				if (stepsTaken(items) === 0 && state().contract.get("arm") && /^- arm-supply: .*(servo rails need|no input jack)/m.test(instruction))
					return propose("parts", parts, "the arm's servo plugs, rails and the brick's jack, which the contract tools add for the arm in the contract now")
				if (stepsTaken(items) === 0 && violationKinds(instruction).has("model-sensor-missing") && !parts.some((p) => p.role === "microphone"))
					return propose("parts", [...parts, MIC_PART], "the model listens: the ICS-43434 I2S microphone (catalog)")
				// A 1-cell charger on a multi-cell pack (charger-pack): the pack charges off the board on a balance charger, so the
				// charger, its LED and the two resistors only they use (the charge LED's and PROG's) go; without the charger the
				// LDO takes its input from USB (VBUS), not the pack.
				if (stepsTaken(items) === 0 && violationKinds(instruction).has("charger-pack") && parts.some((p) => p.role === "charger")) {
					const drop = new Set(parts.filter((p) => p.role === "charger" || p.role === "charge-led").map((p) => p.ref))
					// The passives the generator still claims without them (by LCSC, in job order): the rest were theirs (the
					// charge LED's and PROG resistors, the charger's bypass capacitor).
					const snap = state().contract.snapshot()
					const without = parts.filter((p) => !drop.has(p.ref))
					const claimed = new Set(supportParts({ ...snap, values: { ...snap.values, parts: without } }).map((sp) => sp.ref))
					const used = without.filter((p) => (p.role === "resistor" || p.role === "capacitor") && !claimed.has(p.ref)).map((p) => p.ref)
					const kept = without.filter((p) => !used.includes(p.ref))
					return propose("parts", kept, `the ${[...drop].join(" and ")} are for one cell, the pack is multi-cell: it charges off the board on a balance charger (${[...drop, ...used].join(", ")} dropped)`)
				}
				return say("noted")
			}
			// The beacon's parts follow its requirements: the sensor joins when they ask for one (or the engineer does).
			if (isBeacon() && (instruction.startsWith("The requirements or rails changed") || (instruction.startsWith("Change request from the engineer:") && ADD_SENSOR_REQUEST.test(instruction.split("\n")[1] ?? "")))) {
				const value = withSwaps(ADD_SENSOR_REQUEST.test(instruction.split("\n")[1] ?? "") ? [...BEACON_DESIGN.parts, ...SENSOR_PARTS] : beaconParts())
				const same = JSON.stringify(state().contract.get("parts")) === JSON.stringify(value)
				return stepsTaken(items) === 0 && !same ? propose("parts", value, value.some((p) => p.role === "sensor") ? "the SHT40 temperature/humidity sensor and its I2C pull-ups" : "parts from the catalog") : say("parts chosen")
			}
			// "placed on the board page (…): U2 (25, 27) → (30, 6) mm turned 90°; R5 (40, 20) → the layout's choice; J1
			// left@15 → left@10 mm": the parts take their spots and turns (parts[].at) or go back to the layout's choice; the
			// connectors are the architect's.
			const placed = instruction.startsWith("Change request from the engineer:") ? parseMoves(instruction.split("\n")[1] ?? "").filter((m): m is PartMove | Release => !("edge" in m)) : []
			if (placed.length > 0) {
				if (stepsTaken(items) > 0) return say("parts placed")
				const parts = state().contract.get("parts") ?? []
				const released = new Set<string>()
				for (const m of placed) {
					if (!parts.some((p) => p.ref === m.ref)) continue
					if ("release" in m) {
						pinned.delete(m.ref)
						released.add(m.ref)
					} else pinned.set(m.ref, { xMm: m.xMm, yMm: m.yMm, ...(m.rotationDeg ? { rotationDeg: m.rotationDeg } : {}) })
				}
				const value = withSwaps(parts).map((p) => {
					if (!released.has(p.ref)) return p
					const { at: _, ...rest } = p
					return rest as typeof p
				})
				return JSON.stringify(value) === JSON.stringify(parts) ? say("already there") : propose("parts", value, `engineer placed ${placed.map((m) => m.ref).join(", ")} on the board page`)
			}
			// "swap U2 SHT40-AD1B-R2 for the SHTC3-TR-2.5KS (C194656) from the catalog" (the board page's part card, a
			// stock-out suggestion): the catalog part takes the ref's place, same role only, with who asked as its reason.
			const swap = instruction.startsWith("Change request from the engineer:") ? parseSwap(instruction.split("\n")[1] ?? "") : null
			if (swap) {
				const parts = state().contract.get("parts") ?? []
				// The one request mapper (runner/request-map.ts), also what the "what if" preview shows.
				const r = partsAfterSwap(instruction.split("\n")[1] ?? "", parts, CATALOG)
				if (stepsTaken(items) > 0 || !r || "error" in r) return say(r && !("error" in r) ? "part swapped" : r && "error" in r && /already/.test(r.error) ? "already that part" : "not in the catalog")
				swapped.set(r.part.ref, r.part)
				return propose("parts", r.value, r.reason)
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				return stepsTaken(items) === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "fits the catalog" })] : say("decided")
			}
			// The logger's parts, plus the microphone while the model needs one (rev 11 of the first wake-word run dropped it).
			const base = hat ? hat.parts : isArm() ? ARM_BOARD.parts : isEurobot() ? EUROBOT_BOARD.parts : isRover4() ? ROVER4_BOARD.parts : isRover() ? ROVER_BOARD.parts : isStm32() ? STM32_LOGGER_DESIGN.parts : isCncFluidnc() ? withoutCncWiring(CNC_FLUIDNC_DESIGN.parts!) : isCnc() ? withoutCncWiring(CNC_DESIGN.parts!) : LOGGER_DESIGN.parts
			const wanted = withSwaps(state().contract.get("model")?.sensor === "microphone" ? [...base, MIC_PART] : base)
			if (stepsTaken(items) > 0) return say("parts chosen")
			// An arm's parts list grows in code past the scripted one (the servo plugs, rails and jack, the logic's power tree):
			// it is unchanged while every scripted part is still in it. A CNC's too (its power tree, its fixed wiring).
			const now = state().contract.get("parts") ?? []
			if ((isArm() || isCnc()) && wanted.every((p) => now.some((q) => q.ref === p.ref && q.mpn === p.mpn))) return say("parts unchanged")
			return JSON.stringify(now) === JSON.stringify(wanted) ? say("parts unchanged") : propose("parts", wanted, "parts from the catalog")
		},
		"mock-ml": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			const model = state().contract.get("model")
			if (instruction.startsWith("Change request from the engineer:")) {
				const request = instruction.split("\n")[1] ?? ""
				// "the wake-word data is recorded": the dataset now belongs to the sensor path the design has today.
				if (DATA_RECORDED_REQUEST.test(request) && model) {
					const data = dataOn("recorded")
					if (step > 0 || !data) return say(data ? "data recorded" : "no sensor to record")
					return propose("model", { ...model, data }, `engineer asked: ${request}`)
				}
				if (step > 0 || !WAKE_WORD_REQUEST.test(request)) return say(WAKE_WORD_REQUEST.test(request) ? "model written" : "no model change")
				return propose("model", WAKE_WORD_MODEL, `engineer asked: ${request}`)
			}
			if (instruction.startsWith("Consistency violations for you") && model && step === 0) {
				const kinds = violationKinds(instruction)
				// Each fix is the textbook one: int8 quarters float32 weights; a rate the sensor supports; a shorter window.
				if (kinds.has("model-flash") && model.quantization === "float32") return propose("model", { ...model, quantization: "int8", weightsKb: Math.ceil(model.weightsKb / 4) }, "int8 quantization: about a quarter of the float32 weights")
				if (kinds.has("model-rate")) return propose("model", { ...model, sampleRateHz: 16000 }, "16 kHz, inside the microphone's low-power range")
				if (kinds.has("model-ram")) return propose("model", { ...model, windowMs: Math.round(model.windowMs / 2), arenaKb: Math.ceil(model.arenaKb / 2) }, "half the window halves the arena")
				// The hardware moved under the training data: retraining can't happen in the run, so the honest fix is to
				// mark the data needed on the new path, which the data-collection firmware then records.
				const needed = kinds.has("model-stale") && dataOn("needed")
				if (needed) return propose("model", { ...model, data: needed }, "the sensor path changed: the data must be recorded again on the new path")
			}
			return say("model unchanged")
		},
		"mock-test": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			const test = state().contract.get("test")
			if (instruction.startsWith("Change request from the engineer:")) {
				const request = instruction.split("\n")[1] ?? ""
				if (step > 0 || !TEST_REQUEST.test(request)) return say(TEST_REQUEST.test(request) ? "test written" : "no test change")
				return propose("test", defaultTestSpec(state().contract.snapshot()), `engineer asked: ${request}`)
			}
			if (instruction.startsWith("Consistency violations for you") && test && step === 0) {
				const fixed = followDesign(test)
				if (JSON.stringify(fixed) !== JSON.stringify(test)) return propose("test", fixed, `the test follows the design: ${[...violationKinds(instruction)].join(", ")}`)
			}
			return say("test unchanged")
		},
		"mock-connectivity": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			const current = state().contract.get("connectivity")
			if (instruction.startsWith("Change request from the engineer:")) {
				const request = instruction.split("\n")[1] ?? ""
				if (step > 0 || !CONNECTIVITY_REQUEST.test(request)) return say(CONNECTIVITY_REQUEST.test(request) ? "connectivity set" : "no radio change")
				return propose("connectivity", connectivityFromRequest(request, current), `engineer asked: ${request}`)
			}
			// Wi-Fi uploads cost the battery its target: upload half as often, up to once a day.
			if (instruction.startsWith("Consistency violations for you") && step === 0 && current?.radio === "wifi" && violationKinds(instruction).has("battery-short")) {
				const next = Math.min(86400, (current.uploadPeriodS ?? 3600) * 2)
				if (next !== current.uploadPeriodS) return propose("connectivity", { ...current, uploadPeriodS: next }, `uploads every ${next / 3600} h: each one joins Wi-Fi for seconds, and the battery target can't pay for them more often`)
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				return step === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "the radio still fits" })] : say("decided")
			}
			return say("radio unchanged")
		},
		// The scripted mechanics engineer: the reference rover once motion targets exist; "N cm/mm narrower" (or wider)
		// moves the plate's width and the track together, so the wheels keep their clearance.
		"mock-mechanics": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			const current = state().contract.get("mechanics")
			if (instruction.startsWith("Change request from the engineer:")) {
				const request = instruction.split("\n")[1] ?? ""
				// The one request mapper (runner/request-map.ts), also what the "what if" preview shows.
				const change = current ? mechanicsFromRequest(request, current) : null
				if (step === 0 && change) return propose("mechanics", change.value, change.reason)
				return say(change ? "chassis updated" : "no mechanics change")
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				return step === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "the chassis still fits" })] : say("decided")
			}
			// With a bought compute board on the robot: the 2S pack, its 5 V regulator and 12 V motors, laid out by the solver.
			// Also when the reference rover was chosen before the system's body arrived.
			if (instruction.startsWith("Consistency violations for you") && step === 0 && state().contract.get("motion") && carriesCompute(state().contract.get("assembly"))) {
				// Picked once the contract holds it (a refused proposal is tried again on the next wake).
				const compute = byMpn(defaultCheckCatalog()?.mech.batteries ?? [], COMPUTE_ROVER_PACK)
				if (current && compute && current.battery.pack === compute.mpn) computePicked = true
				if (picksComputeMechanics(current, computePicked)) {
					const mech = computeRoverMechanics(state().contract.snapshot())
					if (mech) return propose("mechanics", mech, `a rover with a bought compute board: the ${mech.battery.pack} through the ${mech.regulator}, ${mech.drive.motor} motors, laid out by the chassis solver (catalog/mechanics.json)`)
				}
			}
			// A CNC: the machine meeting the brief's targets, from the catalog (docs/cnc.md; hand-written: gap 2).
			if (instruction.startsWith("Consistency violations for you") && step === 0 && state().contract.get("cncTargets") && !state().contract.get("cnc"))
				return propose("cnc", isCncFluidnc() ? { ...CNC_MACHINE, firmware: "fluidnc" } : CNC_MACHINE, "the desktop CNC: 17HS15-1504S1 steppers on T8 screws (each its travel plus 40 mm) and MGN12H rails, Y a gantry on two motors, the GS-775MR spindle on the 24 V brick (catalog/mechanics.json)")
			// A robot arm: the brief's servos on the scripted links once the targets exist, then the servo each arm-torque
			// violation names, a brick as big as arm-supply asks, and ballast while it tips.
			const arm = state().contract.get("arm")
			if (instruction.startsWith("Consistency violations for you") && step === 0 && !arm && state().contract.get("armTargets"))
				return propose("arm", ARM_SPEC, "the brief's servos (MG996R at the base, shoulder and elbow; SG90 at the wrist and gripper) on 120 + 110 + 20 + 30 mm links (280 mm from the shoulder axis to the grip point), PCA9685 channels 0-5, a 6 V rail and the brief's 20 V 120 W brick (Mean Well GST120A20); the base plate 200 × 160 mm with 300 g of ballast (catalog/mechanics.json servos)")
			if (instruction.startsWith("Consistency violations for you") && step === 0 && arm) {
				const fixes = armServoFixes(instruction)
				const brick = /^- arm-supply: the [\d.]+ V brick is rated [\d.]+ A .*: ([\d.]+) A$/m.exec(instruction)
				const tips = /^- arm-tipping: /m.test(instruction)
				// The links follow the targets' reach (a reach change request): longer links, then the torque check picks servos.
				const targets = state().contract.get("armTargets")
				const relinked = targets ? armLinksForReach(arm, targets.reachMm) : null
				const base = relinked ?? arm
				const next: ArmSpec = {
					...base,
					joints: base.joints.map((j) => ({ ...j, servo: fixes.find((f) => f.joint === j.name)?.servo ?? j.servo })),
					input: brick ? { ...arm.input, amps: Math.ceil(Number(brick[1]) * 10) / 10 } : arm.input,
					base: tips ? { ...arm.base, ballastG: arm.base.ballastG + 200 } : arm.base,
				}
				const why = [...(relinked ? [`the links ${relinked.joints.filter((j) => j.name !== "base-yaw").map((j) => j.linkMm).join(" + ")} mm reach the targets' ${targets!.reachMm} mm (arm-reach)`] : []), ...fixes.map((f) => `the ${f.joint} takes the ${f.servo}, the weakest catalog servo that carries its torque (arm-torque)`), ...(brick ? [`a ${arm.input.volts} V brick of ${next.input.amps} A, what the servos at stall need (arm-supply)`] : []), ...(tips ? ["200 g more ballast on the base (arm-tipping)"] : [])]
				if (why.length && JSON.stringify(next) !== JSON.stringify(arm)) return propose("arm", next, why.join("; "))
			}
			if (instruction.startsWith("Consistency violations for you") && step === 0 && !current && state().contract.get("motion") && isEurobot())
				return propose("mechanics", EUROBOT_BOARD.mechanics, "the Eurobot base: the reference rover's drive with the emergency stop on a 125 mm deck beside the board (a 7 mm collar keeps its head within 25 mm of the robot) and the pull-cord start (catalog/mechanics.json safety, Eurobot General Rules 1.2 F.4.c, F.6)")
			// A four-wheel brief: the skid-steer rover on encoder gearmotors (its turn closes on their counts).
			if (instruction.startsWith("Consistency violations for you") && step === 0 && !current && state().contract.get("motion")?.drive === "skid4")
				return propose("mechanics", ROVER4_MECHANICS, "the four-wheel skid-steer rover: Pololu 100:1 micro gearmotors with 12 CPR encoders on 80 mm wheels, no caster, wheelbase 0.71× the track; the turn in place ends on the front wheels' counts (catalog/mechanics.json)")
			if (instruction.startsWith("Consistency violations for you") && step === 0 && !current && state().contract.get("motion"))
				return propose("mechanics", ROVER_MECHANICS, "the reference rover: Pololu 100:1 micro gearmotors on 60 mm wheels, a 25 mm swivel caster, the 2000 mAh cell, the VL53L0X breakout at the front (catalog/mechanics.json)")
			// Woken by a chassis finding with its own layout in the contract: lay the same parts out again for the contract
			// as it is now (laidOut: the solver, with the system's board positions), as a real engineer calls layout_chassis.
			// Rover + climate (20 Nov 2026): the system moved both boards behind the axle after the layout, the caster's load
			// went to the climb limit, and the mock said "mechanics unchanged" every wake. Only a layout that changes goes in.
			if (instruction.startsWith("Consistency violations for you") && step === 0 && current && /\bmech-(fit|tipping|climb|stopping|torque|speed)\b/.test(instruction)) {
				const cat = defaultCheckCatalog()
				const r = cat ? laidOut(state().contract.snapshot(), current, cat) : null
				if (r?.note && JSON.stringify(r.mechanics) !== JSON.stringify(current)) return propose("mechanics", r.mechanics, `laid out again for the contract as it is now: ${r.note}`)
			}
			return say("mechanics unchanged")
		},
		"mock-enclosure": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			const s = state().contract.snapshot()
			const current = s.values.case
			if (instruction.startsWith("Change request from the engineer:")) {
				const request = instruction.split("\n")[1] ?? ""
				if (!CASE_REQUEST.test(request) || !s.values.outline) return say("no case change")
				// Whether there is a case at all is the architect's; with none of ours, there is no case to change.
				if (ENCLOSURE_MODE_REQUEST.test(request) || (s.values.requirements?.enclosure ?? "case") !== "case") return say("no case of ours")
				const last = text(items.findLast((i) => i instanceof FunctionCallOutputItem))
				if (last.startsWith("rejected")) return say("board kept as is")
				if (step === 0) {
					const value = caseFromRequest(request, s)
					if (JSON.stringify(value) !== JSON.stringify(caseOf(s)) || !current) return propose("case", value, `engineer asked: ${request}`)
				}
				// The outer size follows the board: the board the case needs, asked of the architect (and the engineer).
				const outer = requestedCaseWidth(request)
				const board = outer === null ? null : boardWidthFor(outer, s)
				if (step < 2 && board !== null && board !== s.values.outline.widthMm) return propose("outline", { ...s.values.outline, widthMm: board, sizeReason: { kind: "engineer-size", detail: `the engineer asked for a ${outer} mm wide case` } }, `a ${outer} mm wide case holds a ${board} mm board (2 mm clearance and ${caseOf(s).wallMm} mm walls each side, and the antenna's reach)`)
				return say("case updated")
			}
			if (instruction.startsWith("Consistency violations for you") && current && step === 0) {
				const fixed = caseFollows(s)
				if (JSON.stringify(fixed) !== JSON.stringify(current)) return propose("case", fixed, `the case follows the board: ${[...violationKinds(instruction)].join(", ")}`)
				return say("no case fix")
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				return step === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "the case still fits" })] : say("decided")
			}
			return say("case unchanged")
		},
		// Passes with one minor finding, so mock runs settle and still show a verdict.
		"mock-reviewer": (items) =>
			stepsTaken(items) === 0
				? [
						toolCall("submit_review", {
							verdict: "pass",
							findings: [
								{
									severity: "minor",
									fields: ["rails", "parts"],
									issue: "The battery budget assumes one phone connection a day; the brief does not say how often the history is read.",
									suggestion: "State the expected phone use in the brief, so the battery-life target is checked against it.",
								},
							],
						}),
					]
				: say("review submitted"),
		"mock-firmware": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			if (instruction.startsWith("Change request from the engineer:")) {
				// The request is the line after the prefix. "blink faster when tilted": a 250 ms blink past 20°, slow enough
				// that the bench can still time it from 50 ms telemetry samples (bench/blink.ts).
				const request = instruction.split("\n")[1] ?? ""
				if (stepsTaken(items) > 0 || !/blink/i.test(request)) return say(/blink/i.test(request) ? "behavior updated" : "no behavior change")
				const current = state().contract.get("behavior") ?? DEFAULT_BEHAVIOR
				const value = /tilt/i.test(request) ? { ...current, tiltBlinkMs: 250, tiltDeg: 20 } : { ...current, blinkMs: Math.max(100, Math.round(current.blinkMs / 2)) }
				return propose("behavior", value, `engineer asked: ${request}`)
			}
			if (stepsTaken(items) > 0) return say("requested")
			const pins = state().contract.get("pins") ?? []
			if (pins.some((p) => p.signal === "STATUS_LED")) return say("pins are sufficient")
			// A board with no MCU (a HAT that only carries power) runs no firmware of its own.
			if (hat && !(state().contract.get("parts") ?? []).some((p) => p.role === "mcu")) return say("no MCU, no pins")
			// On the ESP32-C3 the LED keeps GPIO10, as it always had, while it is free; otherwise (another chip, or GPIO10
			// taken: the Eurobot base's START, 16 Nov) the profile's solver picks a free pin.
			const chip = mcuProfileOf(state().contract.get("parts"))
			if (!chip || (chip.id === LEGACY_MCU_ID && !pins.some((p) => p.gpio === STATUS_LED.gpio))) return propose("pins", [...pins, STATUS_LED], "firmware drives a status LED")
			// Not the native USB's pins (the Eurobot base, 16 Nov: its LED went to GPIO18, which unwired the USB-C's D-).
			const r = solvePins(chip, [{ signal: "STATUS_LED", kind: "gpio" }], [...pins.map((p) => p.gpio), ...nativeUsbIndexes(state().contract.snapshot())])
			return r.ok ? propose("pins", [...pins, { ...STATUS_LED, gpio: r.pins[0].index }], `firmware drives a status LED (${r.pins[0].pin}, a free pin on the ${chip.mpn})`) : say(r.reason)
		},
	}
}
