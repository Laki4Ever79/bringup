// The arm's rail plan (arm task 5, moved out of power-auto.ts on 25 Nov 2026 so circuit.ts can read it: power-auto imports
// the consistency checks, which import circuit.ts, so circuit.ts importing power-auto was a cycle that left chassis.ts's
// constants uninitialised). Imports only leaf modules; power-auto.ts re-exports everything here.
import { resolve } from "node:path"
import type { ContractSnapshot, Part, Rail } from "./types.ts"
import type { ArmJointName, ArmSpec } from "../arm/types.ts"
import { loadMechCatalog, servoAt } from "../mechanics/catalog.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import { SERVO_STALL_A, SERVO_SUPPLY_EFF } from "../mechanics/servo-stall.ts"

const ROOT = resolve(import.meta.dirname, "../..")
let cat: { mech: ReturnType<typeof loadMechCatalog>; boardParts: Part[] } | undefined
const catalogs = () => (cat ??= { mech: loadMechCatalog(ROOT), boardParts: loadCatalog(ROOT) as unknown as Part[] })

// Every power module the code or an agent picks (a step-down, the servos' supply) becomes a chip JLCPCB assembles, with
// its datasheet's parts (the board generator adds them), when the catalog has one of that role rated for the pack's full
// voltage and the role's current: the module stays the fallback (lead decision after real run 20, 17 Nov 2026: the
// D24V5F5 and the D36V50F5 had no LCSC number). The current a role needs: the servos', each at stall (SERVO_STALL_A,
// an estimate) times their count; a step-down's, the catalog chip's own rating (the logic rail's few hundred mA).
// A supply chip must be rated at least this much over the role's peak (lead decision, 17 Nov 2026): servos stall
// together (a blocked arm, a start), the stall figure itself is an estimate, and a converter run at its limit runs hot
// and trips its current limit; 25 % is the usual derating for a supply's continuous rating.
export const SUPPLY_HEADROOM = 1.25

// ---- A robot arm's power (arm task 5; docs/superpowers/specs/2026-11-25-robot-arm-design.md) ----
// The servos run from rails at the arm's railV (6 V for hobby servos), each one SY8368A set by its feedback divider; six
// servos at stall (3 x 2.5 A + 3 x 0.7 A at 6 V = 9.6 A, 12 A with headroom) overflow one 8 A chip, so they split across
// rails. A mains brick feeds the rails and, through the usual step-down, the logic. One place maps plug → channel → rail →
// chip (armRails), read by the power tree here, the checks and the board generator (circuit.ts).

// The arm's input net: the brick's jack (its VIN), the rails' chips and the logic step-down take it.
export const armInputNet = "VIN_BRICK"
// The logic side's draw from the brick, an ESTIMATE: the ESP32-S3 at its Wi-Fi peak (~0.5 A at 3.3 V) through the LDO
// from 5 V (2.5 W at 5 V), the PCA9685 and LEDs within it.
export const ARM_LOGIC_W = 2.5
export const EPS = 1e-9

// The plugs in fixed order: JV1.. for arm.joints, then the gripper.
export function armServos(arm: ArmSpec): { ref: string; joint: ArmJointName | "gripper"; servo: string; channel: number }[] {
	return [...arm.joints.map((j) => ({ joint: j.name as ArmJointName | "gripper", servo: j.servo, channel: j.channel })), { joint: "gripper" as const, servo: arm.gripper.servo, channel: arm.gripper.channel }].map((x, i) => ({ ...x, ref: `JV${i + 1}` }))
}

// Splits servos at stall across rails of one chip: the fewest rails whose need × SUPPLY_HEADROOM each fit chipA, filled
// largest first into the least-loaded rail (so the rails share the load). null when one servo alone doesn't fit.
export function servoRails(servos: { ref: string; stallA: number }[], chipA: number): { refs: string[]; needA: number }[] | null {
	if (!servos.length) return []
	if (servos.some((s) => s.stallA * SUPPLY_HEADROOM > chipA + EPS)) return null
	const sorted = [...servos].sort((a, b) => b.stallA - a.stallA || a.ref.localeCompare(b.ref))
	const total = sorted.reduce((a, s) => a + s.stallA, 0)
	for (let n = Math.max(1, Math.ceil((total * SUPPLY_HEADROOM) / chipA - EPS)); n <= servos.length; n++) {
		const rails = Array.from({ length: n }, () => ({ refs: [] as string[], needA: 0 }))
		for (const s of sorted) {
			const r = rails.reduce((m, x) => (x.needA < m.needA ? x : m))
			r.refs.push(s.ref)
			r.needA += s.stallA
		}
		if (rails.every((r) => r.needA * SUPPLY_HEADROOM <= chipA + EPS)) return rails.filter((r) => r.refs.length).map((r) => ({ refs: r.refs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), needA: r.needA }))
	}
	return null
}

// The SY8368A's feedback divider for a rail: Vout = 0.6 V × (1 + R1/R2) (Silergy SY8368A Rev. 0.9C, Pin Description), both
// from the E24 series (1k..100k), the closest output; on a tie the 3k bottom resistor the 5 V rail already uses.
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1]
const E24K = [...E24, ...E24.map((x) => x * 10), 100].map((x) => Math.round(x * 10) / 10)
const kOhm = (x: number) => `${x}k`
export function railDivider(v: number): { r1: string; r2: string; voutV: number } {
	let best = { r1: 27, r2: 3, voutV: 6, err: Infinity, tie: Infinity }
	for (const r2 of E24K.filter((x) => x <= 10))
		for (const r1 of E24K) {
			const voutV = 0.6 * (1 + r1 / r2)
			const err = Math.abs(voutV - v)
			const tie = Math.abs(r2 - 3)
			if (err < best.err - EPS || (Math.abs(err - best.err) <= EPS && tie < best.tie)) best = { r1, r2, voutV, err, tie }
		}
	return { r1: kOhm(best.r1), r2: kOhm(best.r2), voutV: Math.round(best.voutV * 1000) / 1000 }
}

export interface ArmRail {
	net: string // VSERVO1, VSERVO2, …
	supplyRef: string // its SY8368A (role servo-supply), in rail order; "" when the parts don't have it yet
	railV: number
	divider: { r1: string; r2: string; voutV: number }
	needA: number // its servos at stall
	headroomA: number // needA × SUPPLY_HEADROOM: what the chip must carry
	plugs: { ref: string; joint: ArmJointName | "gripper"; channel: number; stallA: number }[]
}

type SupplyEntry = Part & { lcsc: string | null; maxInV?: number | null; maxA?: number | null }
// The servo rails' chip: the assembled servo supply rated for the brick's voltage with the most current (the SY8368A).
export function railChip(volts: number): SupplyEntry | undefined {
	const list = (catalogs().boardParts) as unknown as SupplyEntry[]
	return list.filter((x) => x.role === "servo-supply" && x.lcsc && (x.maxInV ?? 0) >= volts && x.maxA).sort((a, b) => (b.maxA ?? 0) - (a.maxA ?? 0))[0]
}

// Each servo's stall current at the rail: the catalog's at railV (servoAt); outside its rated range (a violation
// armPowerChecks reports) its highest listed figure, and a servo the catalog lacks the rover's SERVO_STALL_A estimate.
export function stallOf(servo: string, railV: number): number {
	const p = catalogs().mech.servos?.find((s) => s.mpn === servo)
	if (!p) return SERVO_STALL_A
	const r = servoAt(p, railV)
	return "error" in r ? Math.max(...p.stallA.map((x) => x.a)) : r.stallA
}

export function railPlan(arm: ArmSpec) {
	const plugs = armServos(arm).map((s) => ({ ref: s.ref, joint: s.joint, channel: s.channel, stallA: stallOf(s.servo, arm.railV) }))
	const chip = railChip(arm.input.volts) ?? railChip(0)
	const chipA = chip?.maxA ?? 8
	const split = servoRails(plugs, chipA)
	// No split fits (one servo over the chip): one rail per servo, so the board still has a rail for each; the check says why.
	const rails = split ?? plugs.map((p) => ({ refs: [p.ref], needA: p.stallA }))
	return { plugs, chip, chipA, rails, fits: split !== null }
}

// The arm's rails from its contract: null for anything but an arm.
export function armRails(s: ContractSnapshot): ArmRail[] | null {
	const arm = s.values.arm
	if (!arm) return null
	const plan = railPlan(arm)
	const supplies = (s.values.parts ?? []).filter((p) => p.role === "servo-supply")
	const divider = railDivider(arm.railV)
	return plan.rails.map((r, i) => ({
		net: `VSERVO${i + 1}`,
		supplyRef: supplies[i]?.ref ?? "",
		railV: arm.railV,
		divider,
		needA: r.needA,
		headroomA: r.needA * SUPPLY_HEADROOM,
		plugs: plan.plugs.filter((p) => r.refs.includes(p.ref)),
	}))
}


// The rails the code generates for an arm, as contract rails with their peak (lead-2, 26 Nov 2026: "every rail the code
// generates goes into values.rails with its peak current"), so the copper for them is sized like any other rail's
// (circuit.ts supplyWidths, IPC-2221). Each servo rail: its servos at stall, its chip's rating as the regulator limit.
// The brick's net: those rails' power through their converters (SERVO_SUPPLY_EFF, an estimate) plus the logic's
// (ARM_LOGIC_W, an estimate), at the brick's voltage; the brick's rating as its limit.
export function armRailEntries(s: ContractSnapshot): Rail[] {
	const arm = s.values.arm
	const rails = armRails(s)
	if (!arm || !rails) return []
	const chipA = railPlan(arm).chipA
	const servoW = rails.reduce((a, r) => a + r.railV * r.needA, 0)
	return [
		...rails.map((r) => ({ name: r.net, voltageV: r.railV, regulatorMaxMa: Math.round(chipA * 1000), loadMa: Math.round(r.needA * 1000) })),
		{ name: armInputNet, voltageV: arm.input.volts, regulatorMaxMa: Math.round(arm.input.amps * 1000), loadMa: Math.round(((servoW / SERVO_SUPPLY_EFF + ARM_LOGIC_W) / arm.input.volts) * 1000) },
	]
}
// The contract's rails with the generated ones put in (replacing an older entry of the same name, so a changed arm
// updates them); the rails unchanged for anything but an arm.
export function withArmRails(rails: Rail[], s: ContractSnapshot): Rail[] {
	const gen = armRailEntries(s)
	if (!gen.length) return rails
	const names = new Set(gen.map((r) => r.name))
	return [...rails.filter((r) => !names.has(r.name)), ...gen]
}
