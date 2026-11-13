// Why each thing on the board is there (engineer, 13 Nov 2026: "explanation for each individual component as to why it
// was used when the component is selected", and "user should be aware of all the things that were done and why").
// Every reason comes from something recorded when the decision was made, never written afterwards:
// - recorded: the part's own reason, written by whoever chose it (Part.reason), usually quoting the brief;
// - added: an "Added for you" item (src/contract/added.ts), the generator's own decisions with how to turn them off;
// - datasheet: a support passive's job and the datasheet or standard its value comes from (circuit.ts SUPPORT_SOURCES);
// - rule: the generator's rule that puts a part of this role on every board of this kind (the power path, USB-C);
// - none: nothing was recorded. The card says so rather than guessing.
// The catalog's facts for the part (its notes, with their datasheet sections) come alongside, kept apart from the why.
import { boardCrystal, boardParts, motorConnectors, bringupPads, debugPort, generatedNets, recoveryPads, supportParts, supportSource, testPoints } from "../codegen/circuit.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import { resolve } from "node:path"
import { addedForYou, type AddedItem } from "./added.ts"
import type { ContractSnapshot } from "./types.ts"

export interface PartReason {
	ref: string
	// What it is, in a few words: "ESP32-C3-MINI-1 (mcu)", "10k resistor", "test pad on V3V3".
	what: string
	mpn: string | null
	role: string | null
	value: string | null
	why: string
	source: { kind: "recorded" | "added" | "datasheet" | "rule" | "none"; detail: string }
	// Bringup put it there on its own (a support passive, a pad, the debug footprint): it isn't in the parts list.
	generated: boolean
	// The "Added for you" item it belongs to, with how it shows, what it costs and how to change it.
	added: Pick<AddedItem, "id" | "what" | "cost" | "change"> | null
	// The nets it touches, from the generated netlist and the pin map.
	nets: string[]
	// The catalog's notes on this part number (datasheet facts with their sections), if any.
	facts: string | null
	side: "top" | "bottom"
}

// The generator's rule for a role it wires the same way on every board (codegen/circuit.ts generatedNets, catalog/README.md).
const ROLE_RULES: Record<string, string> = {
	mcu: "The board's microcontroller: it runs the firmware. Every design has one.",
	ldo: "Makes the 3.3 V rail the MCU and the other parts run on, from USB or the battery (the power path every board has, catalog/README.md).",
	charger: "Charges the Li-ion cell from USB-C: the design has a battery (the power path, catalog/README.md).",
	"usb-c": "Power and flashing over USB-C, the default on every board.",
	battery: "The battery's connector: the design runs from a cell.",
	led: "A status light the firmware drives.",
	"charge-led": "Lit by the charger while it charges, wired to its CHRG pin, so it shows charging with the MCU asleep.",
	"motor-driver": "Drives the motors from the cell (docs/mechanics.md).",
	button: "A button the firmware reads.",
}

const catalog = loadCatalog(resolve(import.meta.dirname, "../.."))

export function partReasons(s: ContractSnapshot, brief = ""): PartReason[] {
	const { parts = [], pins = [], links = [] } = s.values
	const items = s.values.outline ? addedForYou(s, brief) : []
	const item = (id: AddedItem["id"]) => {
		const i = items.find((x) => x.id === id)
		return i ? { id: i.id, what: i.what, cost: i.cost, change: i.change } : null
	}
	const nets = netsByRef(s)
	const support = s.values.outline ? supportParts(s) : []
	const factsOf = (mpn: string | null) => (mpn ? catalog.find((c) => c.mpn.toLowerCase() === mpn.toLowerCase())?.notes ?? null : null)
	const out: PartReason[] = []

	for (const b of s.values.outline ? boardParts(s) : parts.map((p) => ({ ref: p.ref, mpn: p.mpn, lcsc: p.lcsc, footprint: p.footprint, value: null, added: false }))) {
		const part = parts.find((p) => p.ref === b.ref)
		const sp = support.find((x) => x.ref === b.ref)
		const base = { ref: b.ref, mpn: b.mpn || null, role: part?.role ?? null, value: b.value, nets: nets.get(b.ref) ?? [], facts: factsOf(b.mpn || null), side: "top" as const }
		if (sp) {
			// A support passive, the contract's or added: its job, and where its value comes from.
			const src = supportSource(sp.spec)
			const belongs = [x(sp, "MCU_EN") && "en-reset", x(sp, "USB_SENSE") && "usb-wake", /download boot/.test(sp.job) && "recovery-pads"].find(Boolean) as AddedItem["id"] | undefined
			out.push({
				...base, value: sp.spec.value, mpn: sp.spec.mpn, role: sp.spec.kind,
				what: `${sp.spec.value} ${sp.spec.kind}`,
				why: cap(sp.job),
				source: src ? { kind: "datasheet", detail: src } : { kind: "rule", detail: "the generator's support passives for this part (codegen/circuit.ts supportParts)" },
				generated: sp.added,
				added: belongs ? item(belongs) : null,
			})
			continue
		}
		const xtal = boardCrystal(s)
		if (xtal && xtal.ref === b.ref) {
			out.push({ ...base, what: `${xtal.mhz} MHz crystal`, why: `The ${parts.find((p) => p.ref === xtal.mcuRef)?.mpn ?? "MCU"}'s clock: its profile asks for an external crystal on ${xtal.inPin}/${xtal.outPin}.`, source: { kind: "datasheet", detail: "the chip's profile (catalog/mcu), from its datasheet" }, generated: true, added: null })
			continue
		}
		const motor = motorConnectors(parts).findIndex((p) => p.ref === b.ref)
		if (motor >= 0 && parts.some((p) => p.role === "motor-driver")) {
			out.push({ ...base, what: `${part?.mpn ?? ""} (motor connector)`.trim(), why: part?.reason?.trim() || `Motor ${"AB"[motor] ?? motor + 1} plugs in here, wired to the motor driver's outputs (docs/mechanics.md).`, source: part?.reason ? { kind: "recorded", detail: "written when the part was chosen" } : { kind: "rule", detail: "the generator's motor wiring (codegen/circuit.ts motorConnectors)" }, generated: false, added: null })
			continue
		}
		const link = links.find((l) => l.connector === b.ref)
		const recorded = part?.reason?.trim()
		const rule = part ? ROLE_RULES[part.role] : undefined
		out.push({
			...base,
			what: part ? `${part.mpn} (${part.role})` : `${b.footprint} connector`,
			why: recorded ?? (link ? `The cable link to the other board (${link.kind}${link.peer ? `, to ${link.peer}` : ""}): docs/system.md.` : rule ?? "No reason was recorded for this part."),
			source: recorded ? { kind: "recorded", detail: "written when the part was chosen" } : link || rule ? { kind: "rule", detail: link ? "the system's link (links field)" : "the generator's rule for this role" } : { kind: "none", detail: "nothing was recorded when it was chosen" },
			generated: false,
			added: null,
		})
	}

	// The pads and the debug footprint on the underside: each from its "Added for you" item (or the production test).
	if (s.values.outline) {
		for (const p of testPoints(s).placed) out.push(pad(p, "Production test pad", "the production test probes this net (the test field)", { kind: "recorded", detail: "the test field" }, null))
		for (const p of recoveryPads(s).placed) out.push(pad(p, "Recovery pad", "Short the two recovery pads while plugging USB in: the chip starts its ROM downloader, so a board whose firmware hangs can still be flashed.", { kind: "added", detail: "Added for you: recovery pads" }, item("recovery-pads")))
		for (const p of bringupPads(s).placed) out.push(pad(p, "Bring-up test pad", `A place to probe ${p.net} on the bench instead of a chip's pin.`, { kind: "added", detail: "Added for you: bring-up test pads" }, item("bringup-pads")))
		const dp = debugPort(s).placed
		if (dp)
			out.push({
				ref: dp.ref, what: "Tag-Connect TC2030 debug footprint", mpn: null, role: "debug", value: null,
				why: `A stock TC2030 cable presses on six bare pads: ${dp.pads.map((p) => `${p.pin} ${p.name}`).join(", ")}. Flash, reset and debug without a connector on the board.`,
				source: { kind: "added", detail: "Added for you: debug footprint (Tag-Connect drawing TC2030-IDC-NL-FP rev A)" },
				generated: true, added: item("debug-port"),
				nets: [...new Set(dp.pads.flatMap((p) => (p.end && "net" in p.end ? [p.end.net] : [])))],
				facts: null, side: "bottom",
			})
	}
	return out

	function pad(p: { ref: string; net: string }, what: string, why: string, source: PartReason["source"], added: PartReason["added"]): PartReason {
		return { ref: p.ref, what: `${what} on ${p.net}`, mpn: null, role: "pad", value: null, why, source, generated: true, added, nets: [p.net], facts: null, side: "bottom" }
	}
	function x(sp: { a: object; b: object }, net: string) {
		return [sp.a, sp.b].some((e) => "net" in e && String((e as { net: string }).net).startsWith(net))
	}
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

// Each part's nets: the generated power and USB nets, the pin map's signals, and the support passives' ends.
function netsByRef(s: ContractSnapshot): Map<string, string[]> {
	const out = new Map<string, Set<string>>()
	const add = (ref: string, net: string) => (out.get(ref) ?? out.set(ref, new Set()).get(ref)!).add(net)
	if (s.values.outline) {
		for (const [net, ends] of generatedNets(s)) for (const e of ends) add(e.split(".")[0], net)
		for (const sp of supportParts(s)) for (const e of [sp.a, sp.b]) if ("net" in e) add(sp.ref, e.net)
	}
	for (const p of s.values.pins ?? []) {
		add(p.partRef, p.signal)
		const mcu = s.values.parts?.find((x) => x.role === "mcu")
		if (mcu) add(mcu.ref, p.signal)
	}
	return new Map([...out].map(([k, v]) => [k, [...v].sort()]))
}
