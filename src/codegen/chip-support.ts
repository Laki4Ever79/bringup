// A chip's support parts and wiring from its catalog entry (agreed with bringup-lead-3 for the CNC's stepper drivers,
// 26 Nov 2026; lead-2: one mechanism, not per-chip code). The entry carries:
//   "nets":    { "<own pin>": "<end>" }                       the chip's own pins joined to nets
//   "support": [ { "part", "a"/"b" | "pins", "count"?, "job", "bound"? } ]   the parts beside it
// An end is:
//   "GND"            ground
//   "$in" / "$out"   the net feeding the chip / the net it makes (the context decides: VIN_BRICK, VSERVO1, ...)
//   "$:<name>"       a net of this instance alone, "<ref>_<name>" (the switch node, the feedback node)
//   "@<name>"        a net every instance shares, "<name>" (one UART for every driver)
//   "rail:<name>"    a supply rail's net (rail:3V3)
//   "$ctx:<key>"     whatever end the context gives for <key> (an address strap to GND or to rail:3V3)
//   "-"              left open
//   "<own pin>"      (in a support's a/b/pins only) the chip's own pin: the reach check and the placer see that part as
//                    the pin's capacitor
// A support's "part" is a SUPPORT key (circuit.ts), a spec {kind, value, mpn, lcsc, footprint}, or a computed one
// { "compute": "<kind>", ... } (COMPUTE below: values that depend on the design, from parts JLCPCB stocks).
import { readFileSync } from "node:fs"

export type End = { net: string } | { ref: string; pin: string }
export interface Spec {
	kind: "resistor" | "capacitor" | "inductor" | "diode" | "connector"
	value: string
	lcsc: string
	mpn: string
	footprint: string
}
export interface SupportEntry {
	part: string | Spec | ({ compute: string } & Record<string, unknown>)
	a?: string
	b?: string
	pins?: Record<string, string>
	count?: number
	job: string
	bound?: number
}
export interface ChipEntry {
	mpn: string
	pins: string[]
	nets?: Record<string, string>
	support?: SupportEntry[]
}
export interface ChipCtx {
	in?: string
	out?: string
	outV?: number
	[key: string]: unknown
}
// One part to add: two ends (a, b) for a two-pin part, or one end per pin number for a multi-pin one.
export interface ChipJob {
	job: string
	spec: Spec
	a?: End
	b?: End
	pins?: Record<string, End>
	near: string
	bound?: number
}
type Chip = { ref: string; pins: string[] }

const GND: End = { net: "GND" }
// A rail's net name, as circuit.ts netName names it: a leading digit gets a V (3V3 → V3V3).
const railNet = (name: string) => (/^\d/.test(name) ? `V${name}` : name)

export function resolveEnd(x: string, chip: Chip, ctx: ChipCtx, ownPins = true): End | null {
	if (x === "-") return null
	if (x === "GND") return GND
	if (x === "$in") return ctx.in ? { net: ctx.in } : null
	if (x === "$out") return ctx.out ? { net: ctx.out } : null
	if (x.startsWith("$:")) return { net: `${chip.ref}_${x.slice(2)}` }
	if (x.startsWith("@")) return { net: x.slice(1) }
	if (x.startsWith("rail:")) return { net: railNet(x.slice(5)) }
	if (x.startsWith("$ctx:")) {
		const v = ctx[x.slice(5)]
		return typeof v === "string" ? resolveEnd(v, chip, ctx, ownPins) : null
	}
	if (ownPins && chip.pins.includes(x)) return { ref: chip.ref, pin: x }
	throw new Error(`chip support: "${x}" is no end and no pin of ${chip.ref} (${chip.pins.join(", ")})`)
}

// JLCPCB basic 0402 1 % resistors (catalog/resistors-0402-basic.json): the values a computed resistor may take.
let resistorTable: { ohms: number; lcsc: string; mpn: string }[] | undefined
export const basicResistors = () => (resistorTable ??= (JSON.parse(readFileSync(new URL("../../catalog/resistors-0402-basic.json", import.meta.url), "utf8")) as { resistors: { ohms: number; lcsc: string; mpn: string }[] }).resistors)
const ohmsLabel = (o: number) => (o >= 1e6 ? `${+(o / 1e6).toFixed(2)}M` : o >= 1000 ? `${+(o / 1000).toFixed(2)}k` : `${o}`)
const resistor = (r: { ohms: number; lcsc: string; mpn: string }): Spec => ({ kind: "resistor", value: ohmsLabel(r.ohms), lcsc: r.lcsc, mpn: r.mpn, footprint: "0402" })

// The feedback divider for the output the context asks (ctx.outV): of the basic resistors, the pair whose output is
// nearest, the bottom no more than maxBottomOhms (enough current through it for the error amplifier's input).
export function divider(vref: number, outV: number, maxBottomOhms = 20000): { top: Spec; bottom: Spec; outV: number } {
	const rs = basicResistors()
	let best: { t: (typeof rs)[number]; b: (typeof rs)[number]; v: number } | null = null
	for (const b of rs.filter((r) => r.ohms >= 1000 && r.ohms <= maxBottomOhms))
		for (const t of rs.filter((r) => r.ohms >= 1000)) {
			const v = vref * (1 + t.ohms / b.ohms)
			if (!best || Math.abs(v - outV) < Math.abs(best.v - outV) - 1e-9) best = { t, b, v }
		}
	if (!best) throw new Error("chip support: no basic resistors for a divider")
	return { top: resistor(best.t), bottom: resistor(best.b), outV: Math.round(best.v * 1000) / 1000 }
}
// The basic resistor nearest a value (an RT resistor, a compensation resistor).
export function nearestResistor(ohms: number): Spec {
	const r = basicResistors().reduce((m, x) => (Math.abs(Math.log(x.ohms / ohms)) < Math.abs(Math.log(m.ohms / ohms)) ? x : m))
	return resistor(r)
}

// Computed supports by kind: each returns the parts it stands for. Others add theirs here (lead-3: rsense).
export const COMPUTE: Record<string, (e: SupportEntry & { part: { compute: string } & Record<string, unknown> }, chip: Chip, ctx: ChipCtx) => ChipJob[]> = {
	// { compute: "divider", vref, from: "$out", to: "FB" }: top from the output to the feedback pin, bottom to ground.
	divider: (e, chip, ctx) => {
		const p = e.part
		if (typeof ctx.outV !== "number") throw new Error(`chip support: ${chip.ref}'s divider needs ctx.outV`)
		const d = divider(Number(p.vref), ctx.outV)
		const from = resolveEnd(String(p.from ?? "$out"), chip, ctx)
		const to = resolveEnd(String(p.to ?? "FB"), chip, ctx)
		if (!from || !to) return []
		// The divider's middle: the feedback pin itself, or its node when "to" is a net.
		return [
			{ job: `${chip.ref} ${e.job}: top (${d.outV} V from ${p.vref} V)`, spec: d.top, a: from, b: to, near: chip.ref },
			{ job: `${chip.ref} ${e.job}: bottom`, spec: d.bottom, a: to, b: GND, near: chip.ref },
		]
	},
	// { compute: "resistor", ohms, a, b }: the nearest basic resistor (an RT resistor, a compensation resistor).
	resistor: (e, chip, ctx) => {
		const a = resolveEnd(e.a ?? "", chip, ctx), b = resolveEnd(e.b ?? "", chip, ctx)
		return a && b ? [{ job: `${chip.ref} ${e.job}`, spec: nearestResistor(Number(e.part.ohms)), a, b, near: chip.ref, ...(e.bound ? { bound: e.bound } : {}) }] : []
	},
}

// The parts and joins a chip's entry asks for, in this context.
export function chipSupport(chip: Chip, entry: ChipEntry, ctx: ChipCtx, specs: Record<string, Spec>): { jobs: ChipJob[]; joins: { net: string; ref: string; pin: string }[] } {
	const joins: { net: string; ref: string; pin: string }[] = []
	for (const [pin, x] of Object.entries(entry.nets ?? {})) {
		if (!chip.pins.includes(pin)) continue
		const end = resolveEnd(x, chip, ctx, false)
		if (end && "net" in end) joins.push({ net: end.net, ref: chip.ref, pin })
	}
	const jobs: ChipJob[] = []
	for (const e of entry.support ?? []) {
		if (typeof e.part === "object" && "compute" in e.part) {
			const f = COMPUTE[e.part.compute]
			if (!f) throw new Error(`chip support: no computed kind "${e.part.compute}" (${chip.ref})`)
			jobs.push(...f(e as Parameters<typeof f>[0], chip, ctx))
			continue
		}
		const spec = typeof e.part === "string" ? specs[e.part] : (e.part as Spec)
		if (!spec) throw new Error(`chip support: no part "${String(e.part)}" (${chip.ref})`)
		const n = e.count ?? 1
		for (let k = 1; k <= n; k++) {
			const job = `${chip.ref} ${e.job}${n > 1 ? ` ${k} of ${n}` : ""}`
			if (e.pins) {
				const pins: Record<string, End> = {}
				for (const [pin, x] of Object.entries(e.pins)) {
					const end = resolveEnd(x, chip, ctx)
					if (end) pins[pin] = end
				}
				jobs.push({ job, spec, pins, near: chip.ref })
				continue
			}
			const a = resolveEnd(e.a ?? "", chip, ctx), b = resolveEnd(e.b ?? "", chip, ctx)
			if (a && b) jobs.push({ job, spec, a, b, near: chip.ref, ...(e.bound ? { bound: e.bound } : {}) })
		}
	}
	return { jobs, joins }
}

// The catalog entry (catalog/parts.json) by part number, when it carries nets or support.
let catalogRows: (ChipEntry & { role?: string })[] | undefined
export function chipEntry(mpn: string): ChipEntry | undefined {
	catalogRows ??= (JSON.parse(readFileSync(new URL("../../catalog/parts.json", import.meta.url), "utf8")) as (ChipEntry & { role?: string })[])
	const e = catalogRows.find((x) => x.mpn === mpn)
	return e && (e.support || e.nets) ? e : undefined
}
