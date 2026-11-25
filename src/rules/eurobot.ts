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
		// F.4.b lithium batteries: the bag route (value "fireproof-bag"), with the exemptions in its source.
		lithiumBattery?: Limit<string>
		cordMinMm: Limit<number>
		matchS: Limit<number>
		avoidance: Limit<boolean>
		beaconTopMm: Limit<number> & { tolerance: number }
		beaconMinMm: Limit<number>
		beaconMaxMm: Limit<number>
		beaconCircleMm: Limit<number>
		beaconLoadG: Limit<number>
		stickerWidthMm: Limit<number>
		stickerHeightMm: Limit<number>
		// The year's playing area (its theme rules, not the general ones) and its walls' thickness: the robot's Nav2 map.
		table?: Limit<[number, number]> & { wallMm: number }
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

// The margin a start perimeter keeps under the limit for homologation: an ESTIMATE (a tyre's bulge, a cable's bend,
// the referee's measuring), about 1 % of the 1200 mm.
export const PERIMETER_MARGIN_MM = 10

// The robot's size across seen from above (x, y): every mount's footprint.
export function hullExtentMm(ms: Mount[]): [number, number] {
	if (!ms.length) return [0, 0]
	const xs = ms.flatMap((m) => [m.xMm - m.sizeMm[0] / 2, m.xMm + m.sizeMm[0] / 2]), ys = ms.flatMap((m) => [m.yMm - m.sizeMm[1] / 2, m.yMm + m.sizeMm[1] / 2])
	return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
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
	return Math.max(0, ...ms.filter((m) => m.what !== "estop" && !m.what.startsWith("beacon")).map((m) => m.zMm + m.sizeMm[2] / 2), e ? e.at.zMm + (e.collarMm ?? 0) : 0)
}

export function ruleChecks(rules: RuleSet, motion: MotionTargets, mech: Mechanics, ms: Mount[], pack: BatteryPack, cat: MechCatalog, figures: RuleFigure[] = []): RuleFinding[] {
	const L = rules.limits
	const out: RuleFinding[] = []
	const r1 = (x: number) => Math.round(x * 10) / 10
	const clause = (l: Limit<unknown>) => l.source.where.split(",")[0]
	const fig = (check: string, value: string, l: Limit<unknown>, ok: boolean, note?: string) => figures.push({ check: `${rules.id}: ${check}`, value, limit: `${l.value}${l.unit ? ` ${l.unit}` : ""} (${clause(l)})`, ok, ...(note ? { note } : {}), sources: [{ mpn: rules.document.title, field: check, url: l.source.url, where: l.source.where }] })

	// F.3: the perimeter at the start, with a margin for homologation (real run 20b's review: a robot sized to the limit
	// fails on a tyre's bulge, a cable or the referee's tape). The figure shows the margin and the size across, so the
	// reviewer reads the hull's own numbers rather than the motion target's.
	const perimeter = hullPerimeterMm(ms)
	const margin = L.startPerimeterMm.value - perimeter
	const [ax, ay] = hullExtentMm(ms)
	fig("Start perimeter", `${Math.round(perimeter)} mm (${Math.round(margin)} mm under; ${Math.round(ax)} × ${Math.round(ay)} mm across)`, L.startPerimeterMm, margin >= PERIMETER_MARGIN_MM, `the convex shell of every part seen from above; at least ${PERIMETER_MARGIN_MM} mm under the limit kept for homologation`)
	if (perimeter <= L.startPerimeterMm.value && margin < PERIMETER_MARGIN_MM)
		out.push({ rule: clause(L.startPerimeterMm), message: `the robot's outline seen from above is ${Math.round(perimeter)} mm around, only ${Math.round(margin)} mm under the ${L.startPerimeterMm.value} mm limit (${L.startPerimeterMm.source.where}): keep at least ${PERIMETER_MARGIN_MM} mm for homologation (a tyre's bulge, a cable, the referee's tape): shrink the plate or the track a little`, affects: ["mechanics"] })
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

	// F.4.b: a lithium pack is LiFePO4, or a manufacturer's cased battery with its own BMS, or kept permanently in a certified
	// fireproof bag (with a charger submitted for homologation, checked at the event). Run cc-eurobot-15's review: a bare
	// pouch on the plate (16 Nov 2026).
	if (L.lithiumBattery) {
		const exempt = pack.chemistry === "LiFePO4" || (pack.bms === true && pack.manufacturerCase === true)
		const bagged = mech.battery.enclosure === "fireproof-bag"
		const lithium = pack.chemistry !== "NiMH"
		fig("Lithium battery", exempt ? (pack.chemistry === "LiFePO4" ? "LiFePO4" : "maker's BMS and case") : bagged ? "fireproof bag" : "bare pack", L.lithiumBattery, !lithium || exempt || bagged, "charger: to homologation")
		if (lithium && !exempt && !bagged)
			out.push({ rule: clause(L.lithiumBattery), message: `the ${pack.mpn.split(" ")[0]} is a bare lithium pack${pack.bms ? " (its BMS is on a pouch, not a manufacturer's cased battery)" : " with no BMS"}: keep it permanently in a certified fireproof bag (mechanics.battery.enclosure "fireproof-bag") and submit its charger for homologation, or pick a LiFePO4 pack or a manufacturer's cased battery with its BMS (${L.lithiumBattery.source.where.slice(0, 60)}…)`, affects: ["mechanics"] })
	}

	// F.6: a pull-cord start, the cord at least 500 mm; H.3: the robot stops after the match.
	const st = mech.safety?.start
	if (!st) out.push({ rule: clause(L.cordMinMm), message: `${rules.document.title} allows only a pull-cord start (${L.cordMinMm.source.where}): add mechanics.safety.start {connector, cordMm, matchS: ${L.matchS.value}} with its plug (role start)`, affects: ["mechanics"] })
	else {
		fig("Start cord", `${st.cordMm} mm`, L.cordMinMm, st.cordMm >= L.cordMinMm.value)
		if (st.cordMm < L.cordMinMm.value) out.push({ rule: clause(L.cordMinMm), message: `the start cord is ${st.cordMm} mm; the rules ask for at least ${L.cordMinMm.value} mm (${L.cordMinMm.source.where}): set mechanics.safety.start.cordMm to ${L.cordMinMm.value} or more`, affects: ["mechanics"] })
		fig("Match stop", st.matchS ? `${st.matchS} s` : "never", L.matchS, !!st.matchS && st.matchS <= L.matchS.value)
		if (!st.matchS || st.matchS > L.matchS.value) out.push({ rule: clause(L.matchS), message: `the firmware ${st.matchS ? `stops the robot ${st.matchS} s after the start` : "never stops the robot on its own"}; the rules stop every actuator at ${L.matchS.value} s (${L.matchS.source.where}): set mechanics.safety.start.matchS to ${L.matchS.value}`, affects: ["mechanics"] })
	}

	// F.6: the support for the opponent's beacon: its top 430 ± 5 mm up, 70 mm to 100 mm across, within the 200 mm
	// circle around the robot's centre, holding 400 g (F.3's height leaves its mast out).
	const b = mech.beacon
	if (!b) out.push({ rule: clause(L.beaconTopMm), message: `${rules.document.title} asks for a support for the opposing team's beacon (${L.beaconTopMm.source.where}): add mechanics.beacon {at, topMm: ${L.beaconTopMm.value}, sizeMm (${L.beaconMinMm.value} to ${L.beaconMaxMm.value}), mastWallMm, loadG: ${L.beaconLoadG.value}}`, affects: ["mechanics"] })
	else {
		const off = Math.abs(b.topMm - L.beaconTopMm.value)
		fig("Beacon support top", `${b.topMm} mm`, L.beaconTopMm, off <= L.beaconTopMm.tolerance, `± ${L.beaconTopMm.tolerance} mm`)
		if (off > L.beaconTopMm.tolerance) out.push({ rule: clause(L.beaconTopMm), message: `the beacon support's top is ${b.topMm} mm up; the rules ask for ${L.beaconTopMm.value} ± ${L.beaconTopMm.tolerance} mm (${L.beaconTopMm.source.where}): set mechanics.beacon.topMm to ${L.beaconTopMm.value}`, affects: ["mechanics"] })
		fig("Beacon support size", `${b.sizeMm} mm`, L.beaconMaxMm, b.sizeMm >= L.beaconMinMm.value && b.sizeMm <= L.beaconMaxMm.value, `at least a ${L.beaconMinMm.value} mm circle`)
		if (b.sizeMm < L.beaconMinMm.value || b.sizeMm > L.beaconMaxMm.value) out.push({ rule: clause(L.beaconMinMm), message: `the beacon support is ${b.sizeMm} mm across; the rules ask for ${L.beaconMinMm.value} mm (a circle) to ${L.beaconMaxMm.value} mm (a square) (${L.beaconMinMm.source.where})`, affects: ["mechanics"] })
		const reach = Math.hypot(Math.abs(b.at.xMm), Math.abs(b.at.yMm)) + (b.sizeMm / 2) * Math.SQRT2
		fig("Beacon support place", `${r1(reach)} mm from the centre`, L.beaconCircleMm, reach <= L.beaconCircleMm.value / 2, "its corners, seen from above")
		if (reach > L.beaconCircleMm.value / 2) out.push({ rule: clause(L.beaconCircleMm), message: `the beacon support reaches ${r1(reach)} mm from the robot's centre; it must lie within the circle of ${L.beaconCircleMm.value} mm diameter around it (at most ${L.beaconCircleMm.value / 2} mm from the centre) (${L.beaconCircleMm.source.where}): move it to the centre`, affects: ["mechanics"] })
		fig("Beacon support load", `${b.loadG} g`, L.beaconLoadG, b.loadG >= L.beaconLoadG.value, "counted in the mass and the tipping")
		if (b.loadG < L.beaconLoadG.value) out.push({ rule: clause(L.beaconLoadG), message: `the beacon support is designed for ${b.loadG} g; the rules ask it to hold ${L.beaconLoadG.value} g (${L.beaconLoadG.source.where}): set mechanics.beacon.loadG to ${L.beaconLoadG.value}, so the mass and the tipping count it`, affects: ["mechanics"] })
	}

	// F.6: a flat 100 × 70 mm space on a side face for the organisers' sticker, with nothing standing in front of it.
	const k = mech.sticker
	const sw = L.stickerWidthMm.value, sh = L.stickerHeightMm.value
	if (!k) out.push({ rule: clause(L.stickerWidthMm), message: `${rules.document.title} asks for a free ${sw} × ${sh} mm space on a side face (${L.stickerWidthMm.source.where}): add mechanics.sticker {face (front, rear, left or right), widthMm: ${sw}, heightMm: ${sh}}, a flat panel at that edge`, affects: ["mechanics"] })
	else {
		const big = Math.max(k.widthMm, k.heightMm) >= sw && Math.min(k.widthMm, k.heightMm) >= sh
		fig("Sticker space", `${k.widthMm} × ${k.heightMm} mm on the ${k.face}`, L.stickerWidthMm, big, `at least ${sw} × ${sh} mm`)
		if (!big) out.push({ rule: clause(L.stickerWidthMm), message: `the sticker space is ${k.widthMm} × ${k.heightMm} mm; the rules ask for ${sw} × ${sh} mm (${L.stickerWidthMm.source.where}): make mechanics.sticker at least that`, affects: ["mechanics"] })
		// What stands in front of it (further out than the panel, over its width and height): a wheel on a side face, the
		// sensor on the front.
		const p = ms.find((m) => m.what === "sticker-panel")
		if (p) {
			const outward = (m: Mount) => (k.face === "rear" ? m.xMm - m.sizeMm[0] / 2 < p.xMm - p.sizeMm[0] / 2 : k.face === "front" ? m.xMm + m.sizeMm[0] / 2 > p.xMm + p.sizeMm[0] / 2 : k.face === "left" ? m.yMm + m.sizeMm[1] / 2 > p.yMm + p.sizeMm[1] / 2 : m.yMm - m.sizeMm[1] / 2 < p.yMm - p.sizeMm[1] / 2)
			const across = (m: Mount) => (k.face === "rear" || k.face === "front" ? Math.abs(m.yMm - p.yMm) < (m.sizeMm[1] + p.sizeMm[1]) / 2 : Math.abs(m.xMm - p.xMm) < (m.sizeMm[0] + p.sizeMm[0]) / 2)
			const up = (m: Mount) => Math.abs(m.zMm - p.zMm) < (m.sizeMm[2] + p.sizeMm[2]) / 2
			// Overlapping it (the sensor at the front edge stands where a front panel would) or standing out in front of it.
			const overlap = (m: Mount) => Math.abs(m.xMm - p.xMm) < (m.sizeMm[0] + p.sizeMm[0]) / 2 && Math.abs(m.yMm - p.yMm) < (m.sizeMm[1] + p.sizeMm[1]) / 2 && up(m)
			const hide = ms.filter((m) => m !== p && m.what !== "plate" && (overlap(m) || (outward(m) && across(m) && up(m))))
			if (hide.length) out.push({ rule: clause(L.stickerWidthMm), message: `${hide.map((m) => m.what.replace(":", " ")).join(", ")} ${hide.length === 1 ? "stands" : "stand"} in front of the sticker panel on the ${k.face}: the space must be left free (${L.stickerWidthMm.source.where}): put the sticker on another face`, affects: ["mechanics"] })
		}
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
