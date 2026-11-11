import type { Agent, SituationHandler, Tool } from "@mozaik-ai/core"
import { isEvent, type ArtifactKind, type Cause, type ReviewFinding } from "../events.ts"
import { OWNERS, type AgentRole, type FieldName } from "../contract/types.ts"
import { ownerReviewsChanges, when } from "../change-control.ts"
import { state } from "../runtime.ts"
import { searchParts } from "../tools/parts-search.ts"
import { CASE_SHAPE } from "../contract/case.ts"
import { ROUTING_FAILURE } from "../contract/space.ts"
import { CONNECTIVITY_SHAPE } from "../contract/connectivity.ts"
import { createRoleAgent, requestTurn, startTurn } from "./common.ts"
import { isPinAssignmentFinding } from "./grounding-check.ts"
import type { GroundingFinding } from "../contract/grounding.ts"
import { rankMcus, type McuRequest } from "../mcu/select.ts"

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
						`If the failure comes from a contract field you own (${owns}), for example an unknown footprint, a missing part or a pin on a part that doesn't exist, fix it with propose_contract_change. Otherwise change nothing.` +
						(kind === "board" && ROUTING_FAILURE.test(String(error)) && owns.includes("outline") ? ` This one is the autorouter running out of room: give it room (a bigger outline, with sizeReason "routing" naming this build) or change what crowds it.` : ""),
					{ kind: "build-failed", artifact: kind, revision, error: String(error).split("\n")[0] },
				)
			},
		},
	}
}

const listFindings = (findings: GroundingFinding[]) => findings.map((f) => `- ${f.kind} on ${f.partRef} (${f.source}): ${f.detail}`).join("\n")

// Brief review findings for the fields this role owns (a finding naming no field goes to the architect), while a
// fix round is left. Each review wakes an owner once.
// Fields whose absence means the design doesn't have that feature: only the brief or the engineer adds one, never a
// review finding that names it in passing (real system run, 9 Nov: a battery finding tagged "model" sent the ML
// engineer to write an always-listening wake word nobody asked for).
const FEATURE_FIELDS: readonly FieldName[] = ["model", "test"]
function reviewFindingsFor(role: AgentRole, findings: ReviewFinding[]): ReviewFinding[] {
	const exists = (field: FieldName) => !FEATURE_FIELDS.includes(field) || state().contract.version(field) > 0
	return findings.filter((f) => (f.fields.length === 0 ? role === "architect" : f.fields.some((field) => OWNERS[field] === role && exists(field))))
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
- outline: {widthMm, heightMm, thicknessMm, sizeReason?: {kind, detail}}
  Space rules: the board is compact by default, at most 15% over the smallest it can be (the design facts compute it). More than that needs outline.sizeReason, one of: "engineer-size" (the brief or the engineer set the size; say where), "usability", "standard-fit", "function" (e.g. keeping the sensor away from the MCU and regulator heat), "assembly-test", "expansion", "routing" (a smaller board was built and failed its checks: name the build). The engineer's own words outrank compactness; compactness outranks cost.
- connectors: [{ref, kind: "usb-c"|"header"|"button", edge: "left"|"right"|"top"|"bottom", offsetMm (centre along the edge, from bottom or left), widthMm, heightMm}]
  widthMm and heightMm are the part's own opening seen from that edge, not the case: the USB-C receptacle (TYPE-C-31-M-12) is about 9 × 3.2 mm. The case adds its own clearance, and a cutout too tall runs into the lid.
  The ESP32-C3-MINI-1 module always goes at the edge opposite the USB-C port, its antenna past that edge, and needs about 14 mm of it clear, 12 mm deep: put other connectors on the other edges, or far enough along that one. A connector in its way leaves it no spot at any board size.
- rails: [{name, voltageV, regulatorMaxMa, loadMa (peak), averageMa? (long-run average including sleep, of this rail's OWN loads only: do not include the current of rails it feeds, nor the regulator's quiescent current)}]
When the brief sets a battery-life target, estimate the duty cycle (requirements.dutyCycle) and each battery-fed rail's averageMa from it, and set batteryMah if the brief does not state the capacity. Battery life is then checked in code: the battery current is the sum of averageMa over every rail except VBUS (they must not overlap), plus each LDO's quiescent current.
The reviewer also gets a second check from the duty cycle alone: each wake lasts activeMs (at least the firmware's 30 ms reading plus 50 ms of BLE advertising; the advertising window is activeMs minus the reading) at the busiest battery-fed rail's loadMa, then sleepUa plus LDO quiescent current for the rest of periodS. State averages consistent with that arithmetic, a loadMa that is the real peak, and an activeMs no longer than the wake needs: a long wake costs battery life directly.
dutyCycle.sleepUa is the whole board asleep, excluding the regulator's quiescent current (counted separately). It can't be below the MCU's deep-sleep floor (catalog sleepUa; ESP32-C3-MINI-1: 5 µA), and a lower figure is raised to that floor.
On a deep-sleeping ESP32-C3 design, GPIO9 is the recovery BOOT pad and GPIO8 must read high at reset for download boot, so the board generator pulls GPIO8 up: don't put an LED (or anything held low at reset) on GPIO8; a button to GND, a UART line or I2C may go there.
The ESP32-C3-MINI-1 has 4 MB on-module flash: if the design keeps a reading history, it goes there (NVS or LittleFS); no external memory part is needed.
The ESP32-C3-MINI-1 needs a supply that can deliver 0.5 A (module datasheet v2.2): its radio bursts are short and high. So its regulator must be rated 500 mA or more: in the catalog RT9080-33GJ5 (600 mA, 2 µA quiescent; same pins as the AP2112K: VIN, GND, EN, NC, VOUT, EN tied to VIN) and AP2112K-3.3TRG1 (600 mA, 55 µA) are; XC6206P332MR-G (200 mA) browns it out, low quiescent current or not. For a battery target prefer the RT9080-33GJ5: the AP2112K's 55 µA alone is half the ~116 µA a 180-day target on 500 mAh allows. Catalog LDOs list their quiescent current as iqUa. A rail's regulatorMaxMa is its regulator's own rating (catalog maxMa); a higher claim is a violation. The 3V3 rail's loadMa must cover the radio's transmit peak: 170 mA for Bluetooth LE at 0 dBm, 350 mA for Wi-Fi (the design facts give it).
- parts: [{ref, role (one of: mcu, sensor, microphone, ldo, charger, battery, usb-c, led, resistor, capacitor, button, connector, motor-driver (a robot's motor driver), other), mpn, lcsc, footprint, pins: string[]}]
- pins: [{signal (UPPER_SNAKE), gpio: number, partRef, partPin}]. gpio is the MCU's pin index as its profile defines it (the design facts' MCU section lists every usable pin as NAME=index: GPIO4=4 on an ESP32, PB7=23 on an STM32).
- search_parts stock: a number is live from LCSC; stock null means unknown, not out of stock.
- links (when the board is part of a system of boards) is the integrator's: you don't write it, you follow it. For each link, list its connector in connectors (kind "header", on the link's edge if it names one, about 5.8 × 3 mm), and for a UART link assign <id>_TX and <id>_RX to the connector's IO pins the design facts give, on free GPIOs. An I2C link uses the board's own I2C_SDA/I2C_SCL.
- requirements.enclosure (optional): who houses the board. "case" when the brief asks for a case or a finished device in one: Bringup designs and prints it. Leave it out only when the brief doesn't say (Bringup then designs a case and tells the engineer it assumed one). "none" when the brief or the engineer wants a bare board (lab use, a dev kit, a test rig, "no case"); "own" when it goes into the engineer's own housing or an existing product (Bringup then writes the board's mechanical interface instead of a case). With a case, every button needs an opening: list it in connectors (kind "button", on the edge it is pressed from), or leave it out.
- requirements.usbWake (optional, true or false): leave it out. A deep-sleeping board then wakes when USB is plugged in and stays awake while it is, so a USB-C cable alone reflashes it; the board generator adds a VBUS-sense divider on the first free pin of GPIO0, 1, 3, 4, 5, so keep one of those free. Set it to false only when the engineer asks; then reflashing needs the case open and the bottom recovery pads.
- requirements.historyDays (optional, whole days): how many days of readings the firmware keeps in flash; without it, 30. Claim only what the history must hold: the check compares it with the flash at the reading period.
- behavior (optional, owned by firmware): {blinkMs, tiltBlinkMs, tiltDeg}: the status LED blinks every blinkMs, and every tiltBlinkMs while the board is tilted more than tiltDeg (0..90). Without it the LED blinks at 1 Hz and tilt changes nothing. behavior is exactly these three numbers and nothing else. It cannot express "blink on each reading" or charging state: the charge LED is a part (role charge-led) wired to the charger, not behavior.
Reference designators (a naming convention, not a parts list: use the one for each part the design has; none of these parts is required): U1 = MCU (any catalog MCU: compare them with compare_mcus; the ESP32-C3-MINI-1 uses GPIO0..GPIO10, GPIO18/GPIO19 for USB; others as their design facts list), U2 = sensor (only when the requirements call for one), U3 = LDO, U4 = Li-ion charger, J1 = USB-C, J2 = battery connector, D1 = LED, D2 = charge LED, SW1 = button.
A wake button: the firmware wakes from deep sleep when it is pressed only if its pin is signal BUTTON on one of GPIO0..5 (the ESP32-C3's deep-sleep wake pins), wired to the button's A pin; the board generator ties B to GND.
For a catalog part the contract fills in its pins, footprint and LCSC number from the catalog, whatever you write; you choose ref, role and mpn. Pin names come from the catalog (use search_parts): the USB-C pins are VBUS, GND, CC1, CC2, DP, DN; the button pins are A and B; the battery connector pins are VBAT and GND. The board generator adds the support passives (CC resistors, pull-ups, decoupling) itself.
To show charging state in hardware (lit while charging, even with the MCU asleep), add a second LED with role charge-led (catalog KT-0603R) next to the charger. The board generator wires its anode to VBUS and its cathode through a 1k resistor to the charger's CHRG pin. Put a 1k resistor (0402WGF1001TCE) in the parts for it, and do not assign the charge LED or CHRG in pins.
Each turn message ends with the design facts: part facts for the chosen parts, the live power budget and the duty-cycle check, recomputed from the current contract. The final brief review judges with the same facts.
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
		instruction: `You are the system architect of a small hardware product. From the brief you write the requirements, outline, connectors, rails and pins of the design contract, one propose_contract_change call per field. Only use MCU pins the design facts list as usable for the chosen MCU (GPIO0..GPIO10 on the ESP32-C3-MINI-1) and parts that exist in the catalog. You own those fields: when another discipline asks to change one, decide with decide_change, approving it if it fits the design.\n${CONTRACT_SHAPES}`,
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
							`${ENGINEER_REQUEST_PREFIX}\n${message}\nMeet it by changing the fields you own: call read_contract, then propose_contract_change with each field's current baseVersion. Keep everything the request does not mention. If no field you own can meet it, change nothing and say why. A request about the case itself (its size, walls, height, lid, lettering, mounting tabs, a lanyard loop, a hole in it) is the case designer's: change nothing for it. If the case needs a different board, the case designer proposes it to you.`,
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
						requestTurn(participant as Agent, `violations@${event.payload.revision}:${mine.map((v) => v.kind).join(",")}`, `Consistency violations for you at revision ${event.payload.revision}:\n${mine.map((v) => `- ${v.kind}: ${v.message}`).join("\n")}\nFix them by changing the fields you own.`, { kind: "violation", revision: event.payload.revision, items: mine.map((v) => ({ kind: v.kind, message: v.message })) })
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

// Every catalog MCU through the same tests and score (src/mcu/select.ts): which fit the design's pins, peripherals and
// radio, which Bringup can build a board for, and why each ranks where it does.
function compareMcusTool(): Tool {
	return {
		type: "function",
		name: "compare_mcus",
		description: "Rank every MCU Bringup knows (any vendor) for this design on the same terms: whether its pins and peripherals fit the needs (pin solver), whether it has the radio, whether Bringup can build its board, then sleep current (battery), price, stock and simulator. Each result lists why, with numbers.",
		parameters: {
			type: "object",
			properties: {
				needs: { type: "array", items: { type: "object", properties: { signal: { type: "string" }, kind: { type: "string", enum: ["gpio", "adc", "wake", "uart", "i2c", "spi", "i2s", "usb", "can"] }, role: { type: "string" }, group: { type: "string" } }, required: ["signal", "kind"] } },
				radio: { type: "array", items: { type: "string", enum: ["ble", "wifi"] } },
				battery: { type: "boolean" },
			},
			required: ["needs"],
		},
		strict: false,
		invoke: async (req: McuRequest) => rankMcus(req),
	}
}

// Consistency violations addressed to a role wake it once per revision, with what to do about them.
// only: which of the role's violations it can act on (the case designer shares the "enclosure" role with the case
// builder, whose cutout and vent violations a rebuild fixes).
function violationsFor(role: AgentRole, guidance: string, only: (kind: string) => boolean = () => true): SituationHandler {
	const ours = (v: { kind: string; affects: AgentRole[] }) => v.affects.includes(role) && only(v.kind)
	return {
		specification: when(({ event }) => isEvent(event, "consistency.checked") && event.payload.violations.some(ours)),
		processor: {
			apply: ({ event, participant }) => {
				if (!isEvent(event, "consistency.checked")) return
				const mine = event.payload.violations.filter(ours)
				requestTurn(participant as Agent, `${role}-violations@${event.payload.revision}:${mine.map((v) => v.kind).join(",")}`, `Consistency violations for you at revision ${event.payload.revision}:\n${mine.map((v) => `- ${v.kind}: ${v.message}`).join("\n")}\n${guidance}`, { kind: "violation", revision: event.payload.revision, items: mine.map((v) => ({ kind: v.kind, message: v.message })) })
			},
		},
	}
}

// The engineer's messages after the brief are change requests: each one starts a turn with the role's guidance. The
// first message is the brief, which reaches the agents another way.
function engineerRequests(guidance: string): SituationHandler {
	let briefSeen = false
	return {
		specification: when(({ event }) => isEvent(event, "message.sent" as never) && state().getParticipant(event.producerId)?.getManifest().name === "engineer"),
		processor: {
			apply: ({ event, participant }) => {
				if (!briefSeen) {
					briefSeen = true
					return
				}
				const message = (event.payload as { message: string }).message
				startTurn(participant as Agent, `${ENGINEER_REQUEST_PREFIX}\n${message}\n${guidance}`, requestCause(message))
			},
		},
	}
}

export function createPartsAgent(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "parts",
		mock: opts.mock,
		instruction: `You select the parts for a hardware design. Use search_parts for every role the requirements and rails need, and choose only those: no part for something the brief puts out of scope (no sensor when the brief rules sensors out). Prefer in-stock parts, and write the complete parts list with one propose_contract_change. Keep the reference designators below. You own the parts list: when another discipline asks to change it, decide with decide_change.\n${CONTRACT_SHAPES}`,
		tools: [searchPartsTool(), compareMcusTool()],
		handlers: [
			ownerFixesReview("parts"),
			ownerReviewsChanges("parts"),
			onBuildFailed(["board", "firmware"], "parts"),
			// The parts list's owner hears the engineer directly (real run 18: it only saw the architect's proposal).
			engineerRequests(
				"If it is about the parts (stock, a different or extra part), meet it by changing the parts list you own: call read_contract and search_parts, then propose_contract_change with the parts' current baseVersion, keeping every part the request does not mention. The engineer's word on stock counts over search_parts: the lookup can lag or not know. Otherwise change nothing; the architect handles the rest.",
			),
			{
				specification: when(({ event }) => isEvent(event, "contract.changed") && (event.payload.field === "requirements" || event.payload.field === "rails")),
				processor: {
					apply: ({ participant }) => {
						const c = state().contract
						requestTurn(participant as Agent, `parts@${c.version("requirements")}.${c.version("rails")}`, "The requirements or rails changed. Choose the parts.", { kind: "field-changed", fields: ["requirements", "rails"] })
					},
				},
			},
			// Violations the parts list can fix (a model's missing sensor, a rail its regulator can't carry). Before, no
			// handler woke parts, so a violation that named it reached only the architect.
			violationsFor("parts", "Fix them by changing the parts list you own: use search_parts, then propose_contract_change with the parts' current baseVersion, keeping every other part."),
			{
				specification: when(({ event }) => isEvent(event, "grounding.checked") && groundingFor(event.payload.findings, false).length > 0),
				processor: {
					apply: ({ event, participant }) => {
						if (!isEvent(event, "grounding.checked")) return
						const mine = groundingFor(event.payload.findings, false)
						requestTurn(participant as Agent, `grounding@${event.payload.revision}`, `The grounding check found parts with no datasheet behind them at revision ${event.payload.revision}:\n${listFindings(mine)}\nFix the parts list: use search_parts and list only the pins the catalog gives, keeping every other part.`, { kind: "grounding", revision: event.payload.revision, items: mine.map((f) => ({ kind: f.kind, partRef: f.partRef, detail: f.detail })) })
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
		instruction: `You are the firmware engineer. Check that the pins in the contract cover every peripheral in the requirements (I2C bus, status LED, buttons). If a signal is missing, propose the complete new pins list with propose_contract_change; the architect must approve it. If the firmware build failed, read the error and propose the pin change that fixes it. Change nothing if the pins are sufficient. You own the behavior field, and decide with decide_change when another discipline proposes to change it: what the firmware does (LED blink periods, tilt threshold); the firmware template reads it, so you never write C++.\n${CONTRACT_SHAPES}`,
		handlers: [
			// It owns behavior, so it decides the changes others propose to it (without this they waited 120 s, real run 15).
			ownerReviewsChanges("firmware"),
			// The engineer's messages after the brief are change requests; the ones about firmware behavior are this agent's.
			engineerRequests(
				"If it is about what the firmware does (the LED, blinking, tilt), meet it by changing the behavior field you own: call read_contract, then propose_contract_change with its current baseVersion, keeping what the request does not mention. Otherwise change nothing; the architect handles the rest.",
			),
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

export const MODEL_SHAPE = `The model field (you own it): {task, sensor: "microphone"|"motion"|"camera", sampleRateHz, windowMs, channels, weightsKb, arenaKb, runtime, quantization: "int8"|"float32", listening: "always"|"on-wake"}.
- weightsKb is the model in flash, arenaKb the tensor arena in RAM. Until a model is trained these are planning figures; the bench measures the real ones.
- listening "always" keeps the microphone and the MCU awake to listen (a wake word); "on-wake" listens one window per duty-cycle wake.
- Code checks it: weights and arena against the flash and static RAM the firmware leaves on the MCU (measured), a sensor of its kind in the parts list with its data lines in pins, the sensor's supported sample rates (the ICS-43434: 6.25–18.75 kHz low-power or 23–51.6 kHz), and the battery budget with listening counted. The design facts at the end of each turn give the numbers.
- To make a model fit: int8 quantization is about a quarter of float32 weights; pruning and a shorter window shrink weights and arena.
- Optional data: {status: "recorded"|"needed", revision, pathHash, path}, the sensor path the training data was recorded on (or must be). Copy revision, pathHash and path from the design facts' "sensor path now" line. When the hardware moves under recorded data (model-stale), you can't retrain during the design: set status "needed" on the new path, so the data-collection firmware records it.`

// The ML discipline: it owns the model field. It writes the model a request calls for, keeps it fitting the MCU's
// flash and RAM and the sensor's rates as the design changes, and leaves the sensor part to parts and its pins to the
// architect, whom the checks wake.
export function createMlAgent(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "ml",
		mock: opts.mock,
		instruction: `You are the ML engineer of a small hardware product: you own the on-device model. Write it with propose_contract_change when the engineer asks for on-device intelligence (a wake word, keywords, a gesture, a sound or image classifier), and keep it fitting the design. You don't add the sensor part or its pins: the consistency check wakes parts and the architect for those. When another discipline proposes a change to the model, decide with decide_change.\n${MODEL_SHAPE}\n${CONTRACT_SHAPES}`,
		handlers: [
			ownerReviewsChanges("ml"),
			ownerFixesReview("ml"),
			engineerRequests(
				"If it asks for on-device intelligence (a wake word, voice commands, a gesture, sound or image recognition), meet it by writing the model field you own: call read_contract, then propose_contract_change with its current baseVersion. If it says the training data has been recorded, set the model's data to status \"recorded\" on the sensor path in the design facts. Otherwise change nothing.",
			),
			violationsFor("ml", "Fix them by changing the model you own (quantize, prune, shorten the window, pick a rate the sensor supports, or mark its data needed on the new sensor path), with propose_contract_change and its current baseVersion."),
		],
	})
}

export const TEST_SHAPE = `The test field (you own it): {points: string[], awakeMaxMa, sleepMaxUa}.
- points: the nets the bed-of-nails fixture probes. Each gets a 1.5 mm test pad on the board's underside. Use contract signal names (I2C_SDA) and the power nets GND, 3V3 and VBAT (VBAT when the design has a battery charger). VBUS is optional: the station powers the board through its USB-C port, which it needs anyway for the factory test's output.
- awakeMaxMa and sleepMaxUa: the supply current a good board stays at or below while its self-test runs, and in deep sleep. The design facts give the design's own peak and sleep currents; leave margin over them (part-to-part spread), or every good board fails.
- Code checks it: every signal and power net probed, no net the design no longer has, limits at or above the design's own currents, and room on the board's underside for each pad (2.54 mm grid, 3 mm from the edge, clear of the module, connectors and holes). From it Bringup builds the test pads, the fixture, the factory-test firmware and the test plan.`

// The test discipline: it owns the production test. It writes the test field when the engineer asks for a production
// test or a fixture, and keeps it following the design (a new pin needs a pad; a lower-power part lowers the limit).
export function createTestAgent(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "test",
		mock: opts.mock,
		instruction: `You are the test engineer of a small hardware product: you own its production test. Write it with propose_contract_change when the engineer asks for a production or factory test, a test fixture or test pads, and keep it following the design as it changes. You don't change the board, parts or pins: the board, the fixture and the factory-test firmware are built from your field. When another discipline proposes a change to the test field, decide with decide_change.\n${TEST_SHAPE}\n${CONTRACT_SHAPES}`,
		handlers: [
			ownerReviewsChanges("test"),
			ownerFixesReview("test"),
			engineerRequests(
				"If it asks for a production or factory test, a test fixture, a bed of nails or test pads, meet it by writing the test field you own: call read_contract, then propose_contract_change with its current baseVersion, probing every signal and power net, with limits from the design facts plus margin. Otherwise change nothing.",
			),
			violationsFor("test", "Fix them by changing the test field you own (add or drop points, raise a limit to the design's own current plus margin), with propose_contract_change and its current baseVersion."),
		],
	})
}

export const CASE_DESIGN = `${CASE_SHAPE}.
- Frame: the board's bottom-left corner is the origin; a hole's offsetMm runs along its edge like a connector's (from the bottom on left/right, from the left on top/bottom), and the wall extends 2 mm past the board at each end.
- The case's outer size is the board outline plus 2 × (2 mm clearance + wallMm) each way, and it follows the board: you don't set it directly. A case that must be a given outer size needs a different board outline (the architect's field): propose the outline that gives it. That changes the PCB, so it also waits for the engineer's confirmation; if it is rejected, keep the board and say so.
- Code checks the case field: the body tall enough for the connectors' cutouts under the lid's 3 mm lip, a hole that fits its wall's free height and keeps 1.2 mm of wall from every cutout and other hole, tabs that fit their wall and don't overlap. The design facts give the numbers (outer size, the lowest body, the largest hole). Fix your own field first: move a hole along its wall or to another wall, make the body taller. Ask to move a connector (the architect's connectors field, a PCB change the engineer must confirm) only when the engineer wants the hole exactly there.
- Space rules: the body is at most 15% taller than its contents need (the design facts give it); taller needs case.sizeReason ("engineer-size" when the engineer asked for it, or another listed reason).`

// The case designer: it owns the case field (walls, height, added features). The enclosure builder makes the case from
// the board and this field; a case request that needs a different board goes to the architect through change control,
// and since it changes the PCB, it also waits for the engineer's confirmation (contract/case.ts boardChangeWarning).
// The mechanics engineer of a robot (docs/mechanics.md): owns the mechanics field — drive, battery, sensor mount and
// chassis layout — and designs to the plain-code checks in src/mechanics/checks.ts. Wakes only for a design with
// motion targets: a board without them never sees a mech-* violation.
export const MECHANICS_RULES = `The checks your design must pass (src/mechanics/checks.ts):
- torque: each motor's stall torque at the cell's nominal voltage ≥ ${1.5}× what lifting its wheel over the motion.edgeMm step and rolling need;
- speed: no-load speed at nominal voltage × 0.8 under load × wheel circumference ≥ motion.speedMps;
- stopping: braking distance on the floor plus one sensor period of travel ≤ the sensor's range − motion.stopBeforeWallMm;
- current: a motor's stall current on a full cell ≤ the driver's peak per channel; both motors at stall plus the electronics ≤ the pack's peak;
- runtime: the pack's usable energy at cruise ≥ motion.runtimeMin; voltage: a full cell ≤ 1.5× the motor's rating, within the driver's range;
- tipping: the centre of mass stays 10 mm inside the wheels-and-caster triangle, also when braking hard;
- fit: boards, battery, caster and sensor on the plate; motors half under it; wheels clear it by 2 mm; the plate level (clearanceMm = wheel radius + half the motor height = the caster's height, within 3 mm); clearance ≥ the edge; within motion.maxSizeMm and maxMassG; nothing in front of the sensor.
Pick motors, wheels, casters, packs and sensor modules only from catalog/mechanics.json (every number there has a datasheet behind it).`

export function createMechanicsAgent(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "mechanics",
		name: "mechanics",
		mock: opts.mock,
		instruction: `You are the mechanics engineer of a small robot: you own the mechanics field (drive, battery, sensor mount and chassis layout). The architect owns motion (the brief's targets) and the boards. Lay out the chassis in millimetres with the origin at the plate's centre and +x forward, and propose it with propose_contract_change. When another discipline proposes a change to mechanics, decide with decide_change.\n${MECHANICS_RULES}\n${CONTRACT_SHAPES}`,
		handlers: [
			ownerReviewsChanges("mechanics"),
			ownerFixesReview("mechanics"),
			engineerRequests("If it is about the robot's body (its size, wheels, motors, battery, where things sit, how fast it drives), meet it: call read_contract, then propose_contract_change on the mechanics field with its current baseVersion, keeping everything the request does not mention, so every check above still passes. Otherwise change nothing."),
			violationsFor("mechanics", "Fix them by changing the mechanics field you own (other parts, a longer wheelbase, the battery moved back, a wider plate), with propose_contract_change and its current baseVersion.", (kind) => kind.startsWith("mech-")),
		],
	})
}

export function createCaseAgent(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "enclosure",
		name: "case-designer",
		mock: opts.mock,
		instruction: `You are the case designer of a small hardware product: you own the case field. When requirements.enclosure is "none" (a bare board) or "own" (the engineer's own housing), the design has no case of ours: change nothing; a request to bring a case back is the architect's (requirements.enclosure). The case is generated around the board (cutouts, vents, standoffs, lid); you set its walls, its height and the features added to it, with propose_contract_change, when the engineer asks for something about the case. You never edit the board yourself. When another discipline proposes a change to the case field, decide with decide_change.\n${CASE_DESIGN}\n${CONTRACT_SHAPES}`,
		handlers: [
			ownerReviewsChanges("enclosure"),
			ownerFixesReview("enclosure"),
			engineerRequests(
				"If requirements.enclosure is \"none\" or \"own\", change nothing: whether there is a case at all is the architect's field. Otherwise, if it is about the case (its outer size, walls, height, lid, lettering on it, wall-mount tabs, a lanyard loop, a hole for a cable or a cable gland), meet it: call read_contract, then propose_contract_change on the case field with its current baseVersion (a new case field has baseVersion 0, starting from walls 2 mm, height 14 mm, no features), keeping every feature the request does not mention. If it sets the case's outer size, also propose the board outline that gives it. Otherwise change nothing.",
			),
			violationsFor("enclosure", "Fix them by changing the case field you own (move or resize a hole, a taller or lower body, tabs on other walls, or a sizeReason when the room is wanted), with propose_contract_change and its current baseVersion.", (kind) => kind.startsWith("case-") || kind === "space-slack"),
		],
	})
}

export const CONNECTIVITY_DESIGN = `${CONNECTIVITY_SHAPE}.
- Bluetooth LE: "bthome" is how a consumer device reaches Home Assistant with no app (its built-in BTHome integration reads the broadcast); "gatt" lets a phone app read the stored history. Both can run together.
- Wi-Fi: each upload joins the network, which costs seconds of radio time (an estimate: about 3 s at 120 mA; Espressif gives no figure), so uploads are batched: uploadPeriodS is a whole multiple of the duty cycle's period. The 3V3 rail's peak must cover Wi-Fi transmitting (350 mA), and the regulator must deliver the module's 0.5 A either way. A battery target that Wi-Fi can't meet goes to the architect (a longer upload period, a bigger cell, or USB power).
- updates "ota" keeps two firmware slots in flash (1.25 MB each instead of one 2 MB slot), which a large model may not fit; it needs Wi-Fi. "none" can't fix a bug in the field.
- The design facts give the battery check with the radio counted, and the flash each choice leaves.`

// The connectivity engineer: owns how the product reaches its owner (the radio, how readings leave, field updates).
// A change ripples through the checks: the radio's transmit peak against the rail and the regulator, Wi-Fi uploads
// against the battery target, an update slot against the flash a model needs, and the firmware rebuilds.
export function createConnectivityAgent(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "connectivity",
		name: "connectivity-engineer",
		mock: opts.mock,
		instruction: `You are the connectivity engineer of a small consumer hardware product: you own the connectivity field, how the device reaches its owner. Write it with propose_contract_change when the engineer asks about the radio, Bluetooth or Wi-Fi, Home Assistant, a phone app, uploads or firmware updates. You don't change the parts, rails or requirements: the checks wake their owners. When another discipline proposes a change to connectivity, decide with decide_change.\n${CONNECTIVITY_DESIGN}\n${CONTRACT_SHAPES}`,
		handlers: [
			ownerReviewsChanges("connectivity"),
			ownerFixesReview("connectivity"),
			engineerRequests(
				"If it is about how the device connects (Bluetooth, BTHome, Home Assistant, Wi-Fi, MQTT, a phone app, uploads, firmware updates), meet it by writing the connectivity field you own: call read_contract, then propose_contract_change with its current baseVersion (0 when there is none yet; without it the device is Bluetooth LE with the GATT service and no updates). Otherwise change nothing.",
			),
			violationsFor("connectivity", "Fix them by changing the connectivity field you own (a longer upload period, Bluetooth instead of Wi-Fi, no update slot), with propose_contract_change and its current baseVersion; leave other fields to their owners."),
		],
	})
}
