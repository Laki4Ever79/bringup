// A system of boards (docs/system.md): the boards, and the links between them. Written by the engineer as
// system.json; each board is an ordinary Bringup design, and each link becomes one entry in both boards' links field.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { Connector, LinkMessage } from "../contract/types.ts"
import { assemblyErrors, type SystemAssembly } from "./assembly.ts"
import { boughtErrors } from "./bought.ts"
import { LINK_KINDS, PERIPHERALS_FREE, type LinkKind, type Peripheral } from "../contract/link-kinds.ts"

export interface SystemBoard {
	name: string
	// A brief: the board is designed by its own Bringup run. A run: an existing run folder, read as it is (fixed).
	brief?: string
	run?: string
	// A bought board (a compute module: Raspberry Pi…): no brief, no run; its outline, holes and power come from its
	// module record in catalog/modules (src/system/bought.ts). Agents never design it.
	kind?: "bought"
	module?: string
	// A carrier: the designed HAT on top of a bought board (src/system/carrier.ts), on its header.
	carries?: string
	// A carrier's 5 V regulator, a catalog/mechanics.json regulators mpn; and how the module talks to the MCU board
	// (its USB, the default, or UART0 on the header). The compute checks read both (src/system/bought-checks.ts).
	regulator?: string
	bridge?: "usb" | "uart"
}

export interface SystemLink {
	id: string
	kind: LinkKind
	// For UART, a's TX goes out on IO1 and b's on IO2, so a straight cable crosses them.
	a: { board: string; edge?: Connector["edge"] }
	b: { board: string; edge?: Connector["edge"] }
	baud?: number
	// For I2C: which board drives the bus, each target's 7-bit address, which board fits the pull-ups, the speed.
	i2c?: { controller: string; targets: Record<string, number>; pullupsOn: string; khz?: number }
	// bus: links that name the same bus are segments of one CAN bus, daisy-chained board to board (a bus of more than two
	// boards); without it, a link is a bus of its own between its two boards.
	can?: { kbps?: number; bus?: string }
	// VCC carries the "from" board's 3V3 to the other one; without it, each board has its own supply.
	power?: { from: string }
	cable: { lengthMm: number }
	messages?: { name: string; from: string; fields: LinkMessage["fields"] }[]
}

export interface SystemSpec {
	name: string
	boards: SystemBoard[]
	links: SystemLink[]
	// The physical body: where the boards sit (src/system/assembly.ts). Optional.
	assembly?: SystemAssembly
}

export const DEFAULT_BAUD = 115200
export const DEFAULT_I2C_KHZ = 100
export const DEFAULT_CAN_KBPS = 500
import { createHash } from "node:crypto"
const messageHashOf = (m: { name: string; fields: unknown }) => createHash("sha256").update(JSON.stringify({ name: m.name, fields: m.fields })).digest("hex").slice(0, 16)
// The bit rates CAN nodes agree on (CiA 301's bit timing table), each with the longest bus it allows: 40 m at 1 Mbit/s
// is ISO 11898's (TI SN65HVD230 datasheet SLOS346O §11.2.1.3, p28); the rest are CiA 301's recommendations, which assume
// a 5 ns/m cable and the transceivers' loop delay: estimates for a given cable.
export const CAN_BUS_MAX_M: Record<number, number> = { 1000: 40, 800: 50, 500: 100, 250: 250, 125: 500, 50: 1000, 20: 2500, 10: 5000 }
// A classic CAN frame carries 8 data bytes (ISO 11898-1): one message per frame.
export const CAN_FRAME_BYTES = 8

// Every reason the spec can't be used, in words; [] when it can.
export function specErrors(s: SystemSpec): string[] {
	const out: string[] = []
	const names = new Set(s.boards.map((b) => b.name))
	if (names.size !== s.boards.length) out.push("board names must be unique")
	for (const b of s.boards) {
		if (b.kind !== undefined && b.kind !== "bought") out.push(`board ${b.name}: kind ${b.kind} is not a board kind (only "bought", with a module)`)
		else if (b.kind === "bought") out.push(...boughtErrors(b))
		else if (!b.brief === !b.run) out.push(`board ${b.name}: give a brief (designed here) or a run (an existing design), not both or neither`)
		else if (b.module) out.push(`board ${b.name}: a module is for a bought board (kind "bought")`)
		if (b.carries !== undefined) {
			const carried = s.boards.find((x) => x.name === b.carries)
			if (b.kind === "bought") out.push(`board ${b.name}: a bought board can't be a carrier`)
			else if (!carried) out.push(`board ${b.name}: it carries ${b.carries}, which is not in the system`)
			else if (carried.kind !== "bought") out.push(`board ${b.name}: it carries ${b.carries}, which is not a bought board`)
			else if (s.boards.find((x) => x.carries === b.carries) !== b) out.push(`board ${b.name}: ${b.carries} already has a carrier`)
		}
	}
	// Something must be designed: a system of bought boards alone has nothing for Bringup to do.
	if (s.boards.length && s.boards.every((b) => b.kind === "bought")) out.push("a system needs at least one designed board (a brief or a run) besides its bought boards")
	// A bought board's own link to the robot is the MCU board's USB, or its carrier's header: not a cable the system designs.
	const bought = new Set(s.boards.filter((b) => b.kind === "bought").map((b) => b.name))
	for (const l of s.links) for (const end of [l.a, l.b]) if (bought.has(end.board)) out.push(`link ${l.id}: ${end.board} is a bought board; links to it go through its carrier or the MCU board's USB, not a system cable`)
	const ids = new Set<string>()
	for (const l of s.links) {
		if (!/^[A-Z][A-Z0-9]*$/.test(l.id)) out.push(`link ${l.id}: an id is upper case letters and digits, e.g. L1 (signals are named after it)`)
		if (ids.has(l.id)) out.push(`link ${l.id}: ids must be unique`)
		ids.add(l.id)
		for (const end of [l.a, l.b]) if (!names.has(end.board)) out.push(`link ${l.id}: no board named ${end.board}`)
		if (l.a.board === l.b.board) out.push(`link ${l.id}: joins ${l.a.board} to itself`)
		if (!Object.hasOwn(LINK_KINDS, l.kind)) {
			out.push(`link ${l.id}: kind ${l.kind} is not a link kind (${Object.keys(LINK_KINDS).join(", ")})`)
			continue
		}
		if (!LINK_KINDS[l.kind].built) {
			out.push(`link ${l.id}: kind ${l.kind} is planned (docs/system.md), not built yet`)
			continue
		}
		if (l.kind === "i2c") {
			if (!l.i2c) out.push(`link ${l.id}: an I2C link needs i2c {controller, targets, pullupsOn}`)
			else {
				const ends = [l.a.board, l.b.board]
				if (!ends.includes(l.i2c.controller)) out.push(`link ${l.id}: the controller ${l.i2c.controller} is not on the link`)
				if (!ends.includes(l.i2c.pullupsOn)) out.push(`link ${l.id}: the pull-ups' board ${l.i2c.pullupsOn} is not on the link`)
				for (const [board, address] of Object.entries(l.i2c.targets)) {
					if (!ends.includes(board)) out.push(`link ${l.id}: target ${board} is not on the link`)
					if (!(Number.isInteger(address) && address >= 0x08 && address <= 0x77)) out.push(`link ${l.id}: ${board}'s address must be 7-bit, 0x08 to 0x77`)
				}
			}
		}
		// A target can't start a transfer: it keeps its latest frame, and the controller reads it. One frame, one message.
		if (l.kind === "i2c" && l.i2c) {
			const fromTarget = (l.messages ?? []).filter((m) => m.from !== l.i2c!.controller)
			if (fromTarget.length > 1) out.push(`link ${l.id}: ${fromTarget[0].from} sends ${fromTarget.map((m) => m.name).join(", ")}; an I2C target holds one frame for the controller to read, so it sends one message`)
		}
		if (l.kind === "can" && l.can?.kbps !== undefined && !Object.hasOwn(CAN_BUS_MAX_M, l.can.kbps)) out.push(`link ${l.id}: ${l.can.kbps} kbit/s is not a CAN bit rate nodes agree on; use one of ${Object.keys(CAN_BUS_MAX_M).join(", ")}`)
	}
	out.push(...canBusErrors(s))
	for (const l of s.links) {
		if (l.power && ![l.a.board, l.b.board].includes(l.power.from)) out.push(`link ${l.id}: power comes from ${l.power.from}, which is not on the link`)
		if (!(l.cable?.lengthMm > 0)) out.push(`link ${l.id}: cable.lengthMm must be a positive length`)
		for (const m of l.messages ?? []) {
			if (![l.a.board, l.b.board].includes(m.from)) out.push(`link ${l.id}: message ${m.name} comes from ${m.from}, which is not on the link`)
			const bytes = m.fields.reduce((n, f) => n + ({ u8: 1, u16: 2, i16: 2, u32: 4, f32: 4 } as const)[f.type], 0)
			if (l.kind === "can" && bytes > CAN_FRAME_BYTES) out.push(`link ${l.id}: message ${m.name} is ${bytes} bytes; a CAN frame carries ${CAN_FRAME_BYTES}: split it into messages of ${CAN_FRAME_BYTES} bytes or less`)
			else if (bytes > 48) out.push(`link ${l.id}: message ${m.name} is ${bytes} bytes; a frame carries 48 at most`)
		}
	}
	// One I2C controller per chip: in target mode the board can't also drive a bus. So a board on I2C links is the
	// controller on all of them, or the target on exactly one and on no other I2C link.
	for (const b of s.boards) {
		const mine = s.links.filter((l) => l.kind === "i2c" && l.i2c && (l.a.board === b.name || l.b.board === b.name))
		const asTarget = mine.filter((l) => l.i2c!.controller !== b.name)
		if (asTarget.length && mine.length > 1)
			out.push(`board ${b.name}: it is the I2C target on ${asTarget[0].id} and on other I2C links (${mine.filter((l) => l !== asTarget[0]).map((l) => l.id).join(", ")}); its ESP32-C3 has one I2C controller, which can't be a target and drive a bus. Make ${b.name} the controller on all its I2C links, or move the others to UART`)
	}
	// The chip's peripherals (src/contract/link-kinds.ts): links on one board that need the same one. I2C links share the
	// board's one bus as its controller, so they aren't counted here; the role rule above covers a board as target.
	for (const b of s.boards) {
		const by = new Map<Peripheral, string[]>()
		for (const l of s.links) if ((l.a.board === b.name || l.b.board === b.name) && Object.hasOwn(LINK_KINDS, l.kind)) {
			const p = LINK_KINDS[l.kind].peripheral
			// The segments of one CAN bus share the board's one controller: counted once, by the bus.
			const use = l.kind === "can" && l.can?.bus ? `bus ${l.can.bus}` : l.id
			if (p !== "i2c" && !(by.get(p) ?? []).includes(use)) by.set(p, [...(by.get(p) ?? []), use])
		}
		for (const [p, ids] of by) if (ids.length > PERIPHERALS_FREE[p]) out.push(`board ${b.name}: ${ids.join(", ")} all need its ${p} (the ESP32-C3 has ${PERIPHERALS_FREE[p]} free); make the others I2C`)
	}
	out.push(...assemblyErrors(s))
	return out
}

// Reads system.json; briefs and runs are relative to its folder.
export function loadSpec(path: string): SystemSpec {
	const s = JSON.parse(readFileSync(path, "utf8")) as SystemSpec
	const base = dirname(resolve(path))
	return { ...s, boards: s.boards.map((b) => ({ ...b, ...(b.brief ? { brief: resolve(base, b.brief) } : {}), ...(b.run ? { run: resolve(base, b.run) } : {}) })) }
}

// The CAN buses of a system: each link's own, or the segments that name one bus (link.can.bus), daisy-chained.
export function canBuses(spec: SystemSpec): { bus: string; links: SystemLink[] }[] {
	const by = new Map<string, SystemLink[]>()
	for (const l of spec.links) if (l.kind === "can") by.set(l.can?.bus ?? l.id, [...(by.get(l.can?.bus ?? l.id) ?? []), l])
	return [...by].map(([bus, links]) => ({ bus, links }))
}
// A bus's boards in chain order, or null when its segments don't form one chain (a board on three segments, a loop, two
// pieces). Its two ends are the boards that terminate it.
export function canChain(links: SystemLink[]): string[] | null {
	const deg = new Map<string, number>()
	for (const l of links) for (const b of [l.a.board, l.b.board]) deg.set(b, (deg.get(b) ?? 0) + 1)
	if ([...deg.values()].some((d) => d > 2)) return null
	const ends = [...deg].filter(([, d]) => d === 1).map(([b]) => b)
	if (ends.length !== 2) return null
	const order = [ends[0]]
	const used = new Set<SystemLink>()
	while (order.length < deg.size) {
		const at = order.at(-1)!
		const next = links.find((l) => !used.has(l) && (l.a.board === at || l.b.board === at))
		if (!next) return null
		used.add(next)
		order.push(next.a.board === at ? next.b.board : next.a.board)
	}
	return used.size === links.length ? order : null
}
// ISO 11898-2's longest unterminated stub at 1 Mbit/s (TI SN65HVD230 datasheet SLOS346O §11.2.1.3): a daisy-chained
// node's stub is its board's trace from the connector to the transceiver, well under it.
export const CAN_STUB_MAX_M = 0.3
// Every reason a bus of several segments isn't one bus, in words.
export function canBusErrors(spec: SystemSpec): string[] {
	const out: string[] = []
	for (const { bus, links } of canBuses(spec)) {
		if (links.length < 2) continue
		const ids = links.map((l) => l.id).join(", ")
		if (!canChain(links)) out.push(`CAN bus ${bus} (${ids}): its segments must chain the boards one after another (each board on at most two of them, no loop), so the bus has two ends to terminate`)
		const rates = new Set(links.map((l) => l.can?.kbps ?? DEFAULT_CAN_KBPS))
		if (rates.size > 1) out.push(`CAN bus ${bus} (${ids}): its segments must share one bit rate (they have ${[...rates].join(" and ")} kbit/s)`)
		const kbps = [...rates][0]
		const total = links.reduce((t, l) => t + l.cable.lengthMm, 0) / 1000
		const max = CAN_BUS_MAX_M[kbps]
		if (max !== undefined && total > max) out.push(`CAN bus ${bus} (${ids}): its cables add up to ${total} m, over the ${max} m a bus allows at ${kbps} kbit/s`)
		// One sender per frame identifier: two nodes sending the same identifier collide in arbitration (CAN gives each
		// identifier one transmitter, ISO 11898-1), and the receiver couldn't tell them apart.
		const senders = new Map<string, Set<string>>()
		for (const l of links) for (const m of l.messages ?? []) senders.set(m.name, new Set([...(senders.get(m.name) ?? []), m.from]))
		for (const [name, from] of senders) if (from.size > 1) out.push(`CAN bus ${bus}: ${[...from].join(" and ")} all send ${name}: on one bus each frame identifier has one sender; name each node's message apart (${[...from].map((b) => `${name}_${b.replace(/\W+/g, "_")}`).join(", ")})`)
		// One identifier per message definition across the whole bus: every node hears every frame.
		const seen = new Map<string, string>()
		for (const l of links) for (const m of l.messages ?? []) {
			const id = (parseInt(messageHashOf(m).slice(0, 8), 16) & 0x1fffffff).toString(16)
			const key = `${m.name}:${JSON.stringify(m.fields)}`
			const prior = seen.get(id)
			if (prior !== undefined && prior !== key) out.push(`CAN bus ${bus}: messages ${prior.split(":")[0]} and ${m.name} share the frame identifier 0x${id}: rename one`)
			seen.set(id, key)
		}
	}
	return out
}
