// The fixture arm as a run's contract (shared by the arm firmware and simulation tests): the S3, the PCA9685 on I2C.
import { fixtureContract } from "./fixture.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { ARM, TARGETS } from "./arm-contract.test.ts"
import type { ArmSpec, ArmTargets } from "../src/arm/types.ts"
import type { ContractSnapshot, Part } from "../src/contract/types.ts"

// Pick and drop well inside the fixture arm's reach with the gripper down; OUT puts the drop past the links' reach, which
// the plan refuses (below).
export const INSIDE: ArmTargets = { ...TARGETS, pick: { xMm: 150, yMm: -100, zMm: 20 }, drop: { xMm: 150, yMm: 100, zMm: 60 } }
export const OUT: ArmTargets = { ...TARGETS, drop: { xMm: 260, yMm: 125, zMm: 60 } }

export function armContract(arm: ArmSpec = ARM, targets: ArmTargets = INSIDE): ContractSnapshot {
	const c = fixtureContract()
	const cat = defaultCheckCatalog()!.boardParts as unknown as Part[]
	const one = (ref: string, f: (p: Part) => boolean) => ({ ...cat.find(f)!, ref }) as Part
	const parts = [one("U1", (p) => p.role === "mcu" && /S3/.test(p.mpn)), one("U6", (p) => p.role === "pwm-driver")]
	const pins = [{ signal: "I2C_SDA", gpio: 8, partRef: "U6", partPin: "SDA" }, { signal: "I2C_SCL", gpio: 9, partRef: "U6", partPin: "SCL" }]
	return { ...c, values: { ...c.values, arm, armTargets: targets, parts, pins, mechanics: undefined, motion: undefined } }
}

