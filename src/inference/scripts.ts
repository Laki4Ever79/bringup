import { FunctionCallOutputItem, ModelMessageItem, UserMessageItem, type ContextItem } from "@mozaik-ai/core"
import type { ContractValues, FieldName } from "../contract/types.ts"
import { state } from "../runtime.ts"
import { toolCall, type Script } from "./scripted-runner.ts"
import { DEFAULT_BEHAVIOR } from "../codegen/firmware.ts"

// The logger design the mock agents produce: ESP32-C3, SHT40 over I2C, USB-C power, LDO, LED.
export const LOGGER_DESIGN: Omit<ContractValues, "parts" | "behavior"> & { parts: ContractValues["parts"] } = {
	// ESP32-C3 deep sleep about 10 µA; every 5 min it wakes for a 30 ms reading and a 300 ms BLE advertising burst at
	// about 25 mA. Average: 25 mA × 330 ms / 300 s + 10 µA = 37.5 µA, before the LDO's own quiescent current.
	requirements: {
		summary: "BLE temperature and humidity logger",
		peripherals: ["i2c-sensor", "usb-c", "status-led"],
		batteryLifeDays: 180,
		dutyCycle: { activeMs: 330, periodS: 300, sleepUa: 10 },
	},
	outline: { widthMm: 50, heightMm: 30, thicknessMm: 1.6 },
	connectors: [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 15, widthMm: 9, heightMm: 3.5 }],
	rails: [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 120, averageMa: 0.0375 }],
	pins: [
		{ signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 9, partRef: "U2", partPin: "SCL" },
	],
	parts: [
		{ ref: "U1", role: "mcu", mpn: "ESP32-C3-MINI-1", lcsc: "C2838502", footprint: "esp32_c3_mini_1", pins: ["GPIO0", "GPIO1", "GPIO2", "GPIO3", "GPIO4", "GPIO5", "GPIO6", "GPIO7", "GPIO8", "GPIO9", "GPIO10", "GPIO18", "GPIO19", "EN", "3V3", "GND"] },
		{ ref: "U2", role: "sensor", mpn: "SHT40-AD1B-R2", lcsc: "C2909890", footprint: "dfn4", pins: ["SDA", "SCL", "VDD", "VSS"] },
		{ ref: "U3", role: "ldo", mpn: "AP2112K-3.3TRG1", lcsc: "C51118", footprint: "sot23_5", pins: ["VIN", "GND", "EN", "NC", "VOUT"] },
		{ ref: "U4", role: "charger", mpn: "TP4054-42-SOT25R", lcsc: "C32574", footprint: "sot23_5", pins: ["CHRG", "GND", "BAT", "VCC", "PROG"] },
		{ ref: "J1", role: "usb-c", mpn: "TYPE-C-31-M-12", lcsc: "C165948", footprint: "usbcmidmount", pins: ["VBUS", "GND", "CC1", "CC2", "DP", "DN"] },
		{ ref: "J2", role: "battery", mpn: "S2B-PH-K-S(LF)(SN)", lcsc: "C173752", footprint: "jst2_ph", pins: ["VBAT", "GND"] },
		{ ref: "D1", role: "led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: ["A", "K"] },
		{ ref: "D2", role: "charge-led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: ["A", "K"] },
		// Support passives. Codegen claims them by LCSC number in job order: LED (R1), charge LED (R7), CC1, CC2, PROG,
		// I2C pull-ups, bypass caps.
		{ ref: "R1", role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R2", role: "resistor", mpn: "0402WGF5101TCE", lcsc: "C25905", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R3", role: "resistor", mpn: "0402WGF5101TCE", lcsc: "C25905", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R4", role: "resistor", mpn: "0402WGF4701TCE", lcsc: "C25900", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R5", role: "resistor", mpn: "0402WGF1002TCE", lcsc: "C25744", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R6", role: "resistor", mpn: "0402WGF1002TCE", lcsc: "C25744", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R7", role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "C1", role: "capacitor", mpn: "CL05A105KA5NQNC", lcsc: "C52923", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "C2", role: "capacitor", mpn: "CL05A105KA5NQNC", lcsc: "C52923", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "C3", role: "capacitor", mpn: "CL10A106KP8NNNC", lcsc: "C19702", footprint: "0603", pins: ["pin1", "pin2"] },
	],
}

// The second scripted design, for briefs/beacon.md: the logger's board without the sensor (and its I2C pull-ups), plus
// a button on the top edge that wakes it. ESP32-C3 deep sleep about 10 µA; every 60 s it wakes for a 300 ms BLE
// advertising burst (plus the 30 ms wake) at about 25 mA: 25 mA × 330 ms / 60 s + 10 µA = 147.5 µA. With the
// AP2112K's 55 µA, a 500 mAh cell lasts about 103 days, past the brief's 3 months.
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

// "add a temperature/humidity sensor": the logger's SHT40 with its two I2C pull-ups, on the logger's I2C pins.
export const ADD_SENSOR_REQUEST = /add .*(temp|humid|sensor)/i
const SENSOR_PARTS = LOGGER_DESIGN.parts.filter((p) => ["U2", "R5", "R6"].includes(p.ref))
const SENSOR_PINS = LOGGER_DESIGN.pins.filter((p) => p.partRef === "U2")

// Which scripted design a brief gets: the beacon for a brief that says so, the logger for anything else.
export const scriptedDesignFor = (brief: string) => (/\bbeacon\b/i.test(brief) ? BEACON_DESIGN : LOGGER_DESIGN)

// The beacon's parts for its current requirements: with a sensor once the requirements ask for one.
function beaconParts(): ContractValues["parts"] {
	const sensing = state().contract.get("requirements")?.peripherals.includes("i2c-sensor")
	return sensing ? [...BEACON_DESIGN.parts, ...SENSOR_PARTS] : BEACON_DESIGN.parts
}
const isBeacon = () => (state().contract.get("requirements")?.peripherals ?? []).includes("button")

const STATUS_LED = { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }

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

const ARCHITECT_FIELDS = ["requirements", "outline", "connectors", "rails", "pins"] as const satisfies FieldName[]

// Deterministic stand-ins for each role's model, so a full run needs no API key.
export function mockScripts(): Record<string, Script> {
	return {
		"mock-architect": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
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
				if (instruction.includes("edited board.kicad_pcb:") && (resized || shifts.length > 0)) {
					const outlineNow = state().contract.get("outline")
					const connectorsNow = state().contract.get("connectors") ?? []
					if (resized && outlineNow && (outlineNow.widthMm !== Number(resized[1]) || outlineNow.heightMm !== Number(resized[2])))
						return propose("outline", { ...outlineNow, widthMm: Number(resized[1]), heightMm: Number(resized[2]) }, `engineer edited the board outline: ${resized[0]}`)
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
				const width = /(\d+(?:\.\d+)?)\s*mm wide/.exec(instruction)?.[1]
				const outline = state().contract.get("outline")
				if (step > 0 || !width || !outline) return say(width ? "outline updated" : "no outline change")
				return propose("outline", { ...outline, widthMm: Number(width) }, `engineer asked for ${width} mm wide`)
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				const why = /change "rails"/.test(instruction) ? "a measurement beats the estimate" : "GPIO10 is free"
				return step === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: why })] : say("decided")
			}
			if (instruction.startsWith("Brief")) {
				const field = ARCHITECT_FIELDS[step]
				// Tournament variants may cap the width: "Board must be at most <N> mm wide".
				const maxWidth = Number(/Board must be at most (\d+(?:\.\d+)?) mm wide/i.exec(instruction)?.[1] ?? Infinity)
				const design = scriptedDesignFor(instruction)
				const value = field === "outline" ? { ...design.outline, widthMm: Math.min(design.outline.widthMm, maxWidth) } : design[field]
				return field ? propose(field, value, `initial ${field} from the brief`) : say("contract drafted")
			}
			return say("noted")
		},
		"mock-parts": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			if (instruction.startsWith("Build failed:")) return say("noted")
			// The beacon's parts follow its requirements: the sensor joins when they ask for one (or the engineer does).
			if (isBeacon() && (instruction.startsWith("The requirements or rails changed") || (instruction.startsWith("Change request from the engineer:") && ADD_SENSOR_REQUEST.test(instruction.split("\n")[1] ?? "")))) {
				const value = ADD_SENSOR_REQUEST.test(instruction.split("\n")[1] ?? "") ? [...BEACON_DESIGN.parts, ...SENSOR_PARTS] : beaconParts()
				const same = JSON.stringify(state().contract.get("parts")) === JSON.stringify(value)
				return stepsTaken(items) === 0 && !same ? propose("parts", value, value.some((p) => p.role === "sensor") ? "the SHT40 temperature/humidity sensor and its I2C pull-ups" : "parts from the catalog") : say("parts chosen")
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				return stepsTaken(items) === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "fits the catalog" })] : say("decided")
			}
			return stepsTaken(items) === 0 ? propose("parts", LOGGER_DESIGN.parts, "parts from the catalog") : say("parts chosen")
		},
		// Passes with one minor finding, so mock runs settle and still show a verdict. 55 µA × 24 h × 183 days ≈ 242 mAh.
		"mock-reviewer": (items) =>
			stepsTaken(items) === 0
				? [
						toolCall("submit_review", {
							verdict: "pass",
							findings: [
								{
									severity: "minor",
									fields: ["rails", "parts"],
									issue: "The AP2112K draws about 55 µA quiescent: over 6 months that alone is about 242 mAh of the 500 mAh cell.",
									suggestion: "Consider a low-Iq LDO (about 1 µA) to leave margin for the radio and the sensor.",
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
			return pins.some((p) => p.signal === "STATUS_LED") ? say("pins are sufficient") : propose("pins", [...pins, STATUS_LED], "firmware drives a status LED")
		},
	}
}
