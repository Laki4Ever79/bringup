import type { Agent, Tool } from "@mozaik-ai/core"
import { isEvent } from "../events.ts"
import { ownerReviewsChanges, when } from "../change-control.ts"
import { state } from "../runtime.ts"
import { searchParts } from "../tools/parts-search.ts"
import { createRoleAgent, requestTurn, startTurn } from "./common.ts"

const CONTRACT_SHAPES = `Contract field shapes (units: mm, V, mA):
- requirements: {summary: string, peripherals: string[], batteryLifeDays: number|null}
- outline: {widthMm, heightMm, thicknessMm}
- connectors: [{ref, kind: "usb-c"|"header"|"button", edge: "left"|"right"|"top"|"bottom", offsetMm (centre along the edge, from bottom or left), widthMm, heightMm}]
- rails: [{name, voltageV, regulatorMaxMa, loadMa}]
- parts: [{ref, role, mpn, lcsc, footprint, pins: string[]}]
- pins: [{signal (UPPER_SNAKE), gpio: number, partRef, partPin}]
Reference designators: U1 = MCU (ESP32-C3-MINI-1, pins GPIO0..GPIO10), U2 = sensor, U3 = LDO, J1 = USB-C, D1 = LED.
Always call read_contract first and pass each field's current version as baseVersion.`

export function createArchitectAgent(opts: { mock: boolean }): Agent {
	const agent = createRoleAgent({
		role: "architect",
		mock: opts.mock,
		instruction: `You are the system architect of a small hardware product. From the brief you write the requirements, outline, connectors, rails and pins of the design contract, one propose_contract_change call per field. Only use MCU pins GPIO0..GPIO10 and parts that exist in the catalog. You own those fields: when another discipline asks to change one, decide with decide_change, approving it if it fits the design.\n${CONTRACT_SHAPES}`,
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "message.sent" as never) && state().getParticipant(event.producerId)?.getManifest().name === "engineer"),
				processor: { apply: ({ event, participant }) => startTurn(participant as Agent, `Brief from the engineer:\n${(event.payload as { message: string }).message}`) },
			},
			ownerReviewsChanges("architect"),
			{
				specification: when(({ event }) => isEvent(event, "consistency.checked") && event.payload.violations.some((v) => v.affects.includes("architect"))),
				processor: {
					apply: ({ event, participant }) => {
						if (!isEvent(event, "consistency.checked")) return
						const mine = event.payload.violations.filter((v) => v.affects.includes("architect"))
						requestTurn(participant as Agent, `violations@${event.payload.revision}`, `Consistency violations for you at revision ${event.payload.revision}:\n${mine.map((v) => `- ${v.kind}: ${v.message}`).join("\n")}\nFix them by changing the fields you own.`)
					},
				},
			},
		],
	})
	return agent
}

function searchPartsTool(): Tool {
	return {
		type: "function",
		name: "search_parts",
		description: "List vetted catalog parts for a role (mcu, sensor, ldo, usb-c, led, resistor, capacitor) with live JLCPCB stock and price.",
		parameters: { type: "object", properties: { role: { type: "string" } }, required: ["role"] },
		strict: false,
		invoke: async ({ role }: { role: string }) => searchParts(role),
	}
}

export function createPartsAgent(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "parts",
		mock: opts.mock,
		instruction: `You select the parts for a hardware design. Use search_parts for every role the requirements and rails need, prefer in-stock parts, and write the complete parts list with one propose_contract_change. Keep the reference designators below.\n${CONTRACT_SHAPES}`,
		tools: [searchPartsTool()],
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "contract.changed") && (event.payload.field === "requirements" || event.payload.field === "rails")),
				processor: {
					apply: ({ participant }) => {
						const c = state().contract
						requestTurn(participant as Agent, `parts@${c.version("requirements")}.${c.version("rails")}`, "The requirements or rails changed. Choose the parts.")
					},
				},
			},
		],
	})
}

// The firmware discipline's reasoning side: it checks that the pin map gives firmware what the
// requirements need and asks the architect (through change control) for anything missing.
export function createFirmwareReviewer(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "firmware",
		name: "firmware-reviewer",
		mock: opts.mock,
		instruction: `You are the firmware engineer. Check that the pins in the contract cover every peripheral in the requirements (I2C bus, status LED, buttons). If a signal is missing, propose the complete new pins list with propose_contract_change; the architect must approve it. If the firmware build failed, read the error and propose the pin change that fixes it. Change nothing if the pins are sufficient.\n${CONTRACT_SHAPES}`,
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "contract.changed") && event.payload.field === "pins"),
				processor: { apply: ({ participant }) => requestTurn(participant as Agent, `pins@${state().contract.version("pins")}`, "The pin map changed. Review it against the requirements.") },
			},
			{
				specification: when(({ event }) => isEvent(event, "consistency.checked") && event.payload.violations.some((v) => v.affects.includes("firmware"))),
				processor: {
					apply: ({ event, participant }) => {
						if (!isEvent(event, "consistency.checked")) return
						const mine = event.payload.violations.filter((v) => v.affects.includes("firmware"))
						requestTurn(participant as Agent, `fw-violations@${event.payload.revision}`, `Firmware violations at revision ${event.payload.revision}:\n${mine.map((v) => `- ${v.kind}: ${v.message}`).join("\n")}`)
					},
				},
			},
		],
	})
}
