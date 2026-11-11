// A system of boards (docs/system.md): the boards, and the links between them. Written by the engineer as
// system.json; each board is an ordinary Bringup design, and each link becomes one entry in both boards' links field.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { Connector, LinkMessage } from "../contract/types.ts"
import { LINK_KINDS, PERIPHERALS_FREE, type LinkKind, type Peripheral } from "../contract/link-kinds.ts"

export interface SystemBoard {
	name: string
	// A brief: the board is designed by its own Bringup run. A run: an existing run folder, read as it is (fixed).
	brief?: string
	run?: string
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
	// VCC carries the "from" board's 3V3 to the other one; without it, each board has its own supply.
	power?: { from: string }
	cable: { lengthMm: number }
	messages?: { name: string; from: string; fields: LinkMessage["fields"] }[]
}

export interface SystemSpec {
	name: string
	boards: SystemBoard[]
	links: SystemLink[]
}

export const DEFAULT_BAUD = 115200
export const DEFAULT_I2C_KHZ = 100

// Every reason the spec can't be used, in words; [] when it can.
export function specErrors(s: SystemSpec): string[] {
	const out: string[] = []
	const names = new Set(s.boards.map((b) => b.name))
	if (names.size !== s.boards.length) out.push("board names must be unique")
	for (const b of s.boards) if (!b.brief === !b.run) out.push(`board ${b.name}: give a brief (designed here) or a run (an existing design), not both or neither`)
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
		if (l.power && ![l.a.board, l.b.board].includes(l.power.from)) out.push(`link ${l.id}: power comes from ${l.power.from}, which is not on the link`)
		if (!(l.cable?.lengthMm > 0)) out.push(`link ${l.id}: cable.lengthMm must be a positive length`)
		for (const m of l.messages ?? []) {
			if (![l.a.board, l.b.board].includes(m.from)) out.push(`link ${l.id}: message ${m.name} comes from ${m.from}, which is not on the link`)
			const bytes = m.fields.reduce((n, f) => n + ({ u8: 1, u16: 2, i16: 2, u32: 4, f32: 4 } as const)[f.type], 0)
			if (bytes > 48) out.push(`link ${l.id}: message ${m.name} is ${bytes} bytes; a frame carries 48 at most`)
		}
	}
	// The chip's peripherals (src/contract/link-kinds.ts): links on one board that need the same one. I2C links share the
	// board's one bus, so they never run out here (the I2C bus checks between boards cover them).
	for (const b of s.boards) {
		const by = new Map<Peripheral, string[]>()
		for (const l of s.links) if ((l.a.board === b.name || l.b.board === b.name) && Object.hasOwn(LINK_KINDS, l.kind)) {
			const p = LINK_KINDS[l.kind].peripheral
			if (p !== "i2c") by.set(p, [...(by.get(p) ?? []), l.id])
		}
		for (const [p, ids] of by) if (ids.length > PERIPHERALS_FREE[p]) out.push(`board ${b.name}: ${ids.join(", ")} all need its ${p} (the ESP32-C3 has ${PERIPHERALS_FREE[p]} free); make the others I2C`)
	}
	return out
}

// Reads system.json; briefs and runs are relative to its folder.
export function loadSpec(path: string): SystemSpec {
	const s = JSON.parse(readFileSync(path, "utf8")) as SystemSpec
	const base = dirname(resolve(path))
	return { ...s, boards: s.boards.map((b) => ({ ...b, ...(b.brief ? { brief: resolve(base, b.brief) } : {}), ...(b.run ? { run: resolve(base, b.run) } : {}) })) }
}
