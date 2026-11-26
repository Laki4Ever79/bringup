// A robot's power tree decided in code from its pack and its regulator's ratings, not left to agents (real run 19b,
// Eurobot, 17 Nov 2026: after the mechanics switched to the 2S pack, 19 revisions went on the agents adding and removing
// a 1-cell charger, an ideal diode, a buck and its Schottkys, and the run hit its revision cap).
//   - a pack of more than one cell never keeps a 1-cell charger (it would charge it to 4.2 V);
//   - with no charger on the board, the power tree's parts are added in the same write: over the LDO's maximum input, a
//     5 V step-down and two Schottkys (its 5 V and VBUS OR'd); within it, an ideal diode for the cell and a Schottky for
//     VBUS (circuit.ts powerTree wires them; consistency.ts powerTreeChecks judges them);
//   - parts the tree no longer needs (an ideal diode once a step-down feeds the LDO) are dropped.
// Pure: the contract tools apply it to every robot parts write, so the tree is right in one revision.
import type { AgentRole, ContractSnapshot, FieldName, Part } from "./types.ts"
import { usedRefs, type Violation } from "./consistency.ts"
import type { Mechanics } from "../mechanics/types.ts"
import { CONNECTOR_HEADROOM, defaultCheckCatalog, SERVO_STALL_A, SERVO_SUPPLY_EFF } from "../mechanics/checks.ts"
import { byMpn, servoAt } from "../mechanics/catalog.ts"
import type { ArmJointName, ArmSpec } from "../arm/types.ts"
import { armInrush } from "../arm/inrush.ts"
import { armInputRatingV } from "../arm/tvs.ts"

type Entry = Part & { lcsc: string | null; maxInV?: number; cells?: number }

// With the contract (ctx), the passives only a dropped part used go with it (the Eurobot mock, 17 Nov 2026: the 2S pack
// dropped the TP4054 and its LED, and left its PROG resistor R4, LED resistor R7 and C4 connected to nothing).
export function completePowerTree(parts: Part[], mechanics: Mechanics | undefined, ctx?: ContractSnapshot): { parts: Part[]; note: string | null } {
	// An arm: no pack; the logic's 5 V from the brick (its servo rails come with the PWM driver, armOutputs).
	if (ctx?.values.arm) return armLogicTree(catalogRoles(parts).parts, ctx.values.arm)
	const t = completeTree(parts, mechanics, ctx)
	const a = assemblableSupplies(t.parts, mechanics)
	return a.note ? { parts: a.parts, note: [t.note, a.note].filter(Boolean).join("; ") } : t
}


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

// The arm's rail plan and SUPPLY_HEADROOM live in arm-rails.ts (a leaf module circuit.ts can import).
import { armInputNet, ARM_LOGIC_W, EPS, armServos, servoRails, railDivider, railChip, stallOf, railPlan, armRails, SUPPLY_HEADROOM, type ArmRail } from "./arm-rails.ts"
export { armInputNet, ARM_LOGIC_W, armServos, servoRails, railDivider, armRails, SUPPLY_HEADROOM, type ArmRail }
const freeRef = (taken: Set<string>, prefix: string, from: number) => {
	for (let i = from; ; i++) if (!taken.has(`${prefix}${i}`)) return taken.add(`${prefix}${i}`), `${prefix}${i}`
}
const stripEntry = (e: object): Part => {
	const { maxInV: _m, cells: _c, ref: _r, ...rest } = e as Record<string, unknown>
	return rest as unknown as Part
}

// An arm's servo outputs and power input, in code (outputs-auto.ts calls it for a PWM driver on an arm): one plug per
// servo (JV1..), one rail chip per rail with its input on the brick's net, and the brick's jack. Extra plugs or chips an
// earlier design had (a servo fewer, a rail fewer) go.
export function armOutputs(parts: Part[], catalog: (Part & { lcsc: string | null })[], arm: ArmSpec, driverRef: string): { parts: Part[]; note: string | null } {
	const plan = railPlan(arm)
	const plugEntry = catalog.find((c) => c.role === "servo")
	const notes: string[] = []
	let out = [...parts]
	const taken = new Set(out.map((p) => p.ref))
	// Plugs: JV1..JVn exactly.
	const want = new Set(plan.plugs.map((p) => p.ref))
	const extraPlugs = out.filter((p) => p.role === "servo" && !want.has(p.ref))
	if (extraPlugs.length) out = out.filter((p) => !extraPlugs.includes(p)), notes.push(`dropped ${extraPlugs.map((p) => p.ref).join(", ")} (the arm has ${plan.plugs.length} servos)`)
	const added: string[] = []
	if (plugEntry)
		for (const p of plan.plugs)
			if (!out.some((q) => q.ref === p.ref)) {
				out.push({ ...stripEntry(plugEntry), ref: p.ref, reason: `the ${p.joint} servo's plug, on ${driverRef} channel ${p.channel}: signal, its rail, ground` })
				taken.add(p.ref)
				added.push(p.ref)
			}
	if (added.length) notes.push(`${added.join(", ")} ${plugEntry!.mpn} (one plug per arm servo)`)
	// Rail chips: one per rail, on the brick's input.
	const inNets = (e: Part) => Object.fromEntries(e.pins.filter((n) => /^IN(_\d+)?$/.test(n)).map((n) => [n, armInputNet]))
	const supplies = out.filter((p) => p.role === "servo-supply")
	if (plan.chip) {
		const keep = supplies.slice(0, plan.rails.length)
		const drop = supplies.slice(plan.rails.length)
		out = out.filter((p) => !drop.includes(p)).map((p) => (keep.includes(p) && (p.mpn !== plan.chip!.mpn || !p.nets) ? { ...stripEntry(plan.chip!), ref: p.ref, nets: inNets(plan.chip!), ...(p.at ? { at: p.at } : {}), reason: p.reason ?? `servo rail ${keep.indexOf(p) + 1}` } : p))
		if (drop.length) notes.push(`dropped ${drop.map((p) => p.ref).join(", ")} (${plan.rails.length} servo rails)`)
		const newRefs: string[] = []
		for (let i = keep.length; i < plan.rails.length; i++) {
			const ref = freeRef(taken, "U", 7)
			out.push({ ...stripEntry(plan.chip), ref, nets: inNets(plan.chip), reason: `servo rail VSERVO${i + 1} at ${arm.railV} V from the ${arm.input.volts} V brick` })
			newRefs.push(ref)
		}
		const r = plan.rails.map((x, i) => `VSERVO${i + 1} ${x.refs.join("+")} ${Math.round(x.needA * 100) / 100} A`).join(", ")
		if (newRefs.length || drop.length) notes.push(`${plan.rails.length} servo rails at ${arm.railV} V on ${plan.chip.mpn} (${plan.chipA} A each, ${SUPPLY_HEADROOM}x headroom at stall): ${r}`)
	}
	// The brick's jack: a catalog connector with a VIN pin rated for the brick's voltage, the lowest current that carries
	// the brick's amps × CONNECTOR_HEADROOM (else the highest rated).
	if (!out.some((p) => p.nets?.VIN === armInputNet)) {
		const jacks = catalog.filter((c) => c.role === "connector" && c.pins.includes("VIN") && ((c as { ratedV?: number }).ratedV ?? 0) >= arm.input.volts) as (Part & { lcsc: string | null; ratedA?: number })[]
		const needA = arm.input.amps * CONNECTOR_HEADROOM
		const jack = jacks.filter((j) => (j.ratedA ?? 0) >= needA).sort((a, b) => (a.ratedA ?? 0) - (b.ratedA ?? 0))[0] ?? jacks.sort((a, b) => (b.ratedA ?? 0) - (a.ratedA ?? 0))[0]
		if (jack) {
			const ref = freeRef(taken, "J", 10)
			out.push({ ...stripEntry(jack), ref, nets: { VIN: armInputNet }, reason: `the arm's ${arm.input.volts} V brick input (${arm.input.amps} A)` })
			notes.push(`${ref} ${jack.mpn} (the ${arm.input.volts} V brick's input)`)
		}
	}
	return { parts: out, note: notes.length ? `the arm's servo power, in code: ${notes.join("; ")}` : null }
}

// The logic side of an arm: from the brick's input through a step-down to 5 V, OR'd with USB's VBUS by two Schottkys, into
// the LDO (the 2S robots' tree, fed from the brick instead of a pack). No pack, so no charger or ideal diode.
function armLogicTree(parts: Part[], arm: ArmSpec): { parts: Part[]; note: string | null } {
	const list = (defaultCheckCatalog()?.boardParts ?? []) as unknown as Entry[]
	const changed: string[] = []
	const gone = parts.filter((p) => ["charger", "charge-led", "ideal-diode", "battery"].includes(p.role ?? ""))
	let out = parts.filter((p) => !gone.includes(p))
	if (gone.length) changed.push(`dropped ${gone.map((p) => `${p.ref} ${p.mpn}`).join(", ")} (a brick, no pack)`)
	const taken = new Set(out.map((p) => p.ref))
	// One rule for every chip on the brick's input (lead-2, 26 Nov 2026): rated over its TVS's clamp at full pulse
	// (tvs.ts armInputRatingV, 35.5 V), as the rail chips are: not the AP63205's 32 V. A step-down under it is replaced in
	// place (its ref kept), as the rail chips are.
	const rated = armInputRatingV(arm.input)
	const e = list.find((x) => x.role === "buck" && x.lcsc && (x.maxInV ?? 0) >= rated)
	const under = out.find((p) => p.role === "buck" && (list.find((x) => x.mpn === p.mpn)?.maxInV ?? Infinity) < rated)
	if (under && e) {
		out = out.map((p) => (p === under ? { ...stripEntry(e), ref: under.ref, nets: { VIN: armInputNet }, ...(under.at ? { at: under.at } : {}) } : p))
		changed.push(`${under.ref} ${under.mpn} (rated ${list.find((x) => x.mpn === under.mpn)?.maxInV} V) became ${e.mpn} (${e.maxInV} V): every chip on the brick's input is rated over its TVS's ${rated} V clamp`)
	}
	if (!out.some((p) => p.role === "buck")) {
		if (e) {
			const ref = freeRef(taken, "U", 7)
			out.push({ ...stripEntry(e), ref, nets: { VIN: armInputNet } })
			changed.push(`added ${ref} ${e.mpn} (buck, the logic's 5 V from the ${arm.input.volts} V brick)`)
		}
	} else out = out.map((p) => (p.role === "buck" && !p.nets?.VIN ? { ...p, nets: { ...p.nets, VIN: armInputNet } } : p))
	const diode = list.find((x) => x.role === "diode")
	while (diode && out.filter((p) => p.role === "diode").length < 2) {
		const ref = freeRef(taken, "D", 10)
		out.push({ ...stripEntry(diode), ref })
		changed.push(`added ${ref} ${diode.mpn} (diode)`)
	}
	return { parts: out, note: changed.length ? `the arm's logic power from its ${arm.input.volts} V brick, decided in code: ${changed.join("; ")}` : null }
}

// The arm's power checks (arm-supply): every servo rated for the rail, the rails split to fit their chip, a chip per rail,
// chips and jack rated for the brick's voltage, a brick big enough for the rails at stall plus the logic, and the jack
// carrying the brick's current with CONNECTOR_HEADROOM.
export function armPowerChecks(s: ContractSnapshot): Violation[] {
	const arm = s.values.arm
	if (!arm) return []
	const cat = defaultCheckCatalog()
	if (!cat) return []
	const v: Violation[] = []
	const bad = (message: string, fields: FieldName[] = ["arm"], affects: AgentRole[] = ["mechanics"]) => v.push({ kind: "arm-supply", message, fields, affects })
	for (const x of armServos(arm)) {
		const p = cat.mech.servos?.find((q) => q.mpn === x.servo)
		if (!p) continue // the arm's own checks name a servo the catalog lacks
		const r = servoAt(p, arm.railV)
		if ("error" in r) bad(`the ${x.joint} servo on a ${arm.railV} V rail: ${r.error}; set railV within every servo's range or pick a servo rated for it`)
	}
	const plan = railPlan(arm)
	const d = railDivider(arm.railV)
	if (Math.abs(d.voutV - arm.railV) > 0.02 * arm.railV) bad(`no E24 feedback divider gives a ${arm.railV} V rail within 2 % (the closest, ${d.r1}/${d.r2}, gives ${d.voutV} V): pick a rail voltage it can set, such as 6 V`)
	if (!plan.chip) bad(`no servo supply in the catalog takes the ${arm.input.volts} V brick: lower the brick's voltage`)
	if (!plan.fits) {
		const worst = [...plan.plugs].sort((a, b) => b.stallA - a.stallA)[0]
		bad(`the ${worst.joint} servo stalls at ${worst.stallA} A, ${SUPPLY_HEADROOM}x is ${Math.round(worst.stallA * SUPPLY_HEADROOM * 100) / 100} A: over one ${plan.chip?.mpn ?? "servo supply"}'s ${plan.chipA} A, so no split of the servos into rails fits`)
	}
	const supplies = (s.values.parts ?? []).filter((p) => p.role === "servo-supply")
	if (s.values.parts && supplies.length < plan.rails.length) bad(`${plan.rails.length} servo rails need ${plan.rails.length} ${plan.chip?.mpn ?? "servo supply"} chips; the parts have ${supplies.length}`, ["parts"], ["parts"])
	const watts = (plan.rails.reduce((a, r) => a + arm.railV * r.needA, 0) / SERVO_SUPPLY_EFF + ARM_LOGIC_W) * SUPPLY_HEADROOM
	const brickA = watts / arm.input.volts
	const r2 = (n: number) => Math.round(n * 100) / 100
	if (arm.input.amps + EPS < brickA)
		bad(`the ${arm.input.volts} V brick is rated ${arm.input.amps} A (${r2(arm.input.volts * arm.input.amps)} W); the servos at stall (${r2(plan.rails.reduce((a, r) => a + r.needA, 0))} A at ${arm.railV} V, ${SERVO_SUPPLY_EFF * 100} % through the rails) plus the logic (${ARM_LOGIC_W} W, an estimate), ${SUPPLY_HEADROOM}x, need ${r2(watts)} W: ${r2(brickA)} A`)
	const jack = (s.values.parts ?? []).find((p) => p.nets?.VIN === armInputNet)
	const entry = jack ? (cat.boardParts as unknown as (Part & { ratedA?: number; ratedV?: number })[]).find((e) => e.mpn === jack.mpn) : undefined
	if (s.values.parts && !jack) bad(`no input jack on ${armInputNet} for the ${arm.input.volts} V brick`, ["parts"], ["parts"])
	if (jack && entry?.ratedV !== undefined && entry.ratedV + EPS < arm.input.volts) bad(`${jack.ref} ${jack.mpn} is rated ${entry.ratedV} V, under the ${arm.input.volts} V brick`, ["arm", "parts"], ["mechanics", "parts"])
	if (jack && entry?.ratedA !== undefined && brickA * CONNECTOR_HEADROOM > entry.ratedA + EPS)
		bad(`${jack.ref} ${jack.mpn} is rated ${entry.ratedA} A; the ${arm.input.volts} V brick's ${r2(brickA)} A x ${CONNECTOR_HEADROOM} is ${r2(brickA * CONNECTOR_HEADROOM)} A: raise the brick's voltage (fewer amps for the same watts) or pick a higher-rated input`, ["arm", "parts"], ["mechanics", "parts"])
	// A hot-plugged brick against the input TVS and the chips it feeds (arm task 6: src/arm/inrush.ts).
	for (const x of armInrush(s).violations) bad(x.message, ["arm"], ["mechanics"])
	return v
}
