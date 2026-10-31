import type { Agent, SituationHandler, Tool } from "@mozaik-ai/core"
import { isEvent, type ArtifactKind, type Cause, type ReviewFinding } from "../events.ts"
import { OWNERS, type AgentRole } from "../contract/types.ts"
import { ownerReviewsChanges, when } from "../change-control.ts"
import { state } from "../runtime.ts"
import { searchParts } from "../tools/parts-search.ts"
import { createRoleAgent, requestTurn, startTurn } from "./common.ts"
import { isPinAssignmentFinding } from "./grounding-check.ts"
import type { GroundingFinding } from "../contract/grounding.ts"

// Splits the grounding check's findings between the parts list (the parts agent's) and the pin assignments (the architect's).
function groundingFor(findings: GroundingFinding[], pinAssignments: boolean): GroundingFinding[] {
	const s = state().contract.snapshot()
	return findings.filter((f) => isPinAssignmentFinding(f, s) === pinAssignments)
}

export const BUILD_FAILED_PREFIX = "Build failed:"

// Wakes an agent when an artifact it can fix fails to build. The error is already cut down to the real cause
// (tools/board.ts buildErrors). Each failure (kind and revision) wakes the agent once.
function onBuildFailed(kinds: ArtifactKind[], owns: string): SituationHandler {
	return {
		specification: when(({ event }) => isEvent(event, "artifact.failed") && kinds.includes(event.payload.kind)),
		processor: {
			apply: ({ event, participant }) => {
				if (!isEvent(event, "artifact.failed")) return
				const { kind, revision, error } = event.payload
				requestTurn(
					participant as Agent,
					`build-failed@${kind}@${revision}`,
					`${BUILD_FAILED_PREFIX} the ${kind} build failed at revision ${revision}:\n${error}\n` +
						`If the failure comes from a contract field you own (${owns}), for example an unknown footprint, a missing part or a pin on a part that doesn't exist, fix it with propose_contract_change. Otherwise change nothing.`,
					{ kind: "build-failed", artifact: kind, revision, error: String(error).split("\n")[0] },
				)
			},
		},
	}
}

const listFindings = (findings: GroundingFinding[]) => findings.map((f) => `- ${f.kind} on ${f.partRef} (${f.source}): ${f.detail}`).join("\n")

// Brief review findings for the fields this role owns (a finding naming no field goes to the architect), while a
// fix round is left. Each review wakes an owner once.
function reviewFindingsFor(role: AgentRole, findings: ReviewFinding[]): ReviewFinding[] {
	return findings.filter((f) => (f.fields.length === 0 ? role === "architect" : f.fields.some((field) => OWNERS[field] === role)))
}

function ownerFixesReview(role: AgentRole): SituationHandler {
	const fixRoundLeft = () => state().review.round <= state().review.maxRounds
	return {
		specification: when(({ event }) => isEvent(event, "review.completed") && event.payload.verdict === "fail" && fixRoundLeft() && reviewFindingsFor(role, event.payload.findings).length > 0),
		processor: {
			apply: ({ event, participant }) => {
				if (!isEvent(event, "review.completed")) return
				const mine = reviewFindingsFor(role, event.payload.findings)
				const list = mine.map((f) => `- [${f.severity}] ${f.fields.join(", ") || "general"}: ${f.issue} Suggestion: ${f.suggestion}`).join("\n")
				requestTurn(participant as Agent, `review@${event.payload.revision}`, `Review findings at revision ${event.payload.revision} for fields you own:\n${list}\nChange the fields you own to address them, if you agree they are right. Leave other fields to their owners.`, { kind: "review", revision: event.payload.revision, items: mine.map((f) => ({ severity: f.severity, fields: f.fields, issue: f.issue })) })
			},
		},
	}
}

export const CONTRACT_SHAPES = `Contract field shapes (units: mm, V, mA):
- requirements: {summary: string, peripherals: string[], batteryLifeDays: number|null, batteryMah?: number, dutyCycle?: {activeMs, periodS, sleepUa}}
- outline: {widthMm, heightMm, thicknessMm}
- connectors: [{ref, kind: "usb-c"|"header"|"button", edge: "left"|"right"|"top"|"bottom", offsetMm (centre along the edge, from bottom or left), widthMm, heightMm}]
  widthMm and heightMm are the part's own opening seen from that edge, not the case: the USB-C receptacle (TYPE-C-31-M-12) is about 9 × 3.2 mm. The case adds its own clearance, and a cutout too tall runs into the lid.
- rails: [{name, voltageV, regulatorMaxMa, loadMa (peak), averageMa? (long-run average including sleep, of this rail's OWN loads only: do not include the current of rails it feeds, nor the regulator's quiescent current)}]
When the brief sets a battery-life target, estimate the duty cycle (requirements.dutyCycle) and each battery-fed rail's averageMa from it, and set batteryMah if the brief does not state the capacity. Battery life is then checked in code: the battery current is the sum of averageMa over every rail except VBUS (they must not overlap), plus each LDO's quiescent current.
dutyCycle.sleepUa is the whole board asleep, excluding the regulator's quiescent current (counted separately). It can't be below the MCU's deep-sleep floor (catalog sleepUa; ESP32-C3-MINI-1: 5 µA), and a lower figure is raised to that floor.
The ESP32-C3-MINI-1 has 4 MB on-module flash: store the reading history there (NVS or LittleFS); no external memory part is needed.
For a battery target, pick a low-Iq regulator: catalog LDOs list their quiescent current as iqUa. XC6206P332MR-G draws 1 µA; AP2112K-3.3TRG1 draws 55 µA, which alone is half the ~116 µA a 500 mAh cell allows for 180 days. A low-Iq LDO keeps its pins VIN, VOUT, GND (no EN).
- parts: [{ref, role (one of: mcu, sensor, ldo, charger, battery, usb-c, led, resistor, capacitor, button, connector, other), mpn, lcsc, footprint, pins: string[]}]
- pins: [{signal (UPPER_SNAKE), gpio: number, partRef, partPin}]
- behavior (optional, owned by firmware): {blinkMs, tiltBlinkMs, tiltDeg}: the status LED blinks every blinkMs, and every tiltBlinkMs while the board is tilted more than tiltDeg (0..90). Without it the LED blinks at 1 Hz and tilt changes nothing.
Reference designators: U1 = MCU (ESP32-C3-MINI-1, pins GPIO0..GPIO10, GPIO18/GPIO19 for USB), U2 = sensor, U3 = LDO, U4 = Li-ion charger, J1 = USB-C, J2 = battery connector, D1 = LED, D2 = charge LED, SW1 = button.
Pin names come from the catalog (use search_parts): the USB-C pins are VBUS, GND, CC1, CC2, DP, DN; the button pins are A and B; the battery connector pins are VBAT and GND. The board generator adds the support passives (CC resistors, pull-ups, decoupling) itself.
To show charging state in hardware (lit while charging, even with the MCU asleep), add a second LED with role charge-led (catalog KT-0603R) next to the charger. The board generator wires its anode to VBUS and its cathode through a 1k resistor to the charger's CHRG pin. Put a 1k resistor (0402WGF1001TCE) in the parts for it, and do not assign the charge LED or CHRG in pins.
Always call read_contract first and pass each field's current version as baseVersion.`

export const ENGINEER_REQUEST_PREFIX = "Change request from the engineer:"

// The request being forwarded (run.ts sets it as it sends the message), so the turn names it by id.
const requestCause = (text: string): Cause => {
	const r = state().currentRequest
	return r && r.text === text ? { kind: "request", id: r.id, text: r.text } : { kind: "request", id: "", text }
}

export function createArchitectAgent(opts: { mock: boolean }): Agent {
	// The engineer's first message is the brief; every later one is a mid-run change request.
	let briefSeen = false
	const agent = createRoleAgent({
		role: "architect",
		mock: opts.mock,
		instruction: `You are the system architect of a small hardware product. From the brief you write the requirements, outline, connectors, rails and pins of the design contract, one propose_contract_change call per field. Only use MCU pins GPIO0..GPIO10 and parts that exist in the catalog. You own those fields: when another discipline asks to change one, decide with decide_change, approving it if it fits the design.\n${CONTRACT_SHAPES}`,
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "message.sent" as never) && state().getParticipant(event.producerId)?.getManifest().name === "engineer"),
				processor: {
					apply: ({ event, participant }) => {
						const message = (event.payload as { message: string }).message
						if (!briefSeen) {
							briefSeen = true
							startTurn(participant as Agent, `Brief from the engineer:\n${message}`, { kind: "brief" })
							return
						}
						startTurn(
							participant as Agent,
							`${ENGINEER_REQUEST_PREFIX}\n${message}\nMeet it by changing the fields you own: call read_contract, then propose_contract_change with each field's current baseVersion. Keep everything the request does not mention. If no field you own can meet it, change nothing and say why.`,
							requestCause(message),
						)
					},
				},
			},
			ownerReviewsChanges("architect"),
			onBuildFailed(["board", "enclosure"], "outline, connectors, rails, pins"),
			ownerFixesReview("architect"),
			{
				specification: when(({ event }) => isEvent(event, "consistency.checked") && event.payload.violations.some((v) => v.affects.includes("architect"))),
				processor: {
					apply: ({ event, participant }) => {
						if (!isEvent(event, "consistency.checked")) return
						const mine = event.payload.violations.filter((v) => v.affects.includes("architect"))
						requestTurn(participant as Agent, `violations@${event.payload.revision}`, `Consistency violations for you at revision ${event.payload.revision}:\n${mine.map((v) => `- ${v.kind}: ${v.message}`).join("\n")}\nFix them by changing the fields you own.`, { kind: "violation", revision: event.payload.revision, items: mine.map((v) => ({ kind: v.kind, message: v.message })) })
					},
				},
			},
			{
				specification: when(({ event }) => isEvent(event, "grounding.checked") && groundingFor(event.payload.findings, true).length > 0),
				processor: {
					apply: ({ event, participant }) => {
						if (!isEvent(event, "grounding.checked")) return
						const mine = groundingFor(event.payload.findings, true)
						requestTurn(participant as Agent, `grounding-pins@${event.payload.revision}`, `The grounding check found pin assignments with no datasheet behind them at revision ${event.payload.revision}:\n${listFindings(mine)}\nFix the pins field: use only GPIOs the MCU has and pins the parts list names.`, { kind: "grounding", revision: event.payload.revision, items: mine.map((f) => ({ kind: f.kind, partRef: f.partRef, detail: f.detail })) })
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
		description: "List vetted catalog parts for a role (mcu, sensor, ldo, charger, battery, usb-c, led, resistor, capacitor, button) with live JLCPCB stock and price; LDOs include iqUa (quiescent current, µA).",
		parameters: { type: "object", properties: { role: { type: "string" } }, required: ["role"] },
		strict: false,
		invoke: async ({ role }: { role: string }) => searchParts(role),
	}
}

export function createPartsAgent(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "parts",
		mock: opts.mock,
		instruction: `You select the parts for a hardware design. Use search_parts for every role the requirements and rails need, prefer in-stock parts, and write the complete parts list with one propose_contract_change. Keep the reference designators below. You own the parts list: when another discipline asks to change it, decide with decide_change.\n${CONTRACT_SHAPES}`,
		tools: [searchPartsTool()],
		handlers: [
			ownerFixesReview("parts"),
			ownerReviewsChanges("parts"),
			onBuildFailed(["board", "firmware"], "parts"),
			{
				specification: when(({ event }) => isEvent(event, "contract.changed") && (event.payload.field === "requirements" || event.payload.field === "rails")),
				processor: {
					apply: ({ participant }) => {
						const c = state().contract
						requestTurn(participant as Agent, `parts@${c.version("requirements")}.${c.version("rails")}`, "The requirements or rails changed. Choose the parts.", { kind: "field-changed", fields: ["requirements", "rails"] })
					},
				},
			},
			{
				specification: when(({ event }) => isEvent(event, "grounding.checked") && groundingFor(event.payload.findings, false).length > 0),
				processor: {
					apply: ({ event, participant }) => {
						if (!isEvent(event, "grounding.checked")) return
						const mine = groundingFor(event.payload.findings, false)
						requestTurn(participant as Agent, `grounding@${event.payload.revision}`, `The grounding check found parts with no datasheet behind them at revision ${event.payload.revision}:\n${listFindings(mine)}\nFix the parts list: use search_parts and list only the pins the catalog gives.`, { kind: "grounding", revision: event.payload.revision, items: mine.map((f) => ({ kind: f.kind, partRef: f.partRef, detail: f.detail })) })
					},
				},
			},
		],
	})
}

// The firmware discipline's reasoning side: it checks that the pin map gives firmware what the
// requirements need and asks the architect (through change control) for anything missing.
export function createFirmwareReviewer(opts: { mock: boolean }): Agent {
	let briefSeen = false
	return createRoleAgent({
		role: "firmware",
		name: "firmware-reviewer",
		mock: opts.mock,
		instruction: `You are the firmware engineer. Check that the pins in the contract cover every peripheral in the requirements (I2C bus, status LED, buttons). If a signal is missing, propose the complete new pins list with propose_contract_change; the architect must approve it. If the firmware build failed, read the error and propose the pin change that fixes it. Change nothing if the pins are sufficient. You own the behavior field: what the firmware does (LED blink periods, tilt threshold); the firmware template reads it, so you never write C++.\n${CONTRACT_SHAPES}`,
		handlers: [
			{
				// The engineer's messages after the brief are change requests; the ones about firmware behavior are this agent's.
				specification: when(({ event }) => isEvent(event, "message.sent" as never) && state().getParticipant(event.producerId)?.getManifest().name === "engineer"),
				processor: {
					apply: ({ event, participant }) => {
						if (!briefSeen) {
							briefSeen = true
							return
						}
						const message = (event.payload as { message: string }).message
						startTurn(
							participant as Agent,
							`${ENGINEER_REQUEST_PREFIX}\n${message}\nIf it is about what the firmware does (the LED, blinking, tilt), meet it by changing the behavior field you own: call read_contract, then propose_contract_change with its current baseVersion, keeping what the request does not mention. Otherwise change nothing; the architect handles the rest.`,
							requestCause(message),
						)
					},
				},
			},
			{
				specification: when(({ event }) => isEvent(event, "contract.changed") && event.payload.field === "pins"),
				processor: { apply: ({ participant }) => requestTurn(participant as Agent, `pins@${state().contract.version("pins")}`, "The pin map changed. Review it against the requirements.", { kind: "field-changed", fields: ["pins"] }) },
			},
			{
				specification: when(({ event }) => isEvent(event, "consistency.checked") && event.payload.violations.some((v) => v.affects.includes("firmware"))),
				processor: {
					apply: ({ event, participant }) => {
						if (!isEvent(event, "consistency.checked")) return
						const mine = event.payload.violations.filter((v) => v.affects.includes("firmware"))
						requestTurn(participant as Agent, `fw-violations@${event.payload.revision}`, `Firmware violations at revision ${event.payload.revision}:\n${mine.map((v) => `- ${v.kind}: ${v.message}`).join("\n")}`, { kind: "violation", revision: event.payload.revision, items: mine.map((v) => ({ kind: v.kind, message: v.message })) })
					},
				},
			},
		],
	})
}
