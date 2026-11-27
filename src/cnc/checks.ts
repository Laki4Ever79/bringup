import type { ContractValues } from "../contract/types.ts"
import type { MechCatalog, StepperPart } from "../mechanics/catalog.ts"
import type { MechViolation } from "../mechanics/checks.ts"
import { CNC_AXES, type CncAxis } from "./types.ts"
import { estopChecks, spindleSenseChecks } from "./estop.ts"
import { grblhalPins } from "./grblhal.ts"

// The stepper driver's continuous RMS current per coil: the board's stepper-driver part's, from catalog/parts.json (the
// TMC2209-LA: 1.4 A, its datasheet's design guideline), or that chip's when the board has none yet.
export function driverRmsA(values: Partial<ContractValues>, cat?: { boardParts?: unknown } | null): { mpn: string; contA: number } | null {
	const catalog = (cat?.boardParts ?? []) as { role?: string; mpn?: string; contA?: number }[]
	const placed = (values.parts ?? []).find((p) => p.role === "stepper-driver")
	const part = catalog.find((p) => p.role === "stepper-driver" && (placed ? p.mpn === placed.mpn : p.mpn === "TMC2209-LA"))
	return part?.mpn && part.contA ? { mpn: part.mpn, contA: part.contA } : null
}
// Estimates, each a round number for a hobby machine until a measurement replaces it:
// wood's specific cutting force (N/mm² of chip section), plywood at hobby feeds;
export const CUT_KC_N_MM2 = 50
// a T8 multi-start screw in a bronze nut, its efficiency;
export const SCREW_EFF = 0.3
// the mass each axis moves (the gantry with the spindle on X/Y, the spindle carriage on Z), kg, and the acceleration;
export const MOVING_KG: Record<CncAxis["name"], number> = { x: 1.5, y: 3, z: 1 }
export const ACCEL_MM_S2 = 500
// the torque margin over that load at the rapid speed;
export const TORQUE_MARGIN = 2
// the screw beyond the travel: the nut's length and the two bearing ends;
export const SCREW_SPARE_MM = 40
// a flute count and the logic's draw (MCU, drivers' logic, fan);
export const FLUTES = 2
export const CNC_LOGIC_W = 5
// and the supply's headroom over everything at once (the arm's SUPPLY_HEADROOM, src/contract/power-auto.ts).
export const CNC_SUPPLY_HEADROOM = 1.25

// The pull-out torque at a speed, linear between the curve's points (flat before the first, 0 past the last).
export function pulloutAt(m: StepperPart, rpm: number): number {
	const c = m.pulloutNm
	if (rpm <= c[0].rpm) return c[0].nm
	for (let i = 1; i < c.length; i++) if (rpm <= c[i].rpm) return c[i - 1].nm + ((c[i].nm - c[i - 1].nm) * (rpm - c[i - 1].rpm)) / (c[i].rpm - c[i - 1].rpm)
	return 0
}

// A CNC's own checks (docs/cnc.md gap 9), run instead of the rover's (src/mechanics/checks.ts): the machine against the
// brief's work area, footprint and spindle; with the catalog, each axis's parts, driver current, step size and torque at
// the rapid speed, and the brick's budget.
export function cncChecks(values: Partial<ContractValues>, cat?: { mech: MechCatalog; boardParts?: unknown } | null): MechViolation[] {
	const m = values.cnc, t = values.cncTargets
	// The brief's targets with no machine yet: the mechanics engineer's turn (the arm's and rover's checks do the same).
	if (!m) return t ? [{ kind: "cnc-fit", message: "the CNC has its targets (cncTargets) but no machine: write cnc, three axes (x, y, z) with their stepper, lead screw, rail, travel, homing end and driver settings, the spindle, the emergency stop, the 24 V brick and the frame, from catalog/mechanics.json (steppers, driveTrain lead screws, rails, spindles, safety)", fields: ["cnc"], affects: ["mechanics"] }] : []
	const out: MechViolation[] = []
	const push = (kind: MechViolation["kind"], message: string, architect = false) => out.push({ kind, message, fields: architect ? ["cnc", "cncTargets"] : ["cnc"], affects: architect ? ["mechanics", "architect"] : ["mechanics"] })
	// The board drives the machine: one stepper driver per motor (a gantry axis's two motors, two drivers).
	const motors = m.axes.reduce((n, a) => n + a.motors, 0)
	const drivers = (values.parts ?? []).filter((p) => p.role === "stepper-driver").length
	if (values.parts && drivers < motors) out.push({ kind: "cnc-wiring", message: `the machine has ${motors} stepper motors (${m.axes.map((a) => `${a.name.toUpperCase()}${a.motors > 1 ? ` ×${a.motors}` : ""}`).join(", ")}) but the board has ${drivers} stepper driver${drivers === 1 ? "" : "s"} (role stepper-driver): one per motor`, fields: ["parts"], affects: ["parts"] })
	// Each driver is driven: its STEP, DIR and EN (the TMC2209's ENN) on MCU GPIOs, partRef the driver. Before (26 Nov
	// 2026, CNC mock run 6) four unwired TMC2209s on a board with no pins at all settled at 0 violations.
	const pins = values.pins ?? []
	// With the e-stop's enable gate (gap 7) every ENN is its output: the gate's B input takes the MCU's GPIO instead.
	const gate = (values.parts ?? []).find((p) => p.role === "enable-gate")
	if (gate && !pins.some((p) => p.partRef === gate.ref && p.partPin === "B")) out.push({ kind: "cnc-wiring", message: `the drivers' enable gate ${gate.ref} (${gate.mpn}) has no GPIO on B (the MCU's STEPPERS_EN): assign a free MCU GPIO with partRef ${gate.ref} and partPin B`, fields: ["pins"], affects: ["architect"] })
	for (const d of (values.parts ?? []).filter((p) => p.role === "stepper-driver")) {
		const need = [["STEP", "STEP"], ["DIR", "DIR"], ...(gate ? [] : [["EN", "ENN"]])].filter(([, pin]) => d.pins.includes(pin) && !pins.some((p) => p.partRef === d.ref && p.partPin === pin))
		if (need.length) out.push({ kind: "cnc-wiring", message: `the stepper driver ${d.ref} (${d.mpn}) has no GPIO on ${need.map(([, pin]) => pin).join(", ")}: assign each to a free MCU GPIO with partRef ${d.ref} and partPin ${need.map(([, pin]) => pin).join("/")} (signals named per axis, e.g. X_${need[0][0]})`, fields: ["pins"], affects: ["architect"] })
	}
	// grblHAL's board map (gap 11, src/cnc/grblhal.ts) names a pin for each of these: one missing is a map that can't be
	// written, so the firmware's configuration would be a guess.
	if (m.firmware === "grblhal" && values.parts && values.pins?.length) {
		const { missing } = grblhalPins({ revision: 0, versions: {} as never, values })
		if (missing.length) out.push({ kind: "cnc-wiring", message: `grblHAL's board map needs a GPIO for ${missing.join(", ")} (the signals by those names in pins): assign each to a free MCU pin with its part's pin`, fields: ["pins"], affects: ["architect"] })
	}
	// The motors' supply: a rail at the brick's volts for the drivers' VS (the TMC2209's 5.5–29 V).
	if (values.rails && drivers && !values.rails.some((r) => Math.abs(r.voltageV - m.input.volts) < 0.5)) out.push({ kind: "cnc-wiring", message: `the board has no ${m.input.volts} V rail for the stepper drivers' motor supply (VS) from the ${m.input.volts} V brick: add it to rails (rails: ${values.rails.map((r) => `${r.name} ${r.voltageV} V`).join(", ")})`, fields: ["rails"], affects: ["architect"] })
	// The spindle runs on the supply's volts: one brick feeds motors and spindle.
	if (m.spindle.volts !== m.input.volts) push("cnc-supply", `the spindle runs on ${m.spindle.volts} V but the brick gives ${m.input.volts} V: one supply feeds the motors and the spindle, so pick a ${m.input.volts} V spindle or a ${m.spindle.volts} V brick`)
	if (!t) return out
	for (const name of CNC_AXES) {
		const a = m.axes.find((x) => x.name === name)
		const need = t.travelMm[name]
		if (a && a.travelMm < need) push("cnc-travel", `the ${name.toUpperCase()} axis travels ${a.travelMm} mm, short of the brief's ${need} mm work area: a longer screw and rail, or ask to shrink the work area`, true)
	}
	const [fw, fd] = m.frame.footprintMm, [tw, td] = t.footprintMm
	if (fw > tw || fd > td) push("cnc-travel", `the frame takes ${fw} × ${fd} mm of desk, more than the brief's ${tw} × ${td} mm`, true)
	if (m.spindle.watts > t.spindleW) push("cnc-supply", `the spindle is ${m.spindle.watts} W, over the brief's ${t.spindleW} W`, true)
	if (!cat) return out
	// The emergency stop's power switch and its gate loop (gap 7, src/cnc/estop.ts).
	out.push(...estopChecks(values, cat))
	// The spindle's stall stop: its current measured (src/cnc/estop.ts spindleSenseChecks).
	out.push(...spindleSenseChecks(values, cat))

	// The catalog's parts.
	const mech = cat.mech
	const missing: string[] = []
	const spindle = mech.spindles?.find((x) => x.mpn === m.spindle.part)
	if (!spindle) missing.push(`the spindle ${m.spindle.part} (spindles: ${(mech.spindles ?? []).map((x) => x.mpn).join(", ")})`)
	// The brick the parts list will buy (robot-parts.ts: same volts, at least the amps).
	if (!(mech.powerBricks ?? []).some((b) => b.volts === m.input.volts && b.amps >= m.input.amps)) missing.push(`a ${m.input.volts} V brick of at least ${m.input.amps} A (powerBricks: ${(mech.powerBricks ?? []).map((b) => `${b.volts} V ${b.amps} A`).join(", ")})`)
	for (const a of m.axes) {
		if (!mech.steppers?.some((x) => x.mpn === a.motor)) missing.push(`the ${a.name.toUpperCase()} motor ${a.motor} (steppers: ${(mech.steppers ?? []).map((x) => x.mpn).join(", ")})`)
		if (!(mech.driveTrain ?? []).some((x) => x.kind === "leadscrew" && x.mpn === a.screw)) missing.push(`the ${a.name.toUpperCase()} screw ${a.screw} (driveTrain lead screws)`)
		if (!mech.rails?.some((x) => x.mpn === a.rail)) missing.push(`the ${a.name.toUpperCase()} rail ${a.rail} (rails)`)
	}
	if (missing.length) {
		push("cnc-parts", `not in catalog/mechanics.json: ${missing.join("; ")}`)
		return out
	}
	if (spindle!.volts !== m.spindle.volts) push("cnc-supply", `the spindle ${spindle!.mpn} runs on ${spindle!.volts} V, not the ${m.spindle.volts} V the design says`)

	// Per axis: the screw's length, the driver's current, the step, and the torque at the rapid speed.
	const chip = (t.cut.toolMm > 0 ? t.feedMmMin / 60 / (spindle!.noLoadRpm / 60) / FLUTES : 0) * t.cut.depthMm  // mm² of chip
	const cutN = CUT_KC_N_MM2 * chip
	let motorsW = 0
	const driver = driverRmsA(values, cat)
	for (const a of m.axes) {
		const motor = mech.steppers!.find((x) => x.mpn === a.motor)!
		const screw = (mech.driveTrain ?? []).find((x) => x.mpn === a.screw)! as unknown as { leadMm: number; lengthMm: number }
		const A = a.name.toUpperCase()
		if (screw.lengthMm < a.travelMm + SCREW_SPARE_MM) push("cnc-axis", `the ${A} screw is ${screw.lengthMm} mm, short of the ${a.travelMm} mm travel plus ${SCREW_SPARE_MM} mm for the nut and bearings (estimate): a ${a.travelMm + SCREW_SPARE_MM} mm or longer screw`)
		if (a.driver.currentA > motor.ratedA) push("cnc-axis", `the ${A} driver runs ${a.driver.currentA} A RMS, over the ${motor.mpn}'s rated ${motor.ratedA} A per phase`)
		if (driver && a.driver.currentA > driver.contA) push("cnc-axis", `the ${A} driver runs ${a.driver.currentA} A RMS, over the ${driver.mpn}'s ${driver.contA} A continuous (catalog/parts.json): lower it, or a bigger driver`)
		const fullStepMm = screw.leadMm / (360 / motor.stepDeg)
		if (fullStepMm > t.repeatMm) push("cnc-axis", `one full step moves the ${A} axis ${fullStepMm.toFixed(3)} mm, coarser than the ${t.repeatMm} mm repeatability (microsteps aren't positions under load): a finer lead or a 0.9° motor`, true)
		const rpm = t.rapidMmMin / screw.leadMm
		const forceN = MOVING_KG[a.name] * (ACCEL_MM_S2 / 1000) + cutN + (a.name === "z" ? MOVING_KG.z * 9.81 : 0)
		const needNm = (TORQUE_MARGIN * forceN * (screw.leadMm / 1000)) / (2 * Math.PI * SCREW_EFF) / a.motors
		const haveNm = pulloutAt(motor, rpm) * Math.min(1, a.driver.currentA / motor.pulloutAt.peakA * Math.SQRT2)
		if (haveNm < needNm) push("cnc-axis", `at the ${t.rapidMmMin} mm/min rapid (${rpm.toFixed(0)} rpm) the ${A} motor pulls ${haveNm.toFixed(3)} N·m at ${a.driver.currentA} A, short of the ${needNm.toFixed(3)} N·m its load needs (${forceN.toFixed(1)} N through the screw, ×${TORQUE_MARGIN}; estimates): more current, a slower rapid, or a stronger motor`, true)
		// Each motor's coils at the set current (two phases), the brick's share.
		motorsW += a.motors * 2 * a.driver.currentA ** 2 * motor.phaseOhm
	}
	const needW = (motorsW + spindle!.watts + CNC_LOGIC_W) * CNC_SUPPLY_HEADROOM
	const haveW = m.input.volts * m.input.amps
	if (haveW < needW) push("cnc-supply", `the ${m.input.volts} V ${m.input.amps} A brick gives ${haveW.toFixed(0)} W; the motors (${motorsW.toFixed(0)} W), the spindle (${spindle!.watts} W) and the logic (${CNC_LOGIC_W} W) at once need ${needW.toFixed(0)} W with ${CNC_SUPPLY_HEADROOM}× headroom: a ${Math.ceil(needW / m.input.volts * 10) / 10} A or bigger brick`)
	return out
}
