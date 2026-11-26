// The arm's firmware header (include/arm.h of templates/fw-arm), generated from the contract: the geometry the IK solves
// with, each servo's channel, limits, speed and pulse, and the brief's pick-and-place task. No model writes C.
import type { ContractSnapshot } from "../contract/types.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { servoAt, type ServoPart } from "../mechanics/catalog.ts"
import { ARM_JOINTS } from "./types.ts"
// How far above the pick and drop points the arm comes in (arm-reach checks the same height; the firmware lowers it until
// both solve, for a design that fails that check).
import { ARM_APPROACH_MM } from "./checks.ts"

// The moves run at this share of each servo's no-load speed at the rail (secPer60), a margin for the load (plan, task 7).
export const ARM_SPEED_SHARE = 0.8
// One control tick: the servos' own 50 Hz frame.
export const ARM_SERVO_HZ = 50
export const ARM_PERIOD_MS = 1000 / ARM_SERVO_HZ
// The ramp at each end of a move, an ESTIMATE (no servo publishes its acceleration).
export const ARM_RAMP_S = 0.15
// The gripper's servo angle closed and open, and the hold after gripping or releasing: ESTIMATES until the gripper's
// geometry (arm task 3) sets them.
export const ARM_GRIP_CLOSED_DEG = 0
export const ARM_GRIP_OPEN_DEG = 90
export const ARM_GRIP_HOLD_MS = 400
// Held at the pick and drop before the gripper moves, so the servos (which lag the commanded profile) arrive first; and
// added to the power-on hold (ARM_START_MS, below). An estimate: the simulated wrist settled in ~0.3 s (26 Nov trace).
export const ARM_SETTLE_MS = 300
// The power-on hold: the slowest servo across its whole travel at full no-load speed, twice over (an estimate covering the
// load and the ramp), plus the settle.
export function armStartMs(servos: { rangeDeg: number; degPerS: number }[]): number {
	return Math.ceil((2 * Math.max(...servos.map((x) => x.rangeDeg / x.degPerS)) * 1000) / 100) * 100 + ARM_SETTLE_MS
}

// A C float literal: always with a decimal point ("60f" isn't C).
const f = (n: number) => { const t = String(Number(n.toFixed(3))); return `${/[.e]/.test(t) ? t : `${t}.0`}f` }
const list = (xs: number[], fmt = f) => `{${xs.map(fmt).join(", ")}}`

// The gripper opens to ARM_GRIP_OPEN_DEG, or as far as its servo turns.
const gripOpen = (rangeDeg: number) => Math.min(rangeDeg, ARM_GRIP_OPEN_DEG)
export function armGripOpenDeg(s: ContractSnapshot): number {
	const mpn = s.values.arm?.gripper.servo
	const part = defaultCheckCatalog()?.mech.servos?.find((p) => p.mpn === mpn)
	return part ? gripOpen(part.rangeDeg) : ARM_GRIP_OPEN_DEG
}

// The firmware's servo map: one per joint (ARM_JOINTS order) then the gripper, with its catalog part, PCA9685 channel and
// the joint range it covers (the gripper: closed..open). armHeader writes it into the firmware; the simulation's bridge
// inverts it (pulse → joint, py/mech/arm_drive.py). Throws, naming the cause, when a servo can't be driven.
export type ArmServo = { name: string; part: ServoPart; channel: number; minDeg: number; maxDeg: number }
export function armServos(s: ContractSnapshot): ArmServo[] {
	const arm = s.values.arm
	if (!arm) throw new Error("arm firmware not built: the contract has no arm or armTargets")
	const cat = defaultCheckCatalog()
	const servos: ArmServo[] = []
	const missing: string[] = []
	for (const [name, mpn, channel, lim] of [...arm.joints.map((j) => [j.name, j.servo, j.channel, [j.minDeg, j.maxDeg]] as const), ["gripper", arm.gripper.servo, arm.gripper.channel, null] as const]) {
		const part = cat?.mech.servos?.find((p) => p.mpn === mpn)
		if (!part) { missing.push(`${name} servo ${mpn}`); continue }
		const range = part.rangeDeg
		servos.push({ name, part, channel, minDeg: lim ? lim[0] : ARM_GRIP_CLOSED_DEG, maxDeg: lim ? lim[1] : gripOpen(range) })
	}
	if (missing.length) throw new Error(`arm firmware not built: ${missing.join(", ")} not in catalog/mechanics.json servos`)
	const bus = servos.filter((x) => x.part.control !== "pwm" || !x.part.pulseUs)
	if (bus.length) throw new Error(`arm firmware not built: ${bus.map((x) => `${x.name} ${x.part.mpn} (${x.part.control})`).join(", ")}: phase 1 drives PWM servos only; bus servos are phase 2`)
	return servos
}

// The PCA9685's I2C address: the board's pwm-driver part's, else the chip's default 0x40.
export function armPcaAddr(s: ContractSnapshot): number {
	return ((s.values.parts ?? []).find((p) => p.role === "pwm-driver") as { i2cAddress?: number } | undefined)?.i2cAddress ?? 0x40
}

export function armHeader(s: ContractSnapshot): string {
	const arm = s.values.arm, t = s.values.armTargets
	if (!arm || !t) throw new Error("arm firmware not built: the contract has no arm or armTargets")
	const servos = armServos(s)
	const full = servos.map((x) => {
		const r = servoAt(x.part, arm.railV)
		if ("error" in r) throw new Error(`arm firmware not built: the ${x.name} servo: ${r.error}`)
		return r.degPerS
	})
	const speed = full.map((v) => v * ARM_SPEED_SHARE)
	const pin = (sig: string) => (s.values.pins ?? []).find((p) => p.signal === sig)?.gpio ?? -1
	const pwm = { i2cAddress: armPcaAddr(s) }
	const by = (name: string) => arm.joints.find((j) => j.name === name)!
	const lim = (k: "minDeg" | "maxDeg") => ARM_JOINTS.map((n) => by(n)[k])
	const xyz = (p: { xMm: number; yMm: number; zMm: number }) => list([p.xMm, p.yMm, p.zMm])
	const grip = servos[servos.length - 1]
	return [
		"// Generated from the design contract (src/arm/firmware.ts). Do not edit.",
		"#pragma once",
		"#include <stdint.h>",
		'#include "arm_logic.h"',
		`#define I2C_SDA ${pin("I2C_SDA")}`,
		`#define I2C_SCL ${pin("I2C_SCL")}`,
		`#define PCA9685_ADDR 0x${pwm.i2cAddress.toString(16)}`,
		`#define ARM_SERVO_HZ ${ARM_SERVO_HZ}`,
		`#define ARM_PERIOD_MS ${ARM_PERIOD_MS}`,
		`#define ARM_RAMP_S ${f(ARM_RAMP_S)}`,
		`#define ARM_REPEATS ${t.repeats}`,
		`#define ARM_START_MS ${armStartMs(servos.map((x, i) => ({ rangeDeg: x.part.rangeDeg, degPerS: full[i] })))}`,
		`#define ARM_RAIL_V ${f(arm.railV)}`,
		`#define ARM_GRIP_CLOSED_DEG ${f(grip.minDeg)}`,
		`#define ARM_GRIP_OPEN_DEG ${f(grip.maxDeg)}`,
		`// Servos in ARM_JOINTS order (${ARM_JOINTS.join(", ")}), then the gripper: ${servos.map((x) => `${x.name} ${x.part.mpn}`).join(", ")}.`,
		`static const uint8_t ARM_CHANNEL[ARM_NS] = ${list(servos.map((x) => x.channel), String)};`,
		`static const float ARM_MIN_DEG[ARM_NS] = ${list(servos.map((x) => x.minDeg))};`,
		`static const float ARM_MAX_DEG[ARM_NS] = ${list(servos.map((x) => x.maxDeg))};`,
		`static const float ARM_RANGE_DEG[ARM_NS] = ${list(servos.map((x) => x.part.rangeDeg))};`,
		`static const uint16_t ARM_PULSE_US[ARM_NS][2] = {${servos.map((x) => `{${x.part.pulseUs![0]}, ${x.part.pulseUs![1]}}`).join(", ")}};`,
		`// ${ARM_SPEED_SHARE * 100} % of each servo's no-load speed at ${arm.railV} V (catalog secPer60).`,
		`static const float ARM_DEG_PER_S[ARM_NS] = ${list(speed)};`,
		"// The geometry (src/arm/kinematics.ts conventions) and the brief's task.",
		`#define ARM_TASK { {${f(by("base-yaw").linkMm)}, ${f(arm.base.shoulderZMm)}, ${f(by("shoulder").linkMm)}, ${f(by("elbow").linkMm)}, ${f(by("wrist-pitch").linkMm + by("wrist-roll").linkMm)}, ${list(lim("minDeg"))}, ${list(lim("maxDeg"))}}, ${xyz(t.pick)}, ${xyz(t.drop)}, ${f(ARM_APPROACH_MM)}, ${f(grip.maxDeg)}, ${f(grip.minDeg)}, ${ARM_GRIP_HOLD_MS}, ${ARM_SETTLE_MS} }`,
		"",
	].join("\n")
}
