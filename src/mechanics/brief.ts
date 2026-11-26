import type { ContractSnapshot } from "../contract/types.ts"
import type { MechViolation } from "./checks.ts"
import type { ArmTargets } from "../arm/types.ts"

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
	// A competition the brief names, whose robot rules apply (catalog/rules).
	rules?: string
	// The brief asks for wheel encoders or odometry ("encoders on both drive wheels", "knows where it is").
	encoders?: true
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
	if (/\beurobot\b/i.test(text)) out.rules = "eurobot-2026"
	if (/\bencoders?\b|\bodometry\b/i.test(text)) out.encoders = true
	return out
}

// A robot arm's targets as the brief states them (briefs/arm.md), or null for a brief that isn't an arm's: one that
// names an arm and its reach ("reach about 280 mm"). The brief states how far the cup is from the pick point, not where
// either stands; where they go is decided here (the spec leaves it to the builder):
//   - both on the table, symmetric about +x (the arm's forward), so the drop is exactly the brief's distance from the
//     pick, measured on the table;
//   - each ARM_POINT_SHARE of the reach out from the base axis, well inside the workspace, so both still solve with
//     the gripper pointing down from ARM_APPROACH_MM above (src/arm/checks.ts arm-reach);
//   - the pick's grip point at the cube's middle, the drop's high enough that the cube's bottom clears the cup's rim
//     by ARM_RIM_CLEARANCE_MM.
// A number the brief doesn't state takes its default: a 30 mm cube, a 40 mm cup, a 250 mm drop, 100 g payload, half
// of it for the object, 1 repeat.
export const ARM_POINT_SHARE = 0.7
export const ARM_RIM_CLEARANCE_MM = 5
const ARM_WORD = /\b(robot(?:ic)? arm|desktop arm)\b/i
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

export function armTargetsFromBrief(brief: string): ArmTargets | null {
	const text = brief.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ")
	if (!ARM_WORD.test(text)) return null
	const reach = new RegExp(`\\breach(?:es)?\\b[^.;]*?${NUM}\\s*(mm|cm)\\b`, "i").exec(text)
	if (!reach) return null
	const mm = (n: string, unit: string) => toMm(Number(n), unit.toLowerCase())
	const reachMm = mm(reach[1], reach[2])
	const payload = new RegExp(`${NUM}\\s*g\\b[^.;]*?\\bpayload\\b|\\bpayload\\b[^.;]*?${NUM}\\s*g\\b`, "i").exec(text)
	const payloadG = payload ? Number(payload[1] ?? payload[2]) : 100
	const object = new RegExp(`${NUM}\\s*g\\s+(?:cube|ball|block|object)`, "i").exec(text)
	const objectG = object ? Number(object[1]) : payloadG / 2
	const side = new RegExp(`(?:cube|block)[^.;]*?${NUM}\\s*(mm|cm)\\s+on a side`, "i").exec(text)
	const sideMm = side ? mm(side[1], side[2]) : 30
	const cup = new RegExp(`\\bcup\\s+(?:about\\s+)?${NUM}\\s*(mm|cm)\\s+(?:from|away)`, "i").exec(text)
	const apart = cup ? mm(cup[1], cup[2]) : 250
	const cupTall = new RegExp(`\\bcup\\b[^.;]*?${NUM}\\s*(mm|cm)\\s+tall`, "i").exec(text)
	const cupMm = cupTall ? mm(cupTall[1], cupTall[2]) : 40
	const times = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+times in a row\b/i.exec(text)
	const repeats = times ? (WORDS[times[1].toLowerCase()] ?? Number(times[1])) : 1
	// Both points ARM_POINT_SHARE of the reach out, half the distance apart either side of +x (on the y axis when the
	// distance is more than that circle allows: the reach check then names the shortfall).
	const r = ARM_POINT_SHARE * reachMm, half = apart / 2
	const x = Math.round(Math.sqrt(Math.max(0, r * r - half * half)) / 5) * 5
	return {
		reachMm,
		payloadG,
		pick: { xMm: x, yMm: -half, zMm: sideMm / 2 },
		drop: { xMm: x, yMm: half, zMm: cupMm + sideMm / 2 + ARM_RIM_CLEARANCE_MM },
		repeats,
		objectG,
	}
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
	if (b.rules && motion.rules !== b.rules) wrong.push(`rules ${motion.rules ?? "unset"} where the brief is for ${b.rules} (set motion.rules: "${b.rules}", so the design is checked against that competition's robot rules)`)
	const one = (key: keyof Omit<BriefMotion, "maxSizeMm" | "rules" | "encoders">, unit: string) => {
		const want = b[key], have = motion[key]
		if (want !== undefined && typeof have === "number" && off(have, want)) wrong.push(`${key} ${have} where the brief says ${want} ${unit}`)
	}
	// Real run 18 (Eurobot): the brief asked for "encoders on both drive wheels" and the design drove plain gearmotors.
	if (b.encoders && !motion.encoders) wrong.push("encoders unset where the brief asks for wheel encoders (set motion.encoders: true: the checks then require an encoder gearmotor and its plugs)")
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
