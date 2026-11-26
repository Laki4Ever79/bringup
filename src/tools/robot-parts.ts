// A robot's bought mechanical parts, the parts list beside the boards' (agents/bom.ts): the motors, wheels, caster,
// battery and distance sensor the contract's mechanics name, how many of each, where to buy them (catalog/
// mechanics.json "buy") and, in a live run, each shop's own price, stock and lead time (offers.ts). Only what a shop
// states is used: a shop that refuses or publishes nothing leaves that line "not checked", named in the summary.
import { byMpn, loadMechCatalog, type MechCatalog } from "../mechanics/catalog.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import type { ArmSpec } from "../arm/types.ts"
import { loadCatalog } from "./parts-search.ts"
import { checkOffer, readableShop, shopHost, UNREADABLE_SHOPS, type OfferCheck } from "./offers.ts"
import { boardScrew, chassisSpec, CRADLE_WALL_MM, robotCables, type ChassisSpec } from "./chassis.ts"
import type { HardwarePart } from "../mechanics/catalog.ts"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "../..")

export interface BuyLink {
	supplier: string
	url: string
	packQty?: number // parts in one pack (wheels come in pairs); 1 when absent
	// The shop's price as read on its page on a date, for a shop whose page publishes no offer data (or blocks a check):
	// used only when the live check gives no price, and labelled "listed" with its date.
	listed?: { price: number; currency: string; checked: string; note?: string }
}
// Currency to USD for listed prices: ESTIMATES (the rate moves), named in each line's note.
export const USD_PER = { USD: 1, EUR: 1.08, GBP: 1.27 } as Record<string, number>

const SYMBOL: Record<string, string> = { GBP: "£", EUR: "€" }
// A price as the shop states it: £19.20, €12.50, or 99.20 PLN.
export const money = (price: number, currency: string) => (SYMBOL[currency] ? `${SYMBOL[currency]}${price.toFixed(2)}` : `${price.toFixed(2)} ${currency}`)

export interface RobotPartLine {
	item: "motor" | "wheel" | "caster" | "battery" | "distance sensor" | "board screw" | "caster screw" | "caster nut" | "sensor screw" | "sensor nut" | "motor bracket" | "clamp screw" | "sensor cable" | "motor lead" | "servo" | "power brick" | DriveTrainItem
	mpn: string
	qty: number
	packs: number // packs to buy at the first link's pack size
	buy: BuyLink[]
}

export type RobotLineStatus = "in stock" | "out of stock" | "backorder" | "pre-order" | "discontinued" | "stock unknown" | "not checked"

export interface RobotPartCheck extends RobotPartLine {
	status: RobotLineStatus
	supplier: string | null
	url: string | null
	unitUsd: number | null // one pack's price in USD: the shop's own, or converted from its currency at USD_PER (an ESTIMATE)
	shopPrice?: { price: number; currency: string } | null // the shop's price when it isn't in USD, as the shop states it
	lineUsd: number | null // unitUsd × packs
	leadDays: number | null
	checkedAt: string | null
	note: string
}

export interface RobotParts {
	lines: RobotPartCheck[]
	knownUsd: number | null // the sum of the lines a shop priced; null when none was
	warn: boolean // a line is out of stock, discontinued or on backorder
	summary: string
	live: boolean
	// What the design doesn't fasten yet (robotPartNotes); bom.ts adds them.
	notes?: string[]
}

type WithBuy = { mpn: string; buy?: BuyLink[] }

// A bought drive-train part's line name, by its kind (mechanics.driveTrain, drivetrain.ts). A mesh is a pairing, not
// a part.
const DRIVE_TRAIN_ITEM = { shaft: "shaft", gear: "gear", pulley: "pulley", belt: "belt", sprocket: "sprocket", chain: "chain", bearing: "bearing", coupler: "coupler", leadscrew: "lead screw", leadnut: "lead nut" } as const
type DriveTrainItem = (typeof DRIVE_TRAIN_ITEM)[keyof typeof DRIVE_TRAIN_ITEM]

// An arm's bought parts (values.arm, src/arm/types.ts): its servos, one line per model, counted over the joints and
// the gripper (three MG996R and three SG90 for the phase-1 arm), and the mains brick for its DC input: the catalog's
// first brick at the input's voltage with at least its current. Each servo's horns and screws come in its box, and each
// joint turns on its servo's own bearing (py/arm.py), so there are no separate horns or bearings to buy. Its printed
// parts are the package's printed/.
// The board's DC input jack: the design's part whose board-catalog entry names the plug it takes (plugMm).
export function inputJack(s: ContractSnapshot): { mpn: string; plugMm: [number, number] } | null {
	const board = loadCatalog(ROOT) as unknown as { mpn: string; plugMm?: [number, number] }[]
	for (const p of s.values.parts ?? []) {
		const c = board.find((x) => x.mpn === p.mpn)
		if (c?.plugMm) return { mpn: p.mpn, plugMm: c.plugMm }
	}
	return null
}

// A brick's nominal voltage may differ from the input's by this much (a 19 V brick for a 19.5 V input would not).
export const BRICK_VOLTS_TOL = 0.25

export function armPartLines(arm: ArmSpec, cat: MechCatalog = loadMechCatalog(ROOT), jack: { mpn: string; plugMm: [number, number] } | null = null): RobotPartLine[] {
	const count = new Map<string, number>()
	for (const mpn of [...arm.joints.map((j) => j.servo), arm.gripper.servo]) count.set(mpn, (count.get(mpn) ?? 0) + 1)
	const servos = [...count].map(([mpn, qty]) => {
		const part = byMpn((cat.servos ?? []) as never[], mpn) as WithBuy | undefined
		const buy = part?.buy ?? []
		return { item: "servo" as const, mpn: part?.mpn ?? mpn, qty, packs: Math.ceil(qty / (buy[0]?.packQty ?? 1)), buy } as RobotPartLine
	})
	const want = arm.input
	// The brick: the input's voltage (within BRICK_VOLTS_TOL), at least its current, and the plug the board's jack takes
	// (its catalog plugMm), so a 5.5 x 2.1 mm plug never goes to a 2.5 mm jack. Without a known jack, no brick is picked.
	const plugOk = (b: { plugMm: [number, number] }) => jack !== null && b.plugMm[0] === jack.plugMm[0] && b.plugMm[1] === jack.plugMm[1]
	const brick = want.kind === "dc-brick" ? (cat.powerBricks ?? []).find((b) => Math.abs(b.volts - want.volts) <= BRICK_VOLTS_TOL && b.amps >= want.amps && plugOk(b)) : undefined
	// No brick in the catalog fits: the line names what to buy, with no shop link (the parts list says so).
	const plug = jack ? `${jack.plugMm[0]} x ${jack.plugMm[1]} mm plug (the board's ${jack.mpn})` : "the plug the board's input jack takes"
	const brickLine: RobotPartLine = brick ? { item: "power brick", mpn: brick.mpn, qty: 1, packs: 1, buy: brick.buy ?? [] } : { item: "power brick", mpn: `${want.volts} V ${want.amps} A DC brick, ${plug}`, qty: 1, packs: 1, buy: [] }
	return [...servos, brickLine]
}

// The parts the mechanics name, in build order. A part the catalog doesn't have is listed with no shop link (the
// mech-fit check names it to the mechanics engineer).
export function robotPartLines(s: ContractSnapshot, cat: MechCatalog = loadMechCatalog(ROOT)): RobotPartLine[] {
	const m = s.values.mechanics
	// Whatever the design has: a mobile robot's mechanics, an arm, or both (an arm on a rover); later a CNC's.
	const arm = s.values.arm ? armPartLines(s.values.arm, cat, inputJack(s)) : []
	if (!m) return arm
	const line = (item: RobotPartLine["item"], list: WithBuy[], mpn: string | undefined, qty: number): RobotPartLine | null => {
		if (!mpn) return null
		const part = byMpn(list as never[], mpn) as WithBuy | undefined
		const buy = part?.buy ?? []
		const pack = buy[0]?.packQty ?? 1
		return { item, mpn: part?.mpn ?? mpn, qty, packs: Math.ceil(qty / pack), buy }
	}
	const drive = m.drive as { kind?: string; motor?: string; wheel?: string; caster?: string }
	// The fasteners, counted from the chassis the robot gets (chassis.ts): a screw per board hole, the board's own (the
	// case's M2 self-tapping screw into the standoff's pilot), and a machine screw and a nut per caster hole.
	const spec = chassisSpec(s)
	const hw = (cat.hardware ?? []) as (HardwarePart & WithBuy)[]
	// The board screws by thread: each board's hole picks its own (a Raspberry Pi's Ø2.7 mm takes M2.5, the designed
	// boards' M2). A HAT on spacers has no holes on the plate, so no screws here.
	const boardThreads = new Map<number, number>()
	for (const b of spec?.boards ?? []) {
		// The chassis' own choice (boardScrew), which drilled the standoff's pilot for it: one chooser, so the parts list
		// never names a screw the standoff wasn't made for (a ROCK 5B's Ø3.5 mm holes: M2.5, not an M3 the catalog lacks).
		const t = boardScrew(b.screwHoleMm ?? spec!.boardScrew.boardHoleMm).threadMm
		boardThreads.set(t, (boardThreads.get(t) ?? 0) + b.holes.length)
	}
	// The battery strap's two M2 self-tapping screws (py/chassis.py strap), the board screw's kind.
	if (spec) boardThreads.set(2, (boardThreads.get(2) ?? 0) + 2)
	const boardScrews = [...boardThreads].filter(([, n]) => n > 0).map(([t, n]) => ({ n, part: hw.find((h) => h.kind === "screw" && h.selfTapping && h.threadMm === t) }))
	const casterScrew = spec?.caster && hw.find((h) => h.kind === "screw" && !h.selfTapping && h.threadMm === screwFor(spec.caster!.holeDiaMm))
	const casterNut = casterScrew && hw.find((h) => h.kind === "nut" && h.threadMm === casterScrew.threadMm)
	// The distance sensor's breakout: a machine screw and a nut through each bracket hole (chassis.ts sensorHoles).
	const sensorHoleCount = spec?.sensor.holes.length ?? 0
	const sensorScrew = sensorHoleCount ? hw.find((h) => h.kind === "screw" && !h.selfTapping && h.threadMm === screwFor(spec!.sensor.holeDiaMm)) : undefined
	const sensorNut = sensorScrew && hw.find((h) => h.kind === "nut" && h.threadMm === sensorScrew.threadMm)
	const casterHoles = spec?.caster ? spec.caster.holesMm.length : 0
	// The cables, by length from the chassis (chassis.ts robotCables).
	const cables = spec ? robotCables(s, spec, cat.cables ?? []) : []
	const cableLine = (item: RobotPartLine["item"], kind: string) => {
		const got = cables.filter((c) => c.kind === kind && c.cable)
		return got.length ? line(item, (cat.cables ?? []) as WithBuy[], got.reduce((a, c) => (c.cable!.lengthMm > a.cable!.lengthMm ? c : a)).cable!.mpn, got.length) : null
	}
	// How the motors are held (chassis.ts motorMount): a bought bracket each (screws and nuts come with it), or a printed
	// clamp held by two of the board's M2 self-tapping screws.
	const bracketMotors = (spec?.motors ?? []).filter((x) => x.mount.kind === "bracket")
	const bracketMpn = bracketMotors[0]?.mount.kind === "bracket" ? bracketMotors[0].mount.mpn : undefined
	const clampScrews = (spec?.motors ?? []).reduce((n, x) => n + (x.mount.kind === "clamp" ? x.mount.screwHoles.length : 0), 0)
	const clampScrew = clampScrews ? hw.find((h) => h.kind === "screw" && h.selfTapping && h.threadMm === 2) : undefined
	// The bought drive-train parts: each one that names an mpn, counted by mpn (two 608ZZ bearings are one line of 2).
	// One without an mpn is printed or not chosen yet, and the drive-train checks speak for it.
	const driveTrain = new Map<string, { item: DriveTrainItem; n: number }>()
	for (const d of m.driveTrain ?? []) {
		if (d.kind === "mesh" || !d.mpn) continue
		const got = driveTrain.get(d.mpn)
		driveTrain.set(d.mpn, { item: DRIVE_TRAIN_ITEM[d.kind], n: (got?.n ?? 0) + 1 })
	}
	return [
		// A skid-steer rover: four motors and wheels, no caster.
		line("motor", cat.motors as WithBuy[], drive.motor, drive.kind === "skid4" ? 4 : 2),
		line("wheel", cat.wheels as WithBuy[], drive.wheel, drive.kind === "skid4" ? 4 : 2),
		drive.kind === "skid4" ? null : line("caster", cat.casters as WithBuy[], drive.caster, 1),
		line("battery", cat.batteries as WithBuy[], m.battery?.pack, 1),
		line("distance sensor", cat.sensors as WithBuy[], m.sensor?.module, 1),
		...boardScrews.map((x) => (x.part ? line("board screw", hw, x.part.mpn, x.n) : null)),
		casterScrew && casterHoles ? line("caster screw", hw, casterScrew.mpn, casterHoles) : null,
		casterNut && casterHoles ? line("caster nut", hw, casterNut.mpn, casterHoles) : null,
		sensorScrew ? line("sensor screw", hw, sensorScrew.mpn, sensorHoleCount) : null,
		sensorNut ? line("sensor nut", hw, sensorNut.mpn, sensorHoleCount) : null,
		cableLine("sensor cable", "stemma-qt"),
		cableLine("motor lead", "jst-ph-2-leads"),
		bracketMpn ? line("motor bracket", (cat.motorMounts ?? []) as WithBuy[], bracketMpn, bracketMotors.length) : null,
		clampScrew ? line("clamp screw", hw, clampScrew.mpn, clampScrews) : null,
		...[...driveTrain].map(([mpn, x]) => line(x.item, (cat.driveTrain ?? []) as WithBuy[], mpn, x.n)),
		...arm,
	].filter((l): l is RobotPartLine => l !== null)
}

// The metric screw a clearance hole is for: the largest M size whose screw passes it (M2 2.2 mm, M2.5 2.7, M3 3.2,
// M4 4.2-4.5, M5 5.3).
const M_SIZES = [2, 2.5, 3, 4, 5, 6]
function screwFor(holeMm: number): number {
	return [...M_SIZES].reverse().find((d) => d < holeMm) ?? M_SIZES[0]
}

// What the design doesn't fasten yet, said in the parts list instead of left out (the printed chassis holds these by
// shape alone today, py/chassis.py).
export function robotPartNotes(s: ContractSnapshot): string[] {
	if (!s.values.mechanics) return []
	return [
		...(chassisSpec(s)?.sensor.holes.length ? [] : ["the sensor bracket: no screw holes for the distance sensor's breakout (its catalog entry has no mounting holes, or none lands above the plate)"]),
		...((chassisSpec(s)?.motors ?? []).some((x) => x.mount.kind === "cradle-too-shallow") ? ["the motors: the printed cradle can't hold them at the design's axle height, and no bought bracket fits (the hardware check says what to change)"] : []),
		...(chassisSpec(s)?.beacon ? ["the beacon support's mast sections: a spigot into the section below and a socket on the plate, no glue or screw listed yet; its top's Velcro (hook side, Eurobot F.6) isn't in the parts list"] : []),
		...(() => {
			const spec = chassisSpec(s)
			const cables = spec ? robotCables(s, spec, loadMechCatalog(ROOT).cables ?? []) : []
			const short = cables.filter((c) => !c.cable).map((c) => `the ${c.what}'s cable from ${c.from} needs ${c.needMm} mm, longer than any in catalog/mechanics.json cables`)
			const leads = cables.filter((c) => c.kind === "jst-ph-2-leads").length
			if (spec && leads < spec.motors.length) short.push(`${spec.motors.length - leads} of the motors ha${spec.motors.length - leads === 1 ? "s" : "ve"} no 2-pin plug on the board for ${spec.motors.length - leads === 1 ? "its" : "their"} leads`)
			return cables.length ? short : ["cables: the chassis has no main board placed, so no cable is measured"]
		})(),
	]
}

// Each fastener fits the hole it goes in: a machine screw passes its clearance hole, the board's screw the board's hole.
export function hardwareFit(s: ContractSnapshot, spec: ChassisSpec | null = chassisSpec(s), cat: MechCatalog = loadMechCatalog(ROOT)): string[] {
	if (!spec) return []
	const out: string[] = []
	const lines = robotPartLines(s, cat)
	const thread = (item: string) => (cat.hardware ?? []).find((h) => h.mpn === lines.find((l) => l.item === item)?.mpn)?.threadMm
	const caster = thread("caster screw")
	if (caster !== undefined && spec.caster && spec.caster.holeDiaMm <= caster) out.push(`caster hole ${spec.caster.holeDiaMm} mm is smaller than the M${caster} screw`)
	// A motor nothing can hold at the design's axle height: the printed cradle needs its wall above the motor.
	for (const x of spec.motors) if (x.mount.kind === "cradle-too-shallow") out.push(`the ${x.side} motor's axle is ${x.axleDropMm} mm under the plate, but the printed cradle needs ${x.mount.needMm} mm (its ${CRADLE_WALL_MM} mm wall above the motor) and no bracket in catalog/mechanics.json motorMounts fits the motor at that height: raise the plate (clearanceMm) by ${+(x.mount.needMm - x.axleDropMm).toFixed(1)} mm or choose a motor a bracket fits`)
	const sensorT = thread("sensor screw")
	if (sensorT !== undefined && spec.sensor.holeDiaMm <= sensorT) out.push(`sensor bracket hole ${spec.sensor.holeDiaMm} mm is smaller than the M${sensorT} screw`)
	// Each board's screw (by its hole) against its hole and its standoff's pilot; a thread the catalog has no screw for is
	// said too, not left off the list.
	const threads = new Set(lines.filter((l) => l.item === "board screw").map((l) => (cat.hardware ?? []).find((h) => h.mpn === l.mpn)?.threadMm))
	for (const b of spec.boards.filter((x) => x.holes.length)) {
		const hole = b.screwHoleMm ?? spec.boardScrew.boardHoleMm, pilot = b.pilotMm ?? spec.boardScrew.pilotMm
		const t = boardScrew(hole).threadMm
		if (!threads.has(t)) { out.push(`${b.name}: no M${t} self-tapping screw in catalog/mechanics.json hardware for its ${hole} mm holes`); continue }
		if (hole <= t) out.push(`${b.name}: board hole ${hole} mm is smaller than the M${t} screw`)
		if (pilot >= t) out.push(`${b.name}: the standoff's ${pilot} mm pilot leaves the M${t} self-tapping screw nothing to cut`)
	}
	return out
}

// A bulk carton: far more parts than a robot build needs at a price that would distort its total (Fastener SuperStore's
// 3,000 screws for $108.09). A big cheap pack (Elecrow's 200 M2 screws for $2) is still a hobby buy.
const BULK_PACK = 100, BULK_USD = 20
const isBulk = (link: BuyLink, usd: number) => (link.packQty ?? 1) > BULK_PACK && usd > BULK_USD
function fromCheck(l: RobotPartLine, link: BuyLink, c: OfferCheck): RobotPartCheck {
	const o = c.offer
	const cur = (o?.currency ?? "USD").toUpperCase()
	// The shop's own price in its currency; another currency than USD is converted at USD_PER, an ESTIMATE, and the line
	// keeps the shop's figure beside it (The Pi Hut quotes in GBP: before 26 Nov 2026 those lines stayed unpriced).
	const rate = o && o.price !== null ? USD_PER[cur] : undefined
	const live = o && o.price !== null && rate !== undefined ? Math.round(o.price * rate * 100) / 100 : null
	const shopPrice = o && o.price !== null && cur !== "USD" ? { price: o.price, currency: cur } : null
	// A listed price (the catalog's, read on a date) when the page gave none; another currency at an estimated rate.
	const listedUsd = live === null && link.listed && USD_PER[link.listed.currency.toUpperCase()] ? Math.round(link.listed.price * USD_PER[link.listed.currency.toUpperCase()] * 100) / 100 : null
	const usd = live ?? listedUsd
	const listedNote = listedUsd !== null ? ` · listed ${link.listed!.price} ${link.listed!.currency} on ${link.listed!.checked}${link.listed!.currency.toUpperCase() === "USD" ? "" : ` (≈ $${listedUsd} at an estimated rate)`}${link.listed!.note ? `, ${link.listed!.note}` : ""}` : ""
	const status: RobotLineStatus = c.status !== "live" ? "not checked" : o!.availability === "unknown" ? "stock unknown" : o!.availability
	const packs = Math.ceil(l.qty / (link.packQty ?? 1))
	const currencyNote = o && o.price !== null && usd === null ? ` · ${o.price} ${o.currency} (not converted)` : shopPrice && live !== null ? ` · ${money(shopPrice.price, shopPrice.currency)} ≈ $${live.toFixed(2)}, estimate` : ""
	const bulkNote = usd !== null && isBulk(link, usd) ? ` · sold only by the carton of ${link.packQty} (${usd === null ? "price unknown" : `$${usd}`}): buy a small pack locally` : ""
	return {
		...l,
		packs,
		status,
		supplier: link.supplier,
		url: link.url,
		unitUsd: usd,
		shopPrice,
		// A shop that sells only bulk cartons (Fastener SuperStore: 3,000 screws for $108.09) prices a hobby build wrong:
		// such a line is left out of the total and says so (run 9's package, 16 Nov 2026: four M2.5 screws counted $432).
		lineUsd: usd === null || isBulk(link, usd) ? null : Math.round(usd * packs * 100) / 100,
		leadDays: o?.leadDays ?? null,
		checkedAt: c.checkedAt,
		note: c.note + (listedUsd !== null ? "" : currencyNote) + listedNote + bulkNote,
	}
}

// Each line's links in order until one shop answers with an Offer; the first link's refusal is kept when none does.
export async function checkRobotParts(lines: RobotPartLine[], opts: { live: boolean; fetch?: typeof fetch; now?: () => Date }): Promise<RobotParts> {
	const checked: RobotPartCheck[] = []
	for (const l of lines) {
		const blank = { status: "not checked" as const, supplier: l.buy[0]?.supplier ?? null, url: l.buy[0]?.url ?? null, unitUsd: null, lineUsd: null, leadDays: null, checkedAt: null }
		if (!l.buy.length) {
			checked.push({ ...l, ...blank, note: "no shop link in catalog/mechanics.json" })
			continue
		}
		if (!opts.live) {
			checked.push({ ...l, ...blank, note: "not checked (mock run)" })
			continue
		}
		// The first link in stock wins; past an out-of-stock answer the next shop or alternative is tried (run 9's
		// package, 16 Nov 2026: the 200 mm STEMMA QT cable was out, the 300 mm one in stock). Else the first answer.
		let first: RobotPartCheck | null = null
		let answered: RobotPartCheck | null = null
		let found: RobotPartCheck | null = null
		// Shops measured not to answer (UNREADABLE_SHOPS) aren't asked: when no other link is left, the line says why.
		const askable = l.buy.filter((b) => readableShop(b.url))
		if (!askable.length) {
			const h = shopHost(l.buy[0].url)
			checked.push({ ...l, ...blank, note: `not checked: ${h} ${UNREADABLE_SHOPS[h]}, and the catalog has no other shop for it` })
			continue
		}
		for (const link of askable) {
			const c = fromCheck(l, link, await checkOffer(link.url, { fetch: opts.fetch, now: opts.now }))
			first ??= c
			if (c.status !== "not checked") answered ??= c
			if (c.status === "in stock") {
				found = c
				break
			}
		}
		const pick = found ?? answered ?? first!
		checked.push(pick === first || !answered || pick === answered ? pick : { ...pick, note: `${pick.note} · ${first!.supplier}'s link: ${first!.status}` })
	}
	const priced = checked.filter((c) => c.lineUsd !== null)
	const knownUsd = priced.length ? Math.round(priced.reduce((s, c) => s + c.lineUsd!, 0) * 100) / 100 : null
	const items = (st: RobotLineStatus[]) => checked.filter((c) => st.includes(c.status)).map((c) => c.item)
	const bad = items(["out of stock", "discontinued", "backorder"])
	const unchecked = items(["not checked"])
	const leads = checked.map((c) => c.leadDays).filter((d): d is number => d !== null)
	const summary = !opts.live
		? `${checked.length} robot parts · not checked (mock run)`
		: [
				`${checked.length} robot parts`,
				knownUsd !== null ? `$${knownUsd.toFixed(2)} known for ${priced.length} of ${checked.length} lines` : "no shop stated a price",
				items(["in stock"]).length ? `${items(["in stock"]).length} in stock` : "",
				bad.length ? `out of stock: ${bad.join(", ")}` : "",
				unchecked.length ? `not checked: ${unchecked.join(", ")}` : "",
				leads.length ? `longest stated lead time ${Math.max(...leads)} days` : "no lead time stated",
			]
				.filter(Boolean)
				.join(" · ")
	return { lines: checked, knownUsd, warn: bad.length > 0, summary, live: opts.live }
}

// hardwareFit as violations: the mechanics engineer owns the parts the fasteners go through.
export function hardwareChecks(s: ContractSnapshot, spec?: ChassisSpec | null, cat?: MechCatalog): { kind: "hardware-misfit"; message: string; fields: ["mechanics"]; affects: ["mechanics"] }[] {
	return hardwareFit(s, spec === undefined ? chassisSpec(s) : spec, cat).map((message) => ({ kind: "hardware-misfit" as const, message: `fastener doesn't fit: ${message}`, fields: ["mechanics"] as ["mechanics"], affects: ["mechanics"] as ["mechanics"] }))
}
