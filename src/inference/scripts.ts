import { FunctionCallOutputItem, ModelMessageItem, UserMessageItem, type ContextItem } from "@mozaik-ai/core"
import type { ContractValues, FieldName } from "../contract/types.ts"
import { state } from "../runtime.ts"
import { toolCall, type Script } from "./scripted-runner.ts"

// The logger design the mock agents produce: ESP32-C3, SHT40 over I2C, USB-C power, LDO, LED.
export const LOGGER_DESIGN: Omit<ContractValues, "parts"> & { parts: ContractValues["parts"] } = {
	requirements: { summary: "BLE temperature and humidity logger", peripherals: ["i2c-sensor", "usb-c", "status-led"], batteryLifeDays: 180 },
	outline: { widthMm: 50, heightMm: 30, thicknessMm: 1.6 },
	connectors: [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 15, widthMm: 9, heightMm: 3.5 }],
	rails: [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 120 }],
	pins: [
		{ signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 9, partRef: "U2", partPin: "SCL" },
	],
	parts: [
		{ ref: "U1", role: "mcu", mpn: "ESP32-C3-MINI-1", lcsc: "C2838502", footprint: "qfn32", pins: ["GPIO0", "GPIO1", "GPIO2", "GPIO3", "GPIO4", "GPIO5", "GPIO6", "GPIO7", "GPIO8", "GPIO9", "GPIO10", "3V3", "GND"] },
		{ ref: "U2", role: "sensor", mpn: "SHT40-AD1B-R2", lcsc: "C2909890", footprint: "dfn4", pins: ["SDA", "SCL", "VDD", "VSS"] },
		{ ref: "U3", role: "ldo", mpn: "AP2112K-3.3TRG1", lcsc: "C51118", footprint: "sot23_5", pins: ["VIN", "GND", "EN", "NC", "VOUT"] },
		{ ref: "J1", role: "usb-c", mpn: "TYPE-C-31-M-12", lcsc: "C165948", footprint: "usbcmidmount", pins: [] },
		{ ref: "D1", role: "led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: ["A", "K"] },
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

const ARCHITECT_FIELDS: FieldName[] = ["requirements", "outline", "connectors", "rails", "pins"]

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
				return step === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "GPIO10 is free" })] : say("decided")
			}
			if (instruction.startsWith("Brief")) {
				const field = ARCHITECT_FIELDS[step]
				return field ? propose(field, LOGGER_DESIGN[field], `initial ${field} from the brief`) : say("contract drafted")
			}
			return say("noted")
		},
		"mock-parts": (items) => (stepsTaken(items) === 0 ? propose("parts", LOGGER_DESIGN.parts, "parts from the catalog") : say("parts chosen")),
		"mock-firmware": (items) => {
			if (stepsTaken(items) > 0) return say("requested")
			const pins = state().contract.get("pins") ?? []
			return pins.some((p) => p.signal === "STATUS_LED") ? say("pins are sufficient") : propose("pins", [...pins, STATUS_LED], "firmware drives a status LED")
		},
	}
}
