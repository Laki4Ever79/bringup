import type { Mechanics } from "../mechanics/types.ts"

// A desktop robot arm (docs/superpowers/specs/2026-11-25-robot-arm-design.md): two contract fields. `armTargets` holds the
// brief's targets (owned by the architect); `arm` the joints, servos, base and supply that meet them (owned by the
// mechanics agent). An arm design has no `mechanics` field, so every rover check stays out of it.
// Frame: origin at the base plate's top centre, +x forward (toward the pick point), +y left, z up; millimetres.
export type Xyz = { xMm: number; yMm: number; zMm: number }

// reachMm: from the shoulder axis to the fingertips' grip point, the arm stretched out. payloadG: what the gripper must hold
// at full reach (the design load); objectG: the demo object's mass. repeats: how many pick-and-drops in a row must succeed.
export interface ArmTargets {
	reachMm: number
	payloadG: number
	pick: Xyz
	drop: Xyz
	repeats: number
	objectG: number
}

export type ArmJointName = "base-yaw" | "shoulder" | "elbow" | "wrist-pitch" | "wrist-roll"
export const ARM_JOINTS: readonly ArmJointName[] = ["base-yaw", "shoulder", "elbow", "wrist-pitch", "wrist-roll"]

// servo: a catalog servos mpn; channel: its output on the servo driver (PCA9685 0..15); linkMm: the distance to the next
// joint's axis (wrist-roll: to the fingertips' grip point); minDeg..maxDeg: its limits, 0 being the arm stretched forward
// and level (base yaw: pointing along +x).
export interface ArmJoint {
	name: ArmJointName
	servo: string
	channel: number
	linkMm: number
	minDeg: number
	maxDeg: number
}

// A printed link's mass and centre of mass, in the frame of the joint that moves it (written by the arm geometry tool).
export interface ArmLink {
	name: ArmJointName | "gripper"
	massG: number
	comMm: [number, number, number]
}

export interface ArmSpec {
	// shoulderZMm: the shoulder axis's height above the plate's top; holdDown: the base stays put by its own mass (plus
	// ballastG) or is clamped to the desk.
	base: { plateMm: [number, number]; thicknessMm: number; shoulderZMm: number; holdDown: "mass" | "clamps"; ballastG: number }
	// Exactly ARM_JOINTS, in that order.
	joints: ArmJoint[]
	gripper: { servo: string; channel: number; openMm: number; fingerMm: number }
	// The servos' supply rail (V), 6 for the hobby servos.
	railV: number
	// The arm's power input: a mains DC brick. mpn and tolerancePct from its catalog entry (mechanics.json powerBricks):
	// the input TVS must stay off at nominal × (1 + tolerance) (src/arm/tvs.ts; ±5 %, an estimate, when absent).
	input: { kind: "dc-brick"; volts: number; amps: number; mpn?: string; tolerancePct?: number }
	// The controller on the base plate.
	boards: Mechanics["chassis"]["boards"]
	// Written by the arm geometry tool; absent, the checks estimate the links from the servo masses.
	links?: ArmLink[]
}
