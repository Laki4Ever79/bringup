// A robot's bought mechanical parts, the parts list beside the boards' (agents/bom.ts): the motors, wheels, caster,
// battery and distance sensor the contract's mechanics name, how many of each, where to buy them (catalog/
// mechanics.json "buy") and, in a live run, each shop's own price, stock and lead time (offers.ts). Only what a shop
// states is used: a shop that refuses or publishes nothing leaves that line "not checked", named in the summary.
import { byMpn, loadMechCatalog, type MechCatalog } from "../mechanics/catalog.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { checkOffer, type OfferCheck } from "./offers.ts"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "../..")

export interface BuyLink {
	supplier: string
	url: string
	packQty?: number // parts in one pack (wheels come in pairs); 1 when absent
}

export interface RobotPartLine {
	item: "motor" | "wheel" | "caster" | "battery" | "distance sensor"
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
	return [
		line("motor", cat.motors as WithBuy[], drive.motor, 2),
		line("wheel", cat.wheels as WithBuy[], drive.wheel, 2),
		line("caster", cat.casters as WithBuy[], drive.caster, 1),
		line("battery", cat.batteries as WithBuy[], m.battery?.pack, 1),
		line("distance sensor", cat.sensors as WithBuy[], m.sensor?.module, 1),
	].filter((l): l is RobotPartLine => l !== null)
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
