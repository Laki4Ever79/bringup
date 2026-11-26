// The arm's printed parts (py/arm.py, arm task 3): run only for a design with an `arm`; its sweep's clashes become
// arm-interference and its print problems arm-dfm, and the printed links' masses go back into the contract's arm.links
// (the torque check then uses them instead of the armLinkG estimate).
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ContractValues } from "../contract/types.ts"
import { ARM_APPROACH_MM } from "../arm/checks.ts"
import { solve } from "../arm/kinematics.ts"
import type { ArmLink, ArmSpec } from "../arm/types.ts"

const exec = promisify(execFile)

export interface ArmClash { pose: number[]; a: string; b: string; mm3: number | null }
export interface ArmBuilt { poses: number; pairs: number; clashes: ArmClash[]; print: { ok: boolean; issues: string[]; notes: string[]; bedMm: number[] } }
export type ArmArtifact = { ok: true; dir: string; files: string[]; links: ArmLink[]; built: ArmBuilt }
export type ArmResult = ArmArtifact | { ok: false; reason: string }

// The joint angles (degrees, ARM_JOINTS order) the firmware will drive to: the pick and the drop, and ARM_APPROACH_MM
// above each. The sweep checks them besides its grid. A point that doesn't solve is the reach check's, not the sweep's.
export function armPoses(values: Pick<ContractValues, "arm" | "armTargets">): number[][] {
	const { arm, armTargets: t } = values
	if (!arm || !t) return []
	const out: number[][] = []
	for (const p of [t.pick, t.drop]) for (const at of [p, { ...p, zMm: p.zMm + ARM_APPROACH_MM }]) {
		const q = solve(arm, at)
		if (Array.isArray(q)) out.push(q.map((d) => Math.round(d * 1000) / 1000))
	}
	return out
}

export async function buildArm(python: string, root: string, dir: string, values: Pick<ContractValues, "arm" | "armTargets">): Promise<ArmResult> {
	if (!values.arm) return { ok: false, reason: "no arm design to build" }
	mkdirSync(dir, { recursive: true })
	const input = join(dir, "arm-input.json")
	writeFileSync(input, JSON.stringify({ arm: values.arm, armTargets: values.armTargets ?? null, armPoses: armPoses(values) }, null, 1))
	const out = join(dir, "arm")
	try {
		await exec(python, [join(root, "py", "arm.py"), input, dir], { timeout: 600_000 })
	} catch (e) {
		const said = existsSync(join(out, "interference.json")) ? (JSON.parse(readFileSync(join(out, "interference.json"), "utf8")) as { error?: string }).error : undefined
		return { ok: false, reason: said ?? String((e as { stderr?: string }).stderr ?? e).trim().split("\n").filter(Boolean).at(-1) ?? "the arm generator failed" }
	}
	const built = JSON.parse(readFileSync(join(out, "interference.json"), "utf8")) as ArmBuilt
	const links = JSON.parse(readFileSync(join(out, "links.json"), "utf8")) as ArmLink[]
	return { ok: true, dir: out, files: readdirSync(out).sort().map((f) => join(out, f)), links, built }
}

// The arm with its printed links' measured masses, for the contract (mechanics writes `arm`); null when they're the
// same already, so an unchanged build doesn't write a new version and wake everyone again.
export function armWithLinks(arm: ArmSpec, links: ArmLink[]): ArmSpec | null {
	return JSON.stringify(arm.links ?? null) === JSON.stringify(links) ? null : { ...arm, links }
}

type ArmBuildViolation = { kind: "arm-interference" | "arm-dfm"; message: string; fields: ["arm"]; affects: ["mechanics"] }
const fmt = (pose: number[]) => `(${pose.map((d) => Math.round(d)).join(", ")})°`
// The built arm's sweep and print check, as violations for the mechanics engineer (who owns `arm`): one per clashing
// pair (its worst pose and how many poses), and the print problems.
export function armBuildChecks(a: ArmArtifact | undefined): ArmBuildViolation[] {
	if (!a) return []
	const v: ArmBuildViolation[] = []
	const byPair = new Map<string, ArmClash[]>()
	for (const c of a.built.clashes) byPair.set(`${c.a}|${c.b}`, [...(byPair.get(`${c.a}|${c.b}`) ?? []), c])
	for (const [pair, cs] of byPair) {
		const [x, y] = pair.split("|")
		const worst = cs.reduce((m, c) => ((c.mm3 ?? Infinity) > (m.mm3 ?? Infinity) ? c : m))
		const vol = worst.mm3 === null ? "a failed boolean, so not proven clear" : `${worst.mm3} mm³ in common`
		v.push({ kind: "arm-interference", message: `the arm's ${x} hits its ${y} at joints (yaw, shoulder, elbow, wrist pitch, wrist roll) ${fmt(worst.pose)}: ${vol}${cs.length > 1 ? `, and at ${cs.length - 1} more of the ${a.built.poses} swept poses` : ""}; narrow the joint limits or move the part`, fields: ["arm"], affects: ["mechanics"] })
	}
	if (!a.built.print.ok) v.push({ kind: "arm-dfm", message: `the arm's printed parts can't be printed as designed: ${a.built.print.issues.join("; ")}`, fields: ["arm"], affects: ["mechanics"] })
	return v
}
