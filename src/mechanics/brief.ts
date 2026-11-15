import type { ContractSnapshot } from "../contract/types.ts"
import type { MechViolation } from "./checks.ts"

// The robot's targets as the brief states them, read by code, so the motion field the architect writes can be checked
// against them. Real rover run 9 (15 Nov, fast models): the architect wrote edgeMm 10, stopBeforeWallMm 50,
// runtimeMin 60 and payloadG 100 where the brief says 3 mm, 15 cm, 30 minutes and 20 g; every later check measured the
// robot against the wrong numbers, and the climb the brief asks for became impossible. Only numbers the brief states in
// a recognised phrase are read; a brief worded otherwise is simply not checked for that target.
export interface BriefMotion {
	speedMps?: number
	runtimeMin?: number
	edgeMm?: number
	stopBeforeWallMm?: number
	payloadG?: number
	maxSizeMm?: [number, number]
	maxMassG?: number
}

const NUM = String.raw`(\d+(?:\.\d+)?)`
const toMm = (n: number, unit: string) => (unit === "cm" ? n * 10 : unit === "m" ? n * 1000 : n)

export function motionFromBrief(brief: string): BriefMotion {
	// Markdown emphasis and line breaks inside a sentence don't change what it says.
	const text = brief.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ")
	const sentences = text.split(/(?<=[.;!?])\s+|\s+-\s+/)
	const out: BriefMotion = {}
	const speed = new RegExp(`${NUM}\\s*m\\/s`, "i").exec(text)
	if (speed) out.speedMps = Number(speed[1])
	const runtime = new RegExp(`(?:runs?|lasts?|runtime)[^.]*?${NUM}\\s*(?:min(?:utes?)?)\\b`, "i").exec(text)
	if (runtime) out.runtimeMin = Number(runtime[1])
	for (const s of sentences) {
		if (out.edgeMm === undefined && /\b(seams?|edges?|thresholds?|steps?|bumps?|kerbs?|curbs?)\b/i.test(s)) {
			const m = new RegExp(`${NUM}\\s*(mm|cm)\\b`, "i").exec(s)
			if (m) out.edgeMm = toMm(Number(m[1]), m[2].toLowerCase())
		}
		if (out.stopBeforeWallMm === undefined && /\bwall\b/i.test(s)) {
			const m = new RegExp(`${NUM}\\s*(mm|cm|m)\\s+(?:short of|before|from|away from)`, "i").exec(s)
			if (m) out.stopBeforeWallMm = toMm(Number(m[1]), m[2].toLowerCase())
		}
		if (out.payloadG === undefined && /\b(carr(?:y|ies)|payload)\b/i.test(s)) {
			const m = new RegExp(`(?<!under |below |at most |than |max |maximum )\\b${NUM}\\s*g\\b`, "i").exec(s)
			if (m) out.payloadG = Number(m[1])
		}
	}
	const mass = new RegExp(`(?:under|below|at most|less than|max(?:imum)?)\\s*${NUM}\\s*(g|kg)\\b`, "i").exec(text)
	if (mass) out.maxMassG = Number(mass[1]) * (mass[2].toLowerCase() === "kg" ? 1000 : 1)
	const size = new RegExp(`${NUM}\\s*[×x]\\s*${NUM}\\s*(mm|cm)\\b`, "i").exec(text)
	if (size) out.maxSizeMm = [toMm(Number(size[1]), size[3].toLowerCase()), toMm(Number(size[2]), size[3].toLowerCase())]
	return out
}

// How far the motion field may stray from the brief's number: the brief says "about", and rounding is not a mistake.
export const BRIEF_TOLERANCE = 0.1

// The motion field against the brief's own numbers: each target that differs goes back to the architect.
export function motionBriefChecks(c: ContractSnapshot, brief: string): MechViolation[] {
	const motion = c.values.motion
	if (!motion || !brief) return []
	const b = motionFromBrief(brief)
	const off = (have: number, want: number) => Math.abs(have - want) > BRIEF_TOLERANCE * want
	const wrong: string[] = []
	const one = (key: keyof Omit<BriefMotion, "maxSizeMm">, unit: string) => {
		const want = b[key], have = motion[key]
		if (want !== undefined && typeof have === "number" && off(have, want)) wrong.push(`${key} ${have} where the brief says ${want} ${unit}`)
	}
	one("speedMps", "m/s")
	one("runtimeMin", "min")
	one("edgeMm", "mm")
	one("stopBeforeWallMm", "mm")
	one("payloadG", "g")
	one("maxMassG", "g")
	if (b.maxSizeMm && motion.maxSizeMm) {
		const want = [...b.maxSizeMm].sort((x, y) => y - x), have = [...motion.maxSizeMm].sort((x, y) => y - x)
		if (off(have[0], want[0]) || off(have[1], want[1])) wrong.push(`maxSizeMm [${motion.maxSizeMm.join(", ")}] where the brief says ${b.maxSizeMm.join(" × ")} mm`)
	}
	if (!wrong.length) return []
	return [{ kind: "mech-fit", message: `the motion targets don't match the brief: ${wrong.join("; ")}. Copy the brief's numbers into motion (every mechanics check measures the robot against them)`, fields: ["motion"], affects: ["architect"] }]
}
