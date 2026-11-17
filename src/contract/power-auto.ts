// A robot's power tree decided in code from its pack and its regulator's ratings, not left to agents (real run 19b,
// Eurobot, 17 Nov 2026: after the mechanics switched to the 2S pack, 19 revisions went on the agents adding and removing
// a 1-cell charger, an ideal diode, a buck and its Schottkys, and the run hit its revision cap).
//   - a pack of more than one cell never keeps a 1-cell charger (it would charge it to 4.2 V);
//   - with no charger on the board, the power tree's parts are added in the same write: over the LDO's maximum input, a
//     5 V step-down and two Schottkys (its 5 V and VBUS OR'd); within it, an ideal diode for the cell and a Schottky for
//     VBUS (circuit.ts powerTree wires them; consistency.ts powerTreeChecks judges them);
//   - parts the tree no longer needs (an ideal diode once a step-down feeds the LDO) are dropped.
// Pure: the contract tools apply it to every robot parts write, so the tree is right in one revision.
import type { ContractSnapshot, Part } from "./types.ts"
import { usedRefs } from "./consistency.ts"
import type { Mechanics } from "../mechanics/types.ts"
import { defaultCheckCatalog, SERVO_STALL_A } from "../mechanics/checks.ts"
import { byMpn } from "../mechanics/catalog.ts"

type Entry = Part & { lcsc: string | null; maxInV?: number; cells?: number }

// With the contract (ctx), the passives only a dropped part used go with it (the Eurobot mock, 17 Nov 2026: the 2S pack
// dropped the TP4054 and its LED, and left its PROG resistor R4, LED resistor R7 and C4 connected to nothing).
export function completePowerTree(parts: Part[], mechanics: Mechanics | undefined, ctx?: ContractSnapshot): { parts: Part[]; note: string | null } {
	const t = completeTree(parts, mechanics, ctx)
	const a = assemblableSupplies(t.parts, mechanics)
	return a.note ? { parts: a.parts, note: [t.note, a.note].filter(Boolean).join("; ") } : t
}

// Every power module the code or an agent picks (a step-down, the servos' supply) becomes a chip JLCPCB assembles, with
// its datasheet's parts (the board generator adds them), when the catalog has one of that role rated for the pack's full
// voltage and the role's current: the module stays the fallback (lead decision after real run 20, 17 Nov 2026: the
// D24V5F5 and the D36V50F5 had no LCSC number). The current a role needs: the servos', each at stall (SERVO_STALL_A,
// an estimate) times their count; a step-down's, the catalog chip's own rating (the logic rail's few hundred mA).
// A supply chip must be rated at least this much over the role's peak (lead decision, 17 Nov 2026): servos stall
// together (a blocked arm, a start), the stall figure itself is an estimate, and a converter run at its limit runs hot
// and trips its current limit; 25 % is the usual derating for a supply's continuous rating.
export const SUPPLY_HEADROOM = 1.25

export function assemblableSupplies(parts: Part[], mechanics: Mechanics | undefined): { parts: Part[]; note: string | null } {
	const cat = defaultCheckCatalog()
	const pack = cat && mechanics?.battery?.pack ? byMpn(cat.mech.batteries, mechanics.battery.pack) : undefined
	if (!cat || !pack) return { parts, note: null }
	const list = cat.boardParts as unknown as (Part & { lcsc: string | null; maxInV?: number | null; maxA?: number | null })[]
	const servos = parts.filter((p) => p.role === "servo").length
	const need = (role: string) => (role === "servo-supply" ? servos * SERVO_STALL_A : 0)
	const changed: string[] = []
	const out = parts.map((p) => {
		if (!["buck", "servo-supply"].includes(p.role ?? "") || p.lcsc) return p
		const chip = list.find((x) => x.role === p.role && x.lcsc && (x.maxInV ?? 0) >= pack.fullV && (x.maxA ?? 0) >= SUPPLY_HEADROOM * need(p.role!))
		if (!chip) return p
		const { maxInV: _m, cells: _c, ...rest } = chip as typeof chip & Record<string, unknown>
		changed.push(`${p.ref} ${p.mpn} (a module, no LCSC number) became ${chip.mpn} (${chip.lcsc}, ${chip.maxA} A, up to ${chip.maxInV} V${need(p.role!) ? `; the ${servos} servos at stall need ${need(p.role!)} A, ${SUPPLY_HEADROOM}x is ${SUPPLY_HEADROOM * need(p.role!)} A` : ""})`)
		return { ...(rest as unknown as Part), ref: p.ref, ...(p.at ? { at: p.at } : {}) }
	})
	// The battery plug mates the pack's own connector (catalog connector / mates): an XT60 pack gets the XT60PW-M, which
	// carries 30 A where the JST PH carries 2 A (the Eurobot base with two servos: 5.07 A), and needs no lead or crimping.
	const packPlug = (pack as { connector?: string }).connector
	const plug = packPlug ? list.find((x) => x.role === "battery" && (x as { mates?: string }).mates === packPlug) : undefined
	const fixedPlug = plug ? out.map((p) => (p.role === "battery" && p.mpn !== plug.mpn ? (changed.push(`${p.ref} ${p.mpn} became ${plug.mpn} (${plug.lcsc}), the ${packPlug} the ${pack.mpn} ends in`), { ...(plug as unknown as Part), ref: p.ref, ...(p.at ? { at: p.at } : {}) }) : p)) : out
	return { parts: fixedPlug, note: changed.length ? `power parts JLCPCB assembles: ${changed.join("; ")}` : null }
}

// A part the catalog knows by its part number takes the catalog's role when it came as "other" (real run 20, rev 20:
// the agents rewrote U7 D24V5F5 and D10/D11 B5819W as "other", the prompt not naming buck or diode then, and the tree
// added a second step-down and pair of Schottkys beside them: no room left for the board). Recognised by function, the
// tree adopts them instead of adding a second.
export function catalogRoles(parts: Part[]): { parts: Part[]; note: string | null } {
	const cat = defaultCheckCatalog()
	if (!cat) return { parts, note: null }
	const list = cat.boardParts as unknown as Part[]
	const fixed: string[] = []
	const out = parts.map((p) => {
		if (p.role && p.role !== "other") return p
		const e = list.find((x) => x.mpn === p.mpn)
		if (!e?.role || e.role === "other") return p
		fixed.push(`${p.ref} ${p.mpn} is the catalog's ${e.role}`)
		return { ...p, role: e.role }
	})
	return { parts: out, note: fixed.length ? `roles from the catalog: ${fixed.join(", ")}` : null }
}

function completeTree(partsIn: Part[], mechanics: Mechanics | undefined, ctx?: ContractSnapshot): { parts: Part[]; note: string | null } {
	const roles = catalogRoles(partsIn)
	const parts = roles.parts
	const t0 = treeOf(parts, mechanics)
	const t = roles.note ? { parts: t0.parts, note: [roles.note, t0.note].filter(Boolean).join("; ") } : t0
	if (!ctx || !t.note) return t
	const gone = parts.filter((p) => !t.parts.some((q) => q.ref === p.ref))
	if (!gone.length) return t
	const used = (list: Part[]) => usedRefs({ ...ctx, values: { ...ctx.values, parts: list } })
	const before = used(parts)
	const after = used(t.parts)
	const orphans = t.parts.filter((p) => ["resistor", "capacitor", "led"].includes(p.role ?? "") && before.has(p.ref) && !after.has(p.ref))
	if (!orphans.length) return t
	return { parts: t.parts.filter((p) => !orphans.includes(p)), note: `${t.note}; dropped ${orphans.map((p) => `${p.ref} (${p.role})`).join(", ")}, used only by ${gone.map((p) => p.ref).join(", ")}` }
}

function treeOf(parts: Part[], mechanics: Mechanics | undefined): { parts: Part[]; note: string | null } {
	const cat = defaultCheckCatalog()
	const ldo = parts.find((p) => p.role === "ldo")
	if (!cat || !ldo || !parts.some((p) => p.role === "battery")) return { parts, note: null }
	const pack = mechanics?.battery?.pack ? byMpn(cat.mech.batteries, mechanics.battery.pack) : undefined
	if (!pack) return { parts, note: null }
	const list = cat.boardParts as unknown as Entry[]
	// A step-down: the first one rated for the pack's full voltage (the AP63205 chip, assembled by JLCPCB), else one
	// whose rating isn't in the catalog (the Pololu module, the fallback). Run 20: the module had no LCSC number and no room.
	const entry = (role: string) =>
		role === "buck" ? list.find((x) => x.role === "buck" && x.maxInV !== undefined && x.maxInV !== null && x.maxInV >= pack.fullV) ?? list.find((x) => x.role === "buck" && (x.maxInV === undefined || x.maxInV === null)) : list.find((x) => x.role === role)
	const ldoE = list.find((x) => x.mpn === ldo.mpn)
	const changed: string[] = []
	let out = parts
	// No 1-cell charger on a multi-cell pack (catalog cells on the charger).
	const charger = out.find((p) => p.role === "charger")
	const chargerCells = charger ? list.find((x) => x.mpn === charger.mpn)?.cells ?? 1 : undefined
	if (charger && pack.cells > 1 && chargerCells === 1) {
		out = out.filter((p) => p !== charger && p.role !== "charge-led")
		changed.push(`dropped ${charger.ref} ${charger.mpn} (a 1-cell charger on the ${pack.cells}-cell pack; the pack is charged off the board)`)
	}
	if (out.some((p) => p.role === "charger")) return { parts: out, note: changed.length ? changed.join("; ") : null }
	const over = ldoE?.maxInV !== undefined && pack.fullV > ldoE.maxInV
	const taken = new Set(out.map((p) => p.ref))
	const free = (prefix: string) => {
		for (let i = prefix === "U" ? 7 : 10; ; i++) if (!taken.has(`${prefix}${i}`)) return taken.add(`${prefix}${i}`), `${prefix}${i}`
	}
	const add = (role: string) => {
		const e = entry(role)
		if (!e) return
		const ref = free(role === "diode" ? "D" : "U")
		const { maxInV: _m, cells: _c, ...part } = e as Entry & Record<string, unknown>
		out = [...out, { ...(part as unknown as Part), ref }]
		changed.push(`added ${ref} ${e.mpn} (${role})`)
	}
	const count = (role: string) => out.filter((p) => p.role === role).length
	if (over) {
		// The step-down's 5 V and VBUS, each through a Schottky; an ideal diode on the cell has no place here (5.5 V max).
		const ideal = out.filter((p) => p.role === "ideal-diode")
		if (ideal.length) {
			out = out.filter((p) => p.role !== "ideal-diode")
			changed.push(`dropped ${ideal.map((p) => p.ref).join(", ")} (an ideal diode can't take the ${pack.fullV} V pack)`)
		}
		if (!count("buck")) add("buck")
		while (count("diode") < 2) add("diode")
	} else {
		if (!count("ideal-diode") && !count("buck")) add("ideal-diode")
		while (count("diode") < 1) add("diode")
	}
	return { parts: out, note: changed.length ? `the power tree from the ${pack.mpn} (${pack.fullV} V) and ${ldo.ref}'s ${ldoE?.maxInV ?? "?"} V input, decided in code: ${changed.join("; ")}` : null }
}
