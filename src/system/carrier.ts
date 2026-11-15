// The carrier of a bought compute board (docs/superpowers/specs/2026-11-15-compute-modules-design.md, "The carrier"):
// a HAT that sits on top of the module on its 40-pin header, designed by the ordinary board pipeline from a brief written
// here from the module record. It feeds the module 5 V from the robot's battery through the header's 5 V pins; the motor
// driver stays on the MCU main board. Its outline and holes are the module's, so the two stack on spacers.
import type { Module } from "../modules/library.ts"
import type { BatteryPack } from "../mechanics/catalog.ts"
import type { SystemSpec } from "./spec.ts"
import type { AssemblyBoard } from "./assembly.ts"
import { field, HAT_STACK, moduleHoles, moduleOutline, type Cite } from "./bought.ts"
import { headerSignals, railNeed } from "./compute.ts"

export type Bridge = "usb" | "uart"
interface HeaderAt { x: number; y: number; pitchMm: number; rows: number; cols: number; pin1: string }
interface BridgeRecord { value: string; via: string; note?: string; source?: Cite; alternatives?: { value: string; via: string; note?: string; source?: Cite }[] }

const mm = (n: number) => String(Math.round(n * 100) / 100)
const cite = (c: Cite | null | undefined) => (c ? `${c.url}, ${c.where}` : "no source")
const plain = (title: string) => title.replace(/\s*\(bought\).*$/, "")

export interface CarrierOptions {
	// The bought board's name in the system.
	board: string
	// The robot's battery (catalog/mechanics.json), when chosen: the supply's topology follows its voltage.
	battery?: BatteryPack | null
	// How the module talks to the MCU main board: its USB (the default, the record's bridgeDevice), or UART0 on the header.
	bridge?: Bridge
	// The MCU main board's name, for the brief's words.
	mcuBoard?: string
}

// The carrier's brief, in the form of briefs/*.md.
export function carrierBrief(m: Module, o: CarrierOptions): string {
	const name = plain(m.title)
	const outline = moduleOutline(m)
	const holes = moduleHoles(m)
	const holesSrc = field(m, "holes")?.source
	const header = field<HeaderAt>(m, "header.at")
	const need = railNeed(m)
	const bridgeRec = (m.compute as { bridgeDevice?: BridgeRecord } | undefined)?.bridgeDevice
	const bridge = o.bridge ?? "usb"
	const signals = headerSignals(m, bridge)
	const pins = (fn: string) => signals.filter((s) => s.fn === fn).map((s) => s.pin)
	const and = (xs: number[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : String(xs[0] ?? "?"))
	const mcu = o.mcuBoard ?? "main"
	const xs = [...new Set(holes.map((h) => h.x))].sort((a, b) => a - b), ys = [...new Set(holes.map((h) => h.y))].sort((a, b) => a - b)
	const spacing = xs.length > 1 && ys.length > 1 ? `${mm(xs.at(-1)! - xs[0])} × ${mm(ys.at(-1)! - ys[0])} mm between centres` : ""
	const pb = o.battery
	// The converter follows the pack against the module's input voltage; with either unknown it isn't guessed.
	const topology = !pb ? "" : need?.volts == null ? `, through a converter to the module's input voltage (unknown: compute.inputV is ${field(m, "inputV") ? "null" : "missing"})` : pb.fullV < need.volts ? ", so a boost converter" : pb.cutoffV > need.volts ? ", so a buck converter" : ", so a buck-boost converter"
	const supplyFrom = pb ? `the robot's ${pb.mpn} (${pb.cutoffV}–${pb.fullV} V)${topology}` : "the robot's battery"
	const [tx, rx] = [pins("UART TX")[0], pins("UART RX")[0]]
	const alt = bridgeRec?.alternatives?.[0]
	const link =
		bridge === "usb"
			? `- **The link to the ${mcu} board is that board's own USB** (${bridgeRec?.via ?? "its native USB"}; it shows up on the ${name} as ${bridgeRec?.value ?? "/dev/ttyACM0"}: ${cite(bridgeRec?.source)}). It is a cable through the robot's USB-C hub, not a signal on this board: the carrier carries no link pins.${bridgeRec?.note ? ` ${bridgeRec.note[0].toUpperCase()}${bridgeRec.note.slice(1)}.` : ""}`
			: tx === undefined || rx === undefined
				? `- **The link to the ${mcu} board can't be a UART on the header:** the ${name}'s pin map names no UART TX and RX pins. Use the ${mcu} board's own USB.`
				: `- **The link to the ${mcu} board is UART0 on the header**: pin ${tx} (the ${name}'s TX) and pin ${rx} (its RX), 3.3 V logic, on a connector to the ${mcu} board (${alt?.value ?? "/dev/ttyAMA0"}: ${cite(alt?.source)}). ${alt?.note ?? ""}`.trimEnd()
	return [
		`# Brief: carrier for the ${name} (${o.board})`,
		"",
		"## What we want",
		`A HAT for the ${name}, for a robot: it sits on top of the ${name}, plugged onto its 40-pin header, and feeds it 5 V from the robot's battery through that header. The ${name} is bought, not designed here; this board is designed around it. The motor driver and real-time control stay on the robot's ${mcu} board.`,
		"",
		"## Must have",
		...(outline ? [`- **The ${name}'s own outline and holes, so the two stack:** ${mm(outline.widthMm)} × ${mm(outline.heightMm)} mm, with ${holes.length} Ø${mm(holes[0]?.dia ?? 0)} mm mounting holes at ${holes.map((h) => `(${mm(h.x)}, ${mm(h.y)})`).join(", ")} mm from the lower-left corner${spacing ? `, ${spacing}` : ""} (${cite(holesSrc)}), seen from above as the ${name} is. The HAT stands on ${HAT_STACK.mm} mm spacers on those holes (${cite(HAT_STACK.source)}).`] : []),
		...(header?.value ? [`- **A ${header.value.rows} × ${header.value.cols} female stacking header on the underside, ${header.value.pitchMm} mm pitch,** centred at (${mm(header.value.x)}, ${mm(header.value.y)}) mm in the same frame, so it mates with the ${name}'s header pins, which point up from its top face; pin 1 at the ${header.value.pin1} (${cite(header.source)}).`] : []),
		need
			? `- **5 V supply: ${mm(need.amps)} A at ${mm(need.volts ?? 5)} V** from ${supplyFrom}, into header pins ${and(pins("5V"))} (5V), ground on pins ${and(pins("GND"))}. Sized from the ${name}'s ${need.peak.value} A peak (${cite(need.peak.source)})${need.supplyRating ? ": that is the vendor's recommended supply and already includes its headroom, so no margin on top" : ` plus ${need.margin * 100} % margin`}.`
			: `- **5 V supply** from ${supplyFrom} into the header's 5 V pins: the ${name}'s peak current is unknown, so size it from a measurement first.`,
		link,
		`- **No 5 V on any other header pin.** The ${name}'s GPIO run at 3.3 V and aren't 5 V tolerant (${cite(field(m, "gpioLevel")?.source)}).`,
		"",
		"## Out of scope",
		`- The motor driver, the sensors and the robot's real-time control: they stay on the ${mcu} board.`,
		`- A display, a fan, or anything on the ${name}'s USB, Ethernet or camera ports.`,
		"",
	].join("\n")
}

export interface CarrierAdded {
	spec: SystemSpec
	name: string
	// Relative to the spec's folder, as a plan's briefs are (src/system/plan.ts): the caller writes `brief` there.
	briefPath: string
	brief: string
}

// Adds the bought board's carrier to the spec, right after it: `{ name: "<module>-carrier", brief, carries }` (the board
// name instead when that is taken). With an assembly, the carrier is a HAT on the bought board: its place and holes.
export function addCarrier(spec: SystemSpec, board: string, m: Module, o: Omit<CarrierOptions, "board"> = {}): CarrierAdded {
	const b = spec.boards.find((x) => x.name === board)
	if (!b || b.kind !== "bought") throw new Error(`addCarrier: ${board} is not a bought board of the spec`)
	if (spec.boards.some((x) => x.carries === board)) throw new Error(`addCarrier: ${board} already has a carrier`)
	const taken = (n: string) => spec.boards.some((x) => x.name === n)
	const name = [`${m.id}-carrier`, `${board}-carrier`].find((n) => !taken(n)) ?? `${board}-carrier-${spec.boards.length}`
	const briefPath = `briefs/${name}.md`
	const at = spec.boards.indexOf(b)
	const boards = [...spec.boards.slice(0, at + 1), { name, brief: briefPath, carries: board }, ...spec.boards.slice(at + 1)]
	let assembly = spec.assembly
	const under = assembly?.boards.find((x) => x.name === board)
	if (assembly && under) {
		const holes = moduleHoles(m)
		const carrier: AssemblyBoard = { name, xMm: under.xMm, yMm: under.yMm, rotDeg: under.rotDeg, outline: { ...under.outline }, outlineSource: "estimate", carries: board, ...(holes.length ? { holes } : {}) }
		const i = assembly.boards.indexOf(under)
		assembly = { ...assembly, boards: [...assembly.boards.slice(0, i + 1), carrier, ...assembly.boards.slice(i + 1)] }
	}
	return { spec: { ...spec, boards, ...(assembly ? { assembly } : {}) }, name, briefPath, brief: carrierBrief(m, { ...o, board }) }
}
