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
				const width = /(\d+(?:\.\d+)?)\s*mm wide/.exec(instruction)?.[1]
				const outline = state().contract.get("outline")
				if (step > 0 || !width || !outline) return say(width ? "outline updated" : "no field I own covers that request")
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
				const value = field === "outline" ? { ...LOGGER_DESIGN.outline, widthMm: Math.min(LOGGER_DESIGN.outline.widthMm, maxWidth) } : LOGGER_DESIGN[field]
				return field ? propose(field, value, `initial ${field} from the brief`) : say("contract drafted")
			}
			return say("noted")
		},
		"mock-parts": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			if (instruction.startsWith("Build failed:")) return say("noted")
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
				if (stepsTaken(items) > 0 || !/blink/i.test(request)) return say(/blink/i.test(request) ? "behavior updated" : "not a firmware behavior change")
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
