import type { Agent, SituationHandler, Tool } from "@mozaik-ai/core"
import { isEvent, type ArtifactKind, type Cause, type ReviewFinding } from "../events.ts"
import { OWNERS, type AgentRole, type FieldName } from "../contract/types.ts"
import { ownerReviewsChanges, when } from "../change-control.ts"
import { state } from "../runtime.ts"
import { searchParts } from "../tools/parts-search.ts"
import { CASE_SHAPE } from "../contract/case.ts"
import { ROUTING_FAILURE } from "../contract/space.ts"
import { WAITING_ON_CONTRACT } from "../contract/consistency.ts"
import { CONNECTIVITY_SHAPE } from "../contract/connectivity.ts"
import { createRoleAgent, latestCheck, requestTurn, startTurn } from "./common.ts"
import { recipients } from "./recipients.ts"
import { isPinAssignmentFinding } from "./grounding-check.ts"
import type { GroundingFinding } from "../contract/grounding.ts"
import { rankMcus, type McuRequest } from "../mcu/select.ts"
import { MECHANICS_SHAPE } from "../mechanics/shape.ts"
import { ARM_SHAPE, ARM_TARGETS_SHAPE } from "../arm/shape.ts"
import { ARM_APPROACH_MM, TIP_MARGIN_MM as ARM_TIP_MARGIN_MM, worstTorques } from "../arm/checks.ts"
import { servoAt } from "../mechanics/catalog.ts"
import { est } from "../mechanics/estimates.ts"
import { solveWithMotorClass, type ChassisChoice } from "../mechanics/solve.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { CNC_SHAPE, CNC_TARGETS_SHAPE } from "../cnc/shape.ts"

// Splits the grounding check's findings between the parts list (the parts agent's) and the pin assignments (the architect's).
function groundingFor(findings: GroundingFinding[], pinAssignments: boolean): GroundingFinding[] {
	const s = state().contract.snapshot()
	return findings.filter((f) => isPinAssignmentFinding(f, s) === pinAssignments)
}

export const BUILD_FAILED_PREFIX = "Build failed:"

// Wakes an agent when an artifact it can fix fails to build. The error is already cut down to the real cause
// (tools/board.ts buildErrors). Each failure (kind and revision) wakes the agent once.
// A build that failed because a tool isn't installed on this machine (src/agents/builders.ts, src/tools/*: "... is not
// installed") is no design problem: no contract change fixes it, so it wakes no owner. The run still reports it under
// "Missing tools" (src/report.ts). One domain's missing tool (build123d for the case) then costs the others no turns.
export const TOOL_MISSING = /\bis not installed\b/
function onBuildFailed(kinds: ArtifactKind[], owns: string): SituationHandler {
	return {
		specification: when(({ event }) => isEvent(event, "artifact.failed") && kinds.includes(event.payload.kind)),
		processor: {
			apply: ({ event, participant }) => {
				if (!isEvent(event, "artifact.failed")) return
				const { kind, revision, error } = event.payload
				if (TOOL_MISSING.test(String(error)) || WAITING_ON_CONTRACT.test(String(error))) return
				requestTurn(
					participant as Agent,
					`build-failed@${kind}@${revision}`,
					`${BUILD_FAILED_PREFIX} the ${kind} build failed at revision ${revision}:\n${error}\n` +
						`If the failure comes from a contract field you own (${owns}), for example an unknown footprint, a missing part or a pin on a part that doesn't exist, fix it with propose_contract_change. Otherwise change nothing.` +
						(kind === "board" && ROUTING_FAILURE.test(String(error)) && owns.includes("outline") ? ` This one is the autorouter running out of room: give it room (a bigger outline, with sizeReason "routing" naming this build) or change what crowds it.` : "") +
						// A capacitor trace past its bound after every layout at this size, the drawn-trace retry included: the board
						// is too tight around that part (real rover run 9 recovered at rev 24 by growing it one step).
						(kind === "board" && /exceeding the [\d.]+mm maximum/i.test(String(error)) && owns.includes("outline") ? ` A capacitor's trace ran past its length bound in every layout at this size: the board is too tight around that part. Grow the outline one step (1–2 mm in its tighter direction), with sizeReason "routing" naming this build.` : ""),
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
- requirements: {summary: string, peripherals: string[], batteryLifeDays: number|null, batteryMah?: number, dutyCycle?: {activeMs, periodS, sleepUa}, size?: {widthMm, heightMm, exact}}
  requirements.size: record a board size the brief or the engineer gives. exact: true only when that very size is needed (an existing housing, a chassis, a mounting pattern, "exactly"); "about", "at most", "fits in a pocket" are a limit (exact false): the board must fit within it and is still compact by default.
- outline: {widthMm, heightMm, thicknessMm, sizeReason?: {kind, detail}}
  Space rules: the board is compact by default, at most 15% over the smallest it can be (the design facts compute it). More than that needs outline.sizeReason, one of: "engineer-size" (the engineer needs that exact size, requirements.size exact true; say where. A size given as "about" or "at most" is a limit, never a reason for extra room), "usability", "standard-fit", "function" (e.g. keeping the sensor away from the MCU and regulator heat), "assembly-test", "expansion", "routing" (a smaller board was built and failed its checks: name the build). The engineer's own words outrank compactness; compactness outranks cost.
- connectors: [{ref, kind: "usb-c"|"header"|"button", edge: "left"|"right"|"top"|"bottom", offsetMm (centre along the edge, from bottom or left), widthMm, heightMm}]
  widthMm and heightMm are the part's own opening seen from that edge, not the case: the USB-C receptacle (TYPE-C-31-M-12) is about 9 × 3.2 mm. The case adds its own clearance, and a cutout too tall runs into the lid.
  The ESP32-C3-MINI-1 module always goes at the edge opposite the USB-C port, its antenna past that edge, and needs about 14 mm of it clear, 12 mm deep: put other connectors on the other edges, or far enough along that one. A connector in its way leaves it no spot at any board size.
- rails: [{name, voltageV, regulatorMaxMa, loadMa (peak), averageMa? (long-run average including sleep, of this rail's OWN loads only: do not include the current of rails it feeds, nor the regulator's quiescent current), averageSource? ("estimated" | "measured") and measuredRevision? (set by the bench when it measured the rail on the real board: keep them as they are)}]
When the brief sets a battery-life target, estimate the duty cycle (requirements.dutyCycle) and each battery-fed rail's averageMa from it, and set batteryMah if the brief does not state the capacity. Battery life is then checked in code: the battery current is the sum of averageMa over every rail except VBUS (they must not overlap), plus each LDO's quiescent current.
The reviewer also gets a second check from the duty cycle alone: each wake lasts activeMs (at least the firmware's 30 ms reading plus 50 ms of BLE advertising; the advertising window is activeMs minus the reading) at the busiest battery-fed rail's loadMa, then sleepUa plus LDO quiescent current for the rest of periodS. State averages consistent with that arithmetic, a loadMa that is the real peak, and an activeMs no longer than the wake needs: a long wake costs battery life directly.
dutyCycle.sleepUa is the whole board asleep, excluding the regulator's quiescent current (counted separately). It can't be below the MCU's deep-sleep floor (catalog sleepUa; ESP32-C3-MINI-1: 5 µA), and a lower figure is raised to that floor.
On a deep-sleeping ESP32-C3 design, GPIO9 is the recovery BOOT pad and GPIO8 must read high at reset for download boot, so the board generator pulls GPIO8 up: don't put an LED (or anything held low at reset) on GPIO8; a button to GND, a UART line or I2C may go there.
The ESP32-C3-MINI-1 has 4 MB on-module flash: if the design keeps a reading history, it goes there (NVS or LittleFS); no external memory part is needed.
The ESP32-C3-MINI-1 needs a supply that can deliver 0.5 A (module datasheet v2.2): its radio bursts are short and high. So its regulator must be rated 500 mA or more: in the catalog RT9080-33GJ5 (600 mA, 2 µA quiescent; same pins as the AP2112K: VIN, GND, EN, NC, VOUT, EN tied to VIN) and AP2112K-3.3TRG1 (600 mA, 55 µA) are; XC6206P332MR-G (200 mA) browns it out, low quiescent current or not. For a battery target prefer the RT9080-33GJ5: the AP2112K's 55 µA alone is half the ~116 µA a 180-day target on 500 mAh allows. Catalog LDOs list their quiescent current as iqUa. A rail's regulatorMaxMa is its regulator's own rating (catalog maxMa); a higher claim is a violation. The 3V3 rail's loadMa must cover the radio's transmit peak: 170 mA for Bluetooth LE at 0 dBm, 350 mA for Wi-Fi (the design facts give it).
- parts: [{ref, role (one of: mcu, sensor, microphone, ldo, charger, battery, usb-c, led, resistor, capacitor, button, connector, motor-driver (a robot's motor driver), stepper-driver (a CNC's stepper driver, the TMC2209-LA: one per stepper motor, cnc.axes' motors), spindle-driver (a CNC spindle's 5 V gate driver, the SN74AHCT1G125DBVR; its pin A on the spindle's PWM GPIO), mosfet (a power switch, the AO4468: a CNC spindle's low-side switch; on a CNC the contract tools wire it), estop-switch (a CNC's emergency-stop power switch, the AO4407A: the drivers' and spindle's supply after the e-stop, VMOT_SW), enable-gate (the SN74LVC1G32DBVR: every stepper driver's ENN from the MCU's STEPPERS_EN on B OR the e-stop's ESTOP_TRIP), limit-switch (an axis limit switch's plug, the S2B-XH-A: SIG to the MCU, NC to GND), current-sense (the spindle's current amplifier, the INA180A1IDBVR: its shunt under the spindle MOSFET's source, @SPINDLE_SHUNT; OUT to an ADC GPIO, SPINDLE_I), can-transceiver (a CAN link's transceiver, SN65HVD230DR: the link check asks for it), usb-uart and auto-reset (the CH340C USB-UART bridge and the UMH3N auto-reset pair for an MCU with no native USB that flashes over UART, the ESP32-WROOM-32E: the tools add them when the board has a USB-C and drop them for a native-USB MCU; keep them), imu (a robot's IMU, the LSM6DS3TR-C: the tools add it to every robot's parts and the board generator wires it; keep it), diode, ideal-diode, buck (a robot's power tree: Schottky diodes, the LM66100 ideal diode and the step-down from the pack; the tools add and drop them from the pack and the LDO's rating, keep what they set), pwm-driver (the PCA9685 driving servos and a spare motor on the I2C bus), servo-supply (the servos' 5 V step-down module), servo (a servo's 3-pin plug), estop (a robot's emergency stop plug, the JST XH B2B-XH-A(LF)(SN) with pins ["VBAT", "VM"]: the board generator puts the button's contact between the cell and the motor driver's VM; only when mechanics.safety.estop names it), start (a robot's pull-cord start plug, the 2-pin header PZ254V-11-02P with pins ["START", "GND"]: assign the signal START to a free GPIO with partRef the plug and partPin START; only when mechanics.safety.start names it), other), mpn, lcsc, footprint, pins: string[], reason: one line on why this part, quoting the brief line or naming the need it serves (the engineer reads it when they click the part), at?: {xMm, yMm} (only where the engineer placed it on the board page: the part's centre in mm from the board's bottom-left corner; keep it exactly as it is, and set it when a change request places a part), nets?: { pin: rail } (only for supply pins whose label doesn't name their rail: a numbered header's or a power input's, e.g. { "2": "5V", "4": "5V", "6": "GND" }; pins labelled GND/VSS or 3V3/VDD/VCC are wired by their label, and a rail no pin reaches is a rail-unwired violation)}]
- pins: [{signal (UPPER_SNAKE), gpio: number, partRef, partPin}]. gpio is the MCU's pin index as its profile defines it (the design facts' MCU section lists every usable pin as NAME=index: GPIO4=4 on an ESP32, PB7=23 on an STM32). partRef and partPin are the other end: the part and pin the MCU pin drives or reads (U2 SDA, U5 AIN1, a connector's IO1), never the MCU itself, or the net has one end and the board can't be built. A signal that goes off the board (a sensor on a cable) ends on its connector's pin.
- search_parts stock: a number is live from LCSC; stock null means unknown, not out of stock.
- links (when the board is part of a system of boards) is the integrator's: you don't write it, you follow it. For each link, list its connector in connectors (kind "header", on the link's edge if it names one, about 5.8 × 3 mm), and for a UART link assign <id>_TX and <id>_RX to the connector's IO pins the design facts give, on free GPIOs. An I2C link uses the board's own I2C_SDA/I2C_SCL.
- motion (the architect's, only for a robot: a device that moves on its own, on wheels): the brief's targets, {speedMps, runtimeMin, edgeMm (the highest step or edge it must roll over), maxSlopeDeg, stopBeforeWallMm (how far short of an obstacle it stops; 0 if none), payloadG (what it carries besides itself), maxSizeMm: [length, width] (with wheels), maxMassG, rules? ("eurobot-2026" when the brief is for Eurobot: the design is then checked against that competition's robot rules, catalog/rules)}, from the brief's numbers. A target the brief doesn't state is an assumption: take the gentlest one that still serves the brief (an indoor floor or a competition table has no edge to climb unless the brief names one: edgeMm 0; payloadG only what the brief names; speedMps 0.3 unless the brief asks for speed), say in your reason which targets are assumed, and approve the mechanics engineer's proposal to ease an assumed target when no catalog layout meets it. Writing it makes the design a robot: the mechanics engineer then designs the drive, battery, distance sensor and chassis (its field, mechanics), and the robot's checks ask for the motor driver (role motor-driver, its four inputs on GPIOs named MOT_AIN1, MOT_AIN2, MOT_BIN1, MOT_BIN2, with partRef the driver), one plug per motor, JM1 and JM2 (the 2-pin JST PH, or, when the motor carries an encoder, the 6-pin JST SH SM06B-SRSS-TB(LF)(SN) with pins GND, ENCB, ENCA, VCC, M2, M1: one plug for the motor and its encoder, never a separate encoder plug; the board generator wires the driver's outputs to M1/M2 or 1/2, so those take no pins, and an encoder's channel A goes on a GPIO as ENC_LA → JM1.ENCA and ENC_RA → JM2.ENCA), the distance sensor's 4-pin connector (no pins of its own: the generator joins its IO1/IO2 to the board's I2C bus; put I2C_SDA/I2C_SCL on the board's own I2C part, e.g. U2 SDA/SCL, or, when the plug is the board's only I2C device, on the plug itself as I2C_SDA → its IO1 and I2C_SCL → its IO2) and the robot's firmware; the chassis is its body, so requirements.enclosure is "none" unless the brief also asks for a case. A board that doesn't move gets no motion field.
- armTargets (the architect's, only for a robot arm: a brief for an arm that picks and places from a fixed base; such a design gets no motion field, which is a wheeled robot's): ${ARM_TARGETS_SHAPE}. Copy the brief's reach, payload, object mass and repeats; the brief gives how far the drop (a cup) is from the pick point, not where they stand: put both on the table inside the workspace, each about 0.7 of the reach out from the base axis, either side of +x, so they are the brief's distance apart. Writing it makes the design an arm: the mechanics engineer then designs the joints, servos, links, base and supply (its field, arm), and the parts follow: a PCA9685 (role pwm-driver) on the I2C bus drives the servos, and the contract tools add one plug per servo, the servo rails and the brick's input jack with each parts write. The arm's body is printed, so requirements.enclosure is "none" unless the brief asks for a case.
- cncTargets (the architect's, only for a machine tool: a CNC router, engraver or plotter on stepper motors, instead of motion): ${CNC_TARGETS_SHAPE}, from the brief's numbers; a target the brief doesn't state is an assumption, said so in your reason. Writing it makes the design a CNC: the mechanics engineer then designs its axes, spindle and homing (cnc), and the cnc-* checks ask the board for one stepper driver per motor. On a CNC the contract tools wire the nets every CNC board shares, with each parts, pins, rails or cnc write: the brick's jack on the motor rail, each stepper plug (B4B-XH-A) on the next driver's outputs in axis order, the spindle's MOSFET and screw terminal, the e-stop plug's loop, and the drivers' UART TX resistor (the part STEPPER_UART_TX ends on) onto the line. Write those parts without nets; a net you write stays as you wrote it. A CNC's pins use the firmware's signal names (grblHAL's map and FluidNC's config are written from them): <MOTOR>_STEP and <MOTOR>_DIR per motor of cnc (X, Y, Z; a ganged axis's motors Y1 and Y2) on its driver's STEP and DIR, STEPPERS_EN on the enable gate's B, ESTOP_TRIP on its A, LIMIT_X, LIMIT_Y and LIMIT_Z on the limit plugs' SIG, SPINDLE_PWM on the spindle driver's A, SPINDLE_I on the current amplifier's OUT (an ADC pin), STEPPER_UART (the MCU's RX) on the first driver's PDN_UART, and STEPPER_UART_TX on pin1 of a 1 kΩ resistor whose pin2 is on @STEPPER_UART, never straight onto the line.
- requirements.enclosure (optional): who houses the board. "case" when the brief asks for a case or a finished device in one: Bringup designs and prints it. Leave it out only when the brief doesn't say (Bringup then designs a case and tells the engineer it assumed one). "none" when the brief or the engineer wants a bare board (lab use, a dev kit, a test rig, "no case"); "own" when it goes into the engineer's own housing or an existing product (Bringup then writes the board's mechanical interface instead of a case). With a case, every button needs an opening: list it in connectors (kind "button", on the edge it is pressed from), or leave it out.
- requirements.usbWake (optional, true or false): leave it out. A deep-sleeping board then wakes when USB is plugged in and stays awake while it is, so a USB-C cable alone reflashes it; the board generator adds a VBUS-sense divider on the first free pin of GPIO0, 1, 3, 4, 5, so keep one of those free. Set it to false only when the engineer asks; then reflashing needs the case open and the bottom recovery pads.
- requirements.testPads (optional, true or false): leave it out. The board generator then puts a few bring-up test pads on the underside (ground, the rails, a debug UART, a cable link's signals) where there is room; they never grow the board. Set it to false only when the engineer asks for no test pads.
- requirements.debugPort (optional, false only): leave it out. The board then gets its debug footprint (a programming and debug header through the board); set it to false only when the engineer asks for a board without it.
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
						// A continued design (bringup continue) starts with its contract: every message is then a change request.
						if (!briefSeen && state().contract.revision === 0) {
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
				specification: when(({ event }) => isEvent(event, "consistency.checked") && !event.payload.draining && event.payload.violations.some((v) => recipients(v).includes("architect"))),
				processor: {
					apply: ({ event, participant }) => {
						if (!isEvent(event, "consistency.checked")) return
						const mine = event.payload.violations.filter((v) => recipients(v).includes("architect"))
						requestTurn(participant as Agent, `violations@${event.payload.revision}:${mine.map((v) => v.kind).join(",")}`, `Consistency violations for you at revision ${event.payload.revision}:\n${mine.map((v) => `- ${v.kind}: ${v.message}`).join("\n")}\nFix them by changing the fields you own.`, { kind: "violation", revision: event.payload.revision, items: mine.map((v) => ({ kind: v.kind, message: v.message })) }, () => (latestCheck()?.violations ?? []).some((v) => v.affects.includes("architect")))
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
		description: "Rank every MCU Bringup knows (any vendor) for this design on the same terms: whether its pins and peripherals fit the needs (pin solver), whether it has the radio, whether Bringup can build its board, then sleep current (battery), price, stock and simulator; motion requires a chip that runs CNC motion firmware. Each result lists why, with numbers.",
		parameters: {
			type: "object",
			properties: {
				needs: { type: "array", items: { type: "object", properties: { signal: { type: "string" }, kind: { type: "string", enum: ["gpio", "adc", "wake", "uart", "i2c", "spi", "i2s", "usb", "can"] }, role: { type: "string" }, group: { type: "string" } }, required: ["signal", "kind"] } },
				radio: { type: "array", items: { type: "string", enum: ["ble", "wifi"] } },
				battery: { type: "boolean" },
				motion: { type: "string", enum: ["any", "grblhal", "fluidnc"], description: "only for a CNC/motion controller: the chip must run grblHAL or FluidNC (any), or that one" },
			},
			required: ["needs"],
		},
		strict: false,
		invoke: async ({ motion, ...req }: Omit<McuRequest, "motion"> & { motion?: "any" | "grblhal" | "fluidnc" }) => rankMcus({ ...req, ...(motion ? { motion: motion === "any" ? true : motion } : {}) }),
	}
}

// The chassis layout solver (src/mechanics/solve.ts): the mechanics engineer picks the parts, code finds the plate,
// track, axle, wheelbase and battery spot that pass the robot's checks (real rover run 3, 15 Nov: packing by hand
// never converged).
function layoutChassisTool(): Tool {
	return {
		type: "function",
		name: "layout_chassis",
		description: "Lay out the robot's chassis for the parts you pick: searches the plate size (within the brief's maxSizeMm, or the system's plate), the track, the axle and caster position, the battery's spot and the sensor's, and returns a complete mechanics field that passes every chassis check (fit, level, tipping, climb, torque, speed, stopping, current, runtime). Propose the returned mechanics as it is. If no layout passes, it says which checks fail with these parts: pick others and call it again.",
		parameters: {
			type: "object",
			properties: {
				motor: { type: "string", description: "a motor from the design facts' Motors list (its part number is enough)" },
				wheel: { type: "string" },
				caster: { type: "string" },
				pack: { type: "string", description: "the battery pack" },
				sensor: { type: "string", description: "the distance sensor module" },
				connector: { type: "string", description: "the board connector (role connector, JST SH 4-pin) the sensor's cable plugs into, e.g. JT1" },
			},
			required: ["motor", "wheel", "caster", "pack", "sensor", "connector"],
		},
		strict: false,
		invoke: async (choice: ChassisChoice) => {
			const cat = defaultCheckCatalog()
			if (!cat) return { error: "no mechanics catalog on this machine" }
			const r = solveWithMotorClass(state().contract.snapshot(), choice, cat)
			return { passes: r.mechanics !== null && r.remaining.length === 0, mechanics: r.mechanics, why: r.motorNote ? `${r.why}; ${r.motorNote}` : r.why }
		},
	}
}

// Consistency violations addressed to a role wake it once per revision, with what to do about them.
// only: which of the role's violations it can act on (the case designer shares the "enclosure" role with the case
// builder, whose cutout and vent violations a rebuild fixes).
function violationsFor(role: AgentRole, guidance: string): SituationHandler {
	const ours = (v: { affects: AgentRole[]; fields: FieldName[] }) => recipients(v).includes(role)
	return {
		specification: when(({ event }) => isEvent(event, "consistency.checked") && !event.payload.draining && event.payload.violations.some(ours)),
		processor: {
			apply: ({ event, participant }) => {
				if (!isEvent(event, "consistency.checked")) return
				const mine = event.payload.violations.filter(ours)
				requestTurn(participant as Agent, `${role}-violations@${event.payload.revision}:${mine.map((v) => v.kind).join(",")}`, `Consistency violations for you at revision ${event.payload.revision}:\n${mine.map((v) => `- ${v.kind}: ${v.message}`).join("\n")}\n${guidance}`, { kind: "violation", revision: event.payload.revision, items: mine.map((v) => ({ kind: v.kind, message: v.message })) }, () => (latestCheck()?.violations ?? []).some(ours))
			},
		},
	}
}

// Which change requests a feature role hears (domain isolation, 14 Nov 2026): a role whose field the design doesn't
// have yet hears only requests in its own words, so "make it 40 mm wide" on a plain board costs the ML, test and
// mechanics agents no model turn. The mechanics agent hears requests only on a robot (motion or mechanics set): the
// architect writes motion when the engineer asks for one, and the missing mechanics design then wakes it.
export const REQUEST_WORDS: Partial<Record<AgentRole, RegExp>> = {
	ml: /wake[- ]?word|keyword|voice|speech|spoken|gesture|sound|audio|noise|bark|image|camera|vision|classif|recogni|detect|machine learning|\bml\b|\bai\b|model|neural|tinyml|on-device|intelligen|train|recorded/i,
	test: /test|fixture|bed of nails|pogo|probe|factory|production|end[- ]of[- ]line|\bpads?\b|\beol\b/i,
}
export function hearsRequest(role: AgentRole, has: (field: FieldName) => boolean, message: string): boolean {
	if (role === "mechanics") return has("motion") || has("mechanics") || has("armTargets") || has("arm") || has("cncTargets") || has("cnc")
	const field = role === "ml" ? "model" : role === "test" ? "test" : null
	if (!field) return true
	return has(field) || (REQUEST_WORDS[role]?.test(message) ?? true)
}

// The engineer's messages after the brief are change requests: each one starts a turn with the role's guidance. The
// first message is the brief, which reaches the agents another way.
function engineerRequests(guidance: string, role?: AgentRole): SituationHandler {
	let briefSeen = false
	return {
		specification: when(({ event }) => isEvent(event, "message.sent" as never) && state().getParticipant(event.producerId)?.getManifest().name === "engineer"),
		processor: {
			apply: ({ event, participant }) => {
				if (!briefSeen && state().contract.revision === 0) {
					briefSeen = true
					return
				}
				const message = (event.payload as { message: string }).message
				if (role && !hearsRequest(role, (f) => state().contract.version(f) > 0, message)) return
				startTurn(participant as Agent, `${ENGINEER_REQUEST_PREFIX}\n${message}\n${guidance}`, requestCause(message))
			},
		},
	}
}

export function createPartsAgent(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "parts",
		mock: opts.mock,
		instruction: `You select the parts for a hardware design. Use search_parts for every role the requirements and rails need, and choose only those: no part for something the brief puts out of scope (no sensor when the brief rules sensors out). A robot (the contract has a motion field) also needs what its checks ask for, even when requirements.peripherals don't list them: the motor driver (role motor-driver), one plug per motor as JM1 and JM2 (the 2-pin JST PH, or the 6-pin JST SH SM06B-SRSS-TB(LF)(SN) when the motor carries an encoder: one plug for motor and encoder, never a separate encoder plug), the battery connector, and the distance sensor's 4-pin connector under the ref mechanics.sensor.connector names. Keep them once added; a robot check that asks for one is never extraneous. A robot arm (the contract has armTargets or arm) needs the PCA9685 (role pwm-driver) on the I2C bus and no motor driver: the contract tools add the servo plugs, the servo rails' chips and the brick's input jack for the arm with each parts write, so keep them. Prefer in-stock parts, and write the complete parts list with one propose_contract_change. Keep the reference designators below. You own the parts list: when another discipline asks to change it, decide with decide_change.\n${CONTRACT_SHAPES}`,
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
				specification: when(({ event }) => isEvent(event, "consistency.checked") && !event.payload.draining && event.payload.violations.some((v) => recipients(v).includes("firmware"))),
				processor: {
					apply: ({ event, participant }) => {
						if (!isEvent(event, "consistency.checked")) return
						const mine = event.payload.violations.filter((v) => recipients(v).includes("firmware"))
						requestTurn(participant as Agent, `fw-violations@${event.payload.revision}`, `Firmware violations at revision ${event.payload.revision}:\n${mine.map((v) => `- ${v.kind}: ${v.message}`).join("\n")}`, { kind: "violation", revision: event.payload.revision, items: mine.map((v) => ({ kind: v.kind, message: v.message })) }, () => (latestCheck()?.violations ?? []).some((v) => v.affects.includes("firmware")))
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
				"If it asks for on-device intelligence (a wake word, voice commands, a gesture, sound or image recognition), meet it by writing the model field you own: call read_contract, then propose_contract_change with its current baseVersion. If it says the training data has been recorded, set the model's data to status \"recorded\" on the sensor path in the design facts. Otherwise change nothing.", "ml"),
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
				"If it asks for a production or factory test, a test fixture, a bed of nails or test pads, meet it by writing the test field you own: call read_contract, then propose_contract_change with its current baseVersion, probing every signal and power net, with limits from the design facts plus margin. Otherwise change nothing.", "test"),
			violationsFor("test", "Fix them by changing the test field you own (add or drop points, raise a limit to the design's own current plus margin), with propose_contract_change and its current baseVersion."),
		],
	})
}

export const CASE_DESIGN = `${CASE_SHAPE}.
- Frame: the board's bottom-left corner is the origin; a hole's offsetMm runs along its edge like a connector's (from the bottom on left/right, from the left on top/bottom), and the wall extends 2 mm past the board at each end.
- The case's outer size is the board outline plus 2 × (2 mm clearance + wallMm) each way, and it follows the board: you don't set it directly. A case that must be a given outer size needs a different board outline (the architect's field): propose the outline that gives it. That changes the PCB, so it also waits for the engineer's confirmation; if it is rejected, keep the board and say so.
- Code checks the case field: the body tall enough for the connectors' cutouts under the lid's 3 mm lip, a hole that fits its wall's free height and keeps 1.2 mm of wall from every cutout and other hole, tabs that fit their wall and don't overlap. The design facts give the numbers (outer size, the lowest body, the largest hole). Fix your own field first: move a hole along its wall or to another wall, make the body taller. Ask to move a connector (the architect's connectors field, a PCB change the engineer must confirm) only when the engineer wants the hole exactly there.
- Space rules: the body is at most 15% taller than its contents need (the design facts give it); taller needs case.sizeReason ("engineer-size" when the engineer asked for it, or another listed reason).
- A request may start with the feature the engineer clicked on the case, in brackets: [case#feature:<id>: …], [case#cutout:<ref>: …], [case#wall:<edge>: …], [case#lid: …], [case#floor: …] or [case#standoff:<ref>: …]. The request is about that one: a case#feature id is the case.features entry to change (keep its id); a wall, the lid or the floor says where a new feature goes; a cutout or a standoff follows the board (its connector or mounting hole), so moving or resizing one is the architect's board change, which you propose.`

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
Pick motors, wheels, casters, packs and sensor modules only from catalog/mechanics.json (every number there has a datasheet behind it).
- A request may start with the printed part the engineer clicked on the robot, in brackets: [chassis#standoff:<board>:<n>: …], [chassis#motor-mount:<side>: …], [chassis#caster-mount: …], [chassis#battery-rails: …], [chassis#strap-boss:<n>: …], [chassis#sensor-bracket: …], [chassis#estop-deck: …], [chassis#mast-socket: …], [chassis#sticker-panel: …] or [chassis#plate: …]. The request is about that part, which the chassis builds from your mechanics field: change the field that places it (a board's place, the battery's, the sensor's, the plate's size, the drive's axle or wheelbase), then lay out again with layout_chassis if the checks fail.`

// A robot arm (src/arm/): the mechanics engineer owns the arm field instead of mechanics, and designs to src/arm/checks.ts
// and the arm's power checks (src/contract/power-auto.ts armPowerChecks).
export const ARM_RULES = `A robot arm (the contract has armTargets, the architect's, and no motion): you own the arm field, not mechanics. Pick each joint's servo from the catalog with list_servos, set the link lengths so the links reach armTargets.reachMm from the shoulder axis to the grip point, and write the arm with propose_contract_change.
${ARM_SHAPE}
The checks your arm must pass (src/arm/checks.ts, src/contract/power-auto.ts):
- torque: with the arm stretched level at full reach and armTargets.payloadG in the gripper, each joint's static gravity torque ≤ ${est("ARM_TORQUE_SHARE") * 100}% of its servo's stall torque at railV (an estimate the message names); the violation names the weakest catalog servo that carries it;
- reach: the links' sum ≥ armTargets.reachMm, and the pick and drop points solve with the gripper pointing down, also ${ARM_APPROACH_MM} mm above each (the firmware comes down from there), within every joint's minDeg..maxDeg;
- tipping: with the payload at full reach in any direction, the whole arm's centre of mass stays ${ARM_TIP_MARGIN_MM} mm inside the base plate (holdDown "mass": grow the plate or add ballastG), or holdDown "clamps";
- supply: every servo rated for railV (hobby servos 4.8-6 V: railV 6); the servos at stall split across rails that each fit one servo-supply chip; the brick (input volts and amps) covers the rails at stall plus the logic with headroom, and its jack carries its current.`

// The catalog's servos for an arm, with their numbers at a rail voltage (servoAt), and the arm's worst-pose torques per
// joint when the contract has one: what the mechanics engineer picks from.
function listServosTool(): Tool {
	return {
		type: "function",
		name: "list_servos",
		description: "List the catalog's servos (catalog/mechanics.json, every number cited): control (pwm or ttl-bus), rated voltage range, stall torque, stall current and speed at the given rail voltage, what the torque check lets it carry, rotation range, mass and body size. With an arm in the contract, also each joint's worst-pose torque against what its servo may carry.",
		parameters: { type: "object", properties: { railV: { type: "number", description: "the servos' rail voltage (6 for hobby servos)" } }, required: ["railV"] },
		strict: false,
		invoke: async ({ railV }: { railV: number }) => listServos(railV),
	}
}
const r3 = (n: number) => Math.round(n * 1000) / 1000
export function listServos(railV: number) {
	const cat = defaultCheckCatalog()
	if (!cat) return { error: "no mechanics catalog on this machine" }
	const servos = (cat.mech.servos ?? []).map((p) => {
		const at = servoAt(p, railV)
		return { mpn: p.mpn, control: p.control, ratedV: [p.minV, p.maxV], ...("error" in at ? { atRail: at.error } : { stallNm: r3(at.stallNm), stallA: at.stallA, degPerS: Math.round(at.degPerS), mayCarryNm: r3(est("ARM_TORQUE_SHARE") * at.stallNm) }), rangeDeg: p.rangeDeg, massG: p.massG, bodyMm: p.bodyMm, ...(p.estimates?.length ? { estimates: p.estimates } : {}) }
	})
	const s = state().contract.snapshot()
	const torques = s.values.arm && s.values.armTargets ? worstTorques(s.values.arm, s.values.armTargets, cat.mech).map((w) => ({ joint: w.joint, nm: r3(w.nm), mayCarryNm: r3(w.allowNm) })) : undefined
	return { servos, ...(torques ? { torques } : {}) }
}

export function createMechanicsAgent(opts: { mock: boolean }): Agent {
	return createRoleAgent({
		role: "mechanics",
		name: "mechanics",
		mock: opts.mock,
		instruction: `You are the mechanics engineer of a small robot: you own the mechanics field (drive, battery, sensor mount and chassis layout). Pick the parts (motor, wheels, caster, battery pack, distance sensor and the board connector its cable plugs into), call layout_chassis with them, and propose the mechanics it returns as it is: the layout is a search the code does, so don't place parts by hand. If no layout passes, it says which checks fail: pick other parts and call it again. The architect owns motion (the brief's targets) and the boards. When no catalog parts pass and the cause is a motion target the brief itself doesn't state (an edge, a payload, a speed or a runtime the architect assumed), don't wait for a decision: propose the motion change yourself with propose_contract_change (it waits for the architect's approval), setting the assumed target to the strictest value a layout_chassis call you made does pass, and give those numbers in the reason (rover run cc-eurobot-12, 16 Nov 2026: 79 layouts failed against an assumed 5 mm edge and 500 g payload, and the run ended asking for a decision nobody took). Lay out the chassis in millimetres with the origin at the plate's centre and +x forward, and propose it with propose_contract_change. When another discipline proposes a change to mechanics, decide with decide_change. When the contract has an assembly field, the plate size and where each board sits come from the system's assembly; keep chassis.plateMm and chassis.boards as they are and design the drive, battery, sensor, clearance and thickness. The design facts list the catalog's motors, wheels, casters, packs and sensor modules with their numbers. When the drive needs a belt, gears, bearings, a coupler or a lead screw, list them in mechanics.driveTrain, each bought part by its catalog/mechanics.json driveTrain mpn with the catalog's own numbers (pitch, teeth, bore…); the mech-mate checks then say whether each fits what it mates with. A CNC (the contract has cncTargets: a router, engraver or plotter on stepper motors) is not a rover: design its cnc field instead of mechanics, three axes x, y, z each with a catalog stepper, lead screw (each its travel plus about 40 mm for the nut and bearings), rail, travel, homing end and driver current (at most the motor's rating and the TMC2209's 1.4 A), the spindle, the emergency stop, the 24 V brick and the frame; the cnc-* checks then say what falls short.\n${CNC_SHAPE}\n${MECHANICS_SHAPE}\n${MECHANICS_RULES}\n${ARM_RULES}\n${CONTRACT_SHAPES}`,
		tools: [layoutChassisTool(), listServosTool()],
		handlers: [
			ownerReviewsChanges("mechanics"),
			ownerFixesReview("mechanics"),
			engineerRequests("If it is about the robot's body (its size, wheels, motors, battery, where things sit, how fast it drives; on an arm its reach, links, servos, base or supply), meet it: call read_contract, then propose_contract_change on the mechanics field (the arm field on an arm) with its current baseVersion, keeping everything the request does not mention, so every check above still passes. Otherwise change nothing.", "mechanics"),
			violationsFor("mechanics", "Fix them by changing the mechanics field you own (other parts, a longer wheelbase, the battery moved back, a wider plate), with propose_contract_change and its current baseVersion. On an arm, change the arm field (another servo, other link lengths, a bigger plate or more ballast, a bigger brick)."),
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
			violationsFor("enclosure", "Fix them by changing the case field you own (move or resize a hole, a taller or lower body, tabs on other walls, or a sizeReason when the room is wanted), with propose_contract_change and its current baseVersion."),
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
