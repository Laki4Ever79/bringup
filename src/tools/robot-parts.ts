// A robot's bought mechanical parts, the parts list beside the boards' (agents/bom.ts): the motors, wheels, caster,
// battery and distance sensor the contract's mechanics name, how many of each, where to buy them (catalog/
// mechanics.json "buy") and, in a live run, each shop's own price, stock and lead time (offers.ts). Only what a shop
// states is used: a shop that refuses or publishes nothing leaves that line "not checked", named in the summary.
import { byMpn, loadMechCatalog, type MechCatalog } from "../mechanics/catalog.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { checkOffer, type OfferCheck } from "./offers.ts"
import { chassisSpec, type ChassisSpec } from "./chassis.ts"
import type { HardwarePart } from "../mechanics/catalog.ts"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "../..")

export interface BuyLink {
	supplier: string
	url: string
	packQty?: number // parts in one pack (wheels come in pairs); 1 when absent
}

export interface RobotPartLine {
	item: "motor" | "wheel" | "caster" | "battery" | "distance sensor" | "board screw" | "caster screw" | "caster nut"
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
	unitUsd: number | null // one pack's price, in USD only (another currency is noted, not converted)
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

// The parts the mechanics name, in build order. A part the catalog doesn't have is listed with no shop link (the
// mech-fit check names it to the mechanics engineer).
export function robotPartLines(s: ContractSnapshot, cat: MechCatalog = loadMechCatalog(ROOT)): RobotPartLine[] {
	const m = s.values.mechanics
	if (!m) return []
	const line = (item: RobotPartLine["item"], list: WithBuy[], mpn: string | undefined, qty: number): RobotPartLine | null => {
		if (!mpn) return null
		const part = byMpn(list as never[], mpn) as WithBuy | undefined
		const buy = part?.buy ?? []
		const pack = buy[0]?.packQty ?? 1
		return { item, mpn: part?.mpn ?? mpn, qty, packs: Math.ceil(qty / pack), buy }
	}
	const drive = m.drive as { motor?: string; wheel?: string; caster?: string }
	// The fasteners, counted from the chassis the robot gets (chassis.ts): a screw per board hole, the board's own (the
	// case's M2 self-tapping screw into the standoff's pilot), and a machine screw and a nut per caster hole.
	const spec = chassisSpec(s)
	const hw = (cat.hardware ?? []) as (HardwarePart & WithBuy)[]
	const boardScrew = spec && hw.find((h) => h.kind === "screw" && h.selfTapping && h.threadMm === screwFor(spec.boardScrew.boardHoleMm))
	const casterScrew = spec && hw.find((h) => h.kind === "screw" && !h.selfTapping && h.threadMm === screwFor(spec.caster.holeDiaMm))
	const casterNut = casterScrew && hw.find((h) => h.kind === "nut" && h.threadMm === casterScrew.threadMm)
	const boardHoles = spec ? spec.boards.reduce((n, b) => n + b.holes.length, 0) : 0
	const casterHoles = spec ? spec.caster.holesMm.length : 0
	return [
		line("motor", cat.motors as WithBuy[], drive.motor, 2),
		line("wheel", cat.wheels as WithBuy[], drive.wheel, 2),
		line("caster", cat.casters as WithBuy[], drive.caster, 1),
		line("battery", cat.batteries as WithBuy[], m.battery?.pack, 1),
		line("distance sensor", cat.sensors as WithBuy[], m.sensor?.module, 1),
		boardScrew && boardHoles ? line("board screw", hw, boardScrew.mpn, boardHoles) : null,
		casterScrew && casterHoles ? line("caster screw", hw, casterScrew.mpn, casterHoles) : null,
		casterNut && casterHoles ? line("caster nut", hw, casterNut.mpn, casterHoles) : null,
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
		"the sensor bracket: the printed bracket has no screw holes for the distance sensor's breakout yet (it has two mounting holes)",
		"the motors sit in printed cradles under the plate, held by shape: no clamp or screw yet",
		"the battery sits between two printed rails: no strap or holder yet",
		"cables (motor leads, the sensor's STEMMA QT cable, the battery lead) and their crimp housings aren't listed yet",
	]
}

// Each fastener fits the hole it goes in: a machine screw passes its clearance hole, the board's screw the board's hole.
export function hardwareFit(s: ContractSnapshot, spec: ChassisSpec | null = chassisSpec(s), cat: MechCatalog = loadMechCatalog(ROOT)): string[] {
	if (!spec) return []
	const out: string[] = []
	const lines = robotPartLines(s, cat)
	const thread = (item: string) => (cat.hardware ?? []).find((h) => h.mpn === lines.find((l) => l.item === item)?.mpn)?.threadMm
	const caster = thread("caster screw")
	if (caster !== undefined && spec.caster.holeDiaMm <= caster) out.push(`caster hole ${spec.caster.holeDiaMm} mm is smaller than the M${caster} screw`)
	const board = thread("board screw")
	if (board !== undefined && spec.boardScrew.boardHoleMm <= board) out.push(`board hole ${spec.boardScrew.boardHoleMm} mm is smaller than the M${board} screw`)
	if (board !== undefined && spec.boardScrew.pilotMm >= board) out.push(`the standoff's ${spec.boardScrew.pilotMm} mm pilot leaves the M${board} self-tapping screw nothing to cut`)
	return out
}

function fromCheck(l: RobotPartLine, link: BuyLink, c: OfferCheck): RobotPartCheck {
	const o = c.offer
	const usd = o && o.price !== null && (o.currency ?? "USD").toUpperCase() === "USD" ? o.price : null
	const status: RobotLineStatus = c.status !== "live" ? "not checked" : o!.availability === "unknown" ? "stock unknown" : o!.availability
	const packs = Math.ceil(l.qty / (link.packQty ?? 1))
	const currencyNote = o && o.price !== null && usd === null ? ` · ${o.price} ${o.currency} (not converted)` : ""
	return {
		...l,
		packs,
		status,
		supplier: link.supplier,
		url: link.url,
		unitUsd: usd,
		lineUsd: usd === null ? null : Math.round(usd * packs * 100) / 100,
		leadDays: o?.leadDays ?? null,
		checkedAt: c.checkedAt,
		note: c.note + currencyNote,
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
		let first: RobotPartCheck | null = null
		let found: RobotPartCheck | null = null
		for (const link of l.buy) {
			const c = fromCheck(l, link, await checkOffer(link.url, { fetch: opts.fetch, now: opts.now }))
			first ??= c
			if (c.status !== "not checked") {
				found = c
				break
			}
		}
		checked.push(found ?? first!)
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
