import type { Part, PinAssignment as Pin } from "../contract/types.ts"
import { byMpn, type BatteryPack, type MechCatalog, type MotorPart, type SafetyPart } from "./catalog.ts"
import type { Mechanics } from "./types.ts"

// A robot's emergency stop (catalog/mechanics.json safety, kind "estop"): a red mushroom button whose NC contact sits
// in the motors' supply, through the board's e-stop plug (role estop: VBAT in, the driver's VM out). Eurobot General
// Rules 1.2 F.4.c asks for a red button at least 20 mm across that stops the robot at once; the rule check
// (rules/eurobot.ts) adds those limits. These checks hold for any robot that has one.

export const ESTOP_CLEARANCE_MM = 2 // ESTIMATE: air between the button's body and the plate below it

export interface SafetyFinding {
	message: string
	affects: ("mechanics" | "parts" | "architect")[]
}
export interface SafetyFigure {
	check: string
	value: string
	limit: string
	ok: boolean
	note?: string
}

// The motors' current through the e-stop's contact at the worst case: both motors stalled at the pack's full voltage
// (stall current scales with voltage on a DC motor).
export const motorsStallA = (motor: MotorPart, pack: BatteryPack) => 2 * motor.stallA * (pack.fullV / motor.ratedV)

export function estopPart(cat: MechCatalog, mpn: string): SafetyPart | undefined {
	const p = byMpn(cat.safety ?? [], mpn)
	return p?.kind === "estop" ? p : undefined
}

// A pull-cord start (match.h in the rover firmware): the board plug (role start) and its START pin on a GPIO.
export function startChecks(mech: Mechanics, parts: Part[], pins: Pin[]): SafetyFinding[] {
	const s = mech.safety?.start
	if (!s) return []
	const plug = parts.find((p) => p.ref === s.connector)
	if (!plug) return [{ message: `the start cord needs a 2-pin plug ${s.connector} (role start, the header PZ254V-11-02P in the catalog, pins ["START", "GND"]) on the board with the MCU: add it`, affects: ["parts"] }]
	if (plug.role !== "start") return [{ message: `mechanics.safety.start.connector is ${plug.ref}, but ${plug.ref} is the ${plug.role} ${plug.mpn}: name a free ref for the start plug (JS1)`, affects: ["mechanics"] }]
	const pin = pins.find((p) => p.partRef === plug.ref && p.partPin === "START")
	if (!pin || typeof pin.gpio !== "number" || pin.gpio < 0) return [{ message: `the start plug ${plug.ref}'s START pin has no GPIO: assign the signal START to a free GPIO (partRef ${plug.ref}, partPin START); the firmware waits on it and the board generator pulls it up`, affects: ["architect"] }]
	if (pin.signal !== "START") return [{ message: `the start plug's pin is on signal ${pin.signal}: name it START, the signal the rover firmware waits on`, affects: ["architect"] }]
	return []
}

export function safetyChecks(mech: Mechanics, parts: Part[], motor: MotorPart, pack: BatteryPack, cat: MechCatalog, figures: SafetyFigure[] = []): SafetyFinding[] {
	const e = mech.safety?.estop
	if (!e) return []
	const out: SafetyFinding[] = []
	const button = estopPart(cat, e.part)
	if (!button) {
		const listed = (cat.safety ?? []).filter((p) => p.kind === "estop").map((p) => p.mpn)
		return [{ message: `emergency stop ${e.part} is not in catalog/mechanics.json safety: pick one listed there (${listed.join(", ") || "none listed"})`, affects: ["mechanics"] }]
	}
	// The contact breaks the motors' current, an inductive load: its DC13 rating, at a voltage it is rated for.
	const amps = motorsStallA(motor, pack)
	figures.push({ check: "E-stop breaking current", value: `${amps.toFixed(2)} A`, limit: `at most ${button.dcInductiveA} A (DC13, inductive, at ${button.ratedDcV} V)`, ok: amps <= button.dcInductiveA, note: `both ${motor.mpn.split(" ")[0]} stalled at the pack's ${pack.fullV} V` })
	if (amps > button.dcInductiveA)
		out.push({ message: `the emergency stop ${button.mpn.split(" ")[0]} breaks at most ${button.dcInductiveA} A of motor (inductive) current at ${button.ratedDcV} V DC; both motors stalled at the pack's ${pack.fullV} V draw ${amps.toFixed(2)} A: pick motors with a lower stall current, or a button rated for it`, affects: ["mechanics"] })
	if (pack.fullV > button.ratedDcV)
		out.push({ message: `the emergency stop ${button.mpn.split(" ")[0]} is rated to ${button.ratedDcV} V DC, under the pack's ${pack.fullV} V full charge: pick a lower-voltage pack or a button rated for it`, affects: ["mechanics"] })
	// Its plug on a board, in the motors' supply.
	const plug = parts.find((p) => p.ref === e.connector)
	if (!plug) out.push({ message: `the emergency stop's wires need a 2-pin plug ${e.connector} (role estop, the JST XH B2B-XH-A(LF)(SN) in the catalog, pins ["VBAT", "VM"]) on the board with the motor driver: add it; the board generator puts it between the cell and the driver's VM`, affects: ["parts"] })
	else if (plug.role !== "estop") out.push({ message: `mechanics.safety.estop.connector is ${plug.ref}, but ${plug.ref} is the ${plug.role} ${plug.mpn}: name a free ref for the emergency stop's plug (JE1)`, affects: ["mechanics"] })
	// Its mount: the button stands through a panel (a printed deck) whose top is zMm off the floor. Its body hangs
	// belowMm under the panel and must clear the plate; the head must stand over the plate.
	const c = mech.chassis
	const plateTop = c.clearanceMm + c.thicknessMm
	const bodyBottom = e.at.zMm - button.belowMm
	if (bodyBottom < plateTop + ESTOP_CLEARANCE_MM)
		out.push({ message: `the emergency stop's body hangs ${button.belowMm} mm under its panel, so a panel at ${e.at.zMm} mm reaches down to ${Math.round(bodyBottom * 10) / 10} mm, into the plate (its top at ${plateTop} mm): raise mechanics.safety.estop.at.zMm to at least ${Math.ceil(plateTop + ESTOP_CLEARANCE_MM + button.belowMm)} mm`, affects: ["mechanics"] })
	const [L, W] = c.plateMm
	const r = button.headMm / 2
	if (Math.abs(e.at.xMm) + r > L / 2 || Math.abs(e.at.yMm) + r > W / 2)
		out.push({ message: `the emergency stop's ${button.headMm} mm head at (${e.at.xMm}, ${e.at.yMm}) overhangs the ${L} × ${W} mm plate: keep its centre within x ±${L / 2 - r}, y ±${W / 2 - r} mm`, affects: ["mechanics"] })
	return out
}

// The top of the emergency stop's head off the floor, or null with no e-stop (or one not in the catalog).
export function estopTopMm(mech: Mechanics, cat: MechCatalog): number | null {
	const e = mech.safety?.estop
	const button = e ? estopPart(cat, e.part) : undefined
	return e && button ? Math.round((e.at.zMm + button.aboveMm) * 10) / 10 : null
}
