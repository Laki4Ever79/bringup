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
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { byMpn } from "../mechanics/catalog.ts"

type Entry = Part & { lcsc: string | null; maxInV?: number; cells?: number }

// With the contract (ctx), the passives only a dropped part used go with it (the Eurobot mock, 17 Nov 2026: the 2S pack
// dropped the TP4054 and its LED, and left its PROG resistor R4, LED resistor R7 and C4 connected to nothing).
export function completePowerTree(parts: Part[], mechanics: Mechanics | undefined, ctx?: ContractSnapshot): { parts: Part[]; note: string | null } {
	const t = treeOf(parts, mechanics)
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
