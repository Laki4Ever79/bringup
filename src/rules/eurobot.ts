import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type BatteryPack, type MechCatalog } from "../mechanics/catalog.ts"
import { estopPart } from "../mechanics/safety.ts"
import type { Mechanics, MotionTargets, Mount } from "../mechanics/types.ts"

// A competition's robot rules as checks (catalog/rules/<id>.json): every limit cited to its clause and page in the
// official rules. A design opts in with motion.rules (the architect sets it when the brief names the competition).
// What the model can't see yet is listed as not checked, never passed.

type Cite = { url: string; where: string }
type Limit<T> = { value: T; unit: string | null; source: Cite }
export interface RuleSet {
	id: string
	title: string
	document: { title: string; url: string }
	limits: {
		startPerimeterMm: Limit<number>
		deployedPerimeterMm: Limit<number>
		heightMm: Limit<number>
		estopTopMm: Limit<number>
		estopAboveRobotMm: Limit<number>
		estopMinDiaMm: Limit<number>
		estopColour: Limit<string>
		maxVoltageV: Limit<number>
		cordMinMm: Limit<number>
		matchS: Limit<number>
		avoidance: Limit<boolean>
	}
	notChecked: { rule: string; why: string }[]
}

export const RULE_SETS = ["eurobot-2026"] as const

export function loadRules(root: string, id: string): RuleSet | null {
	const f = join(root, "catalog", "rules", `${id}.json`)
	return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as RuleSet) : null
}

export interface RuleFinding {
	rule: string
	message: string
	affects: ("mechanics" | "architect" | "parts")[]
}
export interface RuleFigure {
	check: string
	value: string
	limit: string
	ok: boolean
	note?: string
	sources?: { mpn: string; field: string; url: string; where: string }[]
}

// The perimeter of the convex shell of the robot seen from above (F.3): the hull of every mount's footprint.
export function hullPerimeterMm(ms: Mount[]): number {
	const pts: [number, number][] = []
	for (const m of ms) {
		const hx = m.sizeMm[0] / 2, hy = m.sizeMm[1] / 2
		pts.push([m.xMm - hx, m.yMm - hy], [m.xMm + hx, m.yMm - hy], [m.xMm + hx, m.yMm + hy], [m.xMm - hx, m.yMm + hy])
	}
	const p = [...new Map(pts.map((q) => [`${q[0]},${q[1]}`, q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
	if (p.length < 3) return 0
	const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
	const half = (list: [number, number][]) => {
		const h: [number, number][] = []
		for (const q of list) {
			while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop()
			h.push(q)
		}
		return h.slice(0, -1)
	}
	const hull = [...half(p), ...half([...p].reverse())]
	return hull.reduce((t, q, i) => t + Math.hypot(hull[(i + 1) % hull.length][0] - q[0], hull[(i + 1) % hull.length][1] - q[1]), 0)
}

// The robot's top without its emergency stop's head: the highest mount, and the deck the button stands through with its
// collar (mechanics.safety.estop: zMm + collarMm). An ESTIMATE from below: boards count as bare 1.6 mm slabs, so their
// tallest parts (a header, a bought computer's heat sink) and the team's mechanism aren't in it.
export function robotTopMm(ms: Mount[], mech?: Mechanics): number {
	const e = mech?.safety?.estop
	return Math.max(0, ...ms.filter((m) => m.what !== "estop").map((m) => m.zMm + m.sizeMm[2] / 2), e ? e.at.zMm + (e.collarMm ?? 0) : 0)
}

export function ruleChecks(rules: RuleSet, motion: MotionTargets, mech: Mechanics, ms: Mount[], pack: BatteryPack, cat: MechCatalog, figures: RuleFigure[] = []): RuleFinding[] {
	const L = rules.limits
	const out: RuleFinding[] = []
	const r1 = (x: number) => Math.round(x * 10) / 10
	const clause = (l: Limit<unknown>) => l.source.where.split(",")[0]
	const fig = (check: string, value: string, l: Limit<unknown>, ok: boolean, note?: string) => figures.push({ check: `${rules.id}: ${check}`, value, limit: `${l.value}${l.unit ? ` ${l.unit}` : ""} (${clause(l)})`, ok, ...(note ? { note } : {}), sources: [{ mpn: rules.document.title, field: check, url: l.source.url, where: l.source.where }] })

	// F.3: the perimeter at the start.
	const perimeter = hullPerimeterMm(ms)
	fig("Start perimeter", `${Math.round(perimeter)} mm`, L.startPerimeterMm, perimeter <= L.startPerimeterMm.value, "the convex shell of every part seen from above")
	if (perimeter > L.startPerimeterMm.value)
		out.push({ rule: clause(L.startPerimeterMm), message: `the robot's outline seen from above is ${Math.round(perimeter)} mm around, over the ${L.startPerimeterMm.value} mm ${rules.document.title} allows at the start (${L.startPerimeterMm.source.where}): shrink the plate or the track (a ${L.startPerimeterMm.value / 4} × ${L.startPerimeterMm.value / 4} mm square is the most a square robot may be)`, affects: ["mechanics"] })

	// F.3: the height, and the e-stop's allowance above it (F.4.c).
	const top = robotTopMm(ms, mech)
	fig("Height", `${r1(top)} mm`, L.heightMm, top <= L.heightMm.value, "estimate: the tallest part; parts on the boards and the team's mechanism not counted")
	if (top > L.heightMm.value) out.push({ rule: clause(L.heightMm), message: `the robot stands ${r1(top)} mm tall, over the ${L.heightMm.value} mm limit (${L.heightMm.source.where}): lower it`, affects: ["mechanics"] })

	// F.4.c: a red emergency stop, at least 20 mm across, on top.
	const e = mech.safety?.estop
	const button = e ? estopPart(cat, e.part) : undefined
	if (!e) out.push({ rule: clause(L.estopMinDiaMm), message: `${rules.document.title} asks for a red emergency stop button at least ${L.estopMinDiaMm.value} mm across, on top (${L.estopMinDiaMm.source.where}): add mechanics.safety.estop with a catalog button (catalog/mechanics.json safety)`, affects: ["mechanics"] })
	else if (button) {
		fig("E-stop diameter", `${button.headMm} mm`, L.estopMinDiaMm, button.headMm >= L.estopMinDiaMm.value)
		if (button.headMm < L.estopMinDiaMm.value) out.push({ rule: clause(L.estopMinDiaMm), message: `the emergency stop's head is ${button.headMm} mm across, under the ${L.estopMinDiaMm.value} mm the rules ask (${L.estopMinDiaMm.source.where}): pick a bigger button`, affects: ["mechanics"] })
		if (button.colour !== L.estopColour.value) out.push({ rule: clause(L.estopColour), message: `the emergency stop is ${button.colour}; the rules ask for ${L.estopColour.value} (${L.estopColour.source.where})`, affects: ["mechanics"] })
		const estopTop = e.at.zMm + button.aboveMm
		fig("E-stop top", `${r1(estopTop)} mm`, L.estopTopMm, estopTop <= L.estopTopMm.value, `at most ${L.estopAboveRobotMm.value} mm over the rest of the robot (${clause(L.estopAboveRobotMm)}): ${r1(Math.min(L.estopTopMm.value, top + L.estopAboveRobotMm.value))} mm here`)
		if (estopTop > L.estopTopMm.value) out.push({ rule: clause(L.estopTopMm), message: `the emergency stop's top is ${r1(estopTop)} mm up, over the ${L.estopTopMm.value} mm the rules tolerate (${L.estopTopMm.source.where}): lower its deck (mechanics.safety.estop.at.zMm) to at most ${r1(L.estopTopMm.value - button.aboveMm)} mm`, affects: ["mechanics"] })
		else if (estopTop > top + L.estopAboveRobotMm.value) {
			// The head stands aboveMm proud of its deck: a printed collar around it brings the robot's own top within reach.
			const collar = Math.ceil(estopTop - L.estopAboveRobotMm.value - e.at.zMm)
			out.push({ rule: clause(L.estopAboveRobotMm), message: `the emergency stop stands ${r1(estopTop - top)} mm over the rest of the robot (${r1(top)} mm), more than the ${L.estopAboveRobotMm.value} mm the rules allow (${L.estopAboveRobotMm.source.where}); its head is ${button.aboveMm} mm proud of its deck, so set mechanics.safety.estop.collarMm to at least ${collar} (a printed ring around it, still leaving the head free to hit)`, affects: ["mechanics"] })
		}
	}

	// F.4.b: at most 48 V on board.
	fig("Voltage", `${pack.fullV} V`, L.maxVoltageV, pack.fullV <= L.maxVoltageV.value, `${pack.mpn.split(" ")[0]} full`)
	if (pack.fullV > L.maxVoltageV.value) out.push({ rule: clause(L.maxVoltageV), message: `the pack reaches ${pack.fullV} V, over the ${L.maxVoltageV.value} V the rules allow on board (${L.maxVoltageV.source.where})`, affects: ["mechanics"] })

	// F.6: a pull-cord start, the cord at least 500 mm; H.3: the robot stops after the match.
	const st = mech.safety?.start
	if (!st) out.push({ rule: clause(L.cordMinMm), message: `${rules.document.title} allows only a pull-cord start (${L.cordMinMm.source.where}): add mechanics.safety.start {connector, cordMm, matchS: ${L.matchS.value}} with its plug (role start)`, affects: ["mechanics"] })
	else {
		fig("Start cord", `${st.cordMm} mm`, L.cordMinMm, st.cordMm >= L.cordMinMm.value)
		if (st.cordMm < L.cordMinMm.value) out.push({ rule: clause(L.cordMinMm), message: `the start cord is ${st.cordMm} mm; the rules ask for at least ${L.cordMinMm.value} mm (${L.cordMinMm.source.where}): set mechanics.safety.start.cordMm to ${L.cordMinMm.value} or more`, affects: ["mechanics"] })
		fig("Match stop", st.matchS ? `${st.matchS} s` : "never", L.matchS, !!st.matchS && st.matchS <= L.matchS.value)
		if (!st.matchS || st.matchS > L.matchS.value) out.push({ rule: clause(L.matchS), message: `the firmware ${st.matchS ? `stops the robot ${st.matchS} s after the start` : "never stops the robot on its own"}; the rules stop every actuator at ${L.matchS.value} s (${L.matchS.source.where}): set mechanics.safety.start.matchS to ${L.matchS.value}`, affects: ["mechanics"] })
	}

	// F.6: it detects the opponent.
	if (L.avoidance.value && !mech.sensor) out.push({ rule: clause(L.avoidance), message: `the rules require a system that detects the opposing robot (${L.avoidance.source.where}): the robot has no distance sensor`, affects: ["mechanics"] })
	void motion
	return out
}

// The rule set a design asked for, or null.
export function rulesFor(root: string, motion: MotionTargets | undefined): RuleSet | null {
	return motion?.rules ? loadRules(root, motion.rules) : null
}
