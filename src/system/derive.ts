// Each board's side of the system's links: the links field the integrator hands that board.
import { createHash } from "node:crypto"
import type { BoardLink, LinkMessage } from "../contract/types.ts"
import { canChain, DEFAULT_BAUD, DEFAULT_CAN_KBPS, DEFAULT_I2C_KHZ, type SystemLink, type SystemSpec } from "./spec.ts"

// The link connector's ref on both boards: J + the link's id (JL1), so it can't collide with the board's own J1, J2.
export const connectorRef = (l: Pick<SystemLink, "id">) => `J${l.id}`

// One definition, one hash: both boards' firmwares must be built against the same message.
export function messageHash(m: { name: string; fields: LinkMessage["fields"] }): string {
	return createHash("sha256").update(JSON.stringify({ name: m.name, fields: m.fields })).digest("hex").slice(0, 16)
}

export function boardLinks(spec: SystemSpec, board: string): BoardLink[] {
	return spec.links
		.filter((l) => l.a.board === board || l.b.board === board)
		.map((l) => {
			const isA = l.a.board === board
			const end = isA ? l.a : l.b
			const peer = isA ? l.b.board : l.a.board
			const supply: BoardLink["supply"] = !l.power ? "none" : l.power.from === board ? "out" : "in"
			const messages = (l.messages ?? []).map((m) => ({ name: m.name, dir: m.from === board ? ("send" as const) : ("receive" as const), fields: m.fields, hash: messageHash(m) }))
			const base = { id: l.id, kind: l.kind, peer, connector: connectorRef(l), ...(end.edge ? { edge: end.edge } : {}), supply, ...(messages.length ? { messages } : {}) }
			if (l.kind === "uart") return { ...base, baud: l.baud ?? DEFAULT_BAUD, txOn: isA ? ("IO1" as const) : ("IO2" as const) }
			// A CAN link: a board at one of its bus's two ends fits the 120 Ω; a board in the middle of a chain doesn't (a link
			// on its own is a bus of two ends).
			if (l.kind === "can") {
				const bus = l.can?.bus
				const chain = bus ? canChain(spec.links.filter((x) => x.kind === "can" && x.can?.bus === bus)) : null
				const terminate = !bus || !chain || chain[0] === board || chain.at(-1) === board
				// Its Cyphal/CAN node-ID: its place along the bus (or the link's a, b), from 1; unique on the bus by construction.
				const order = chain ?? [l.a.board, l.b.board]
				const node = order.indexOf(board) + 1
				return { ...base, can: { kbps: l.can?.kbps ?? DEFAULT_CAN_KBPS, terminate, ...(bus ? { bus } : {}), ...(node > 0 ? { node } : {}) } }
			}
			// A kind not built yet (the spec check says so) carries only what every link has.
			if (l.kind !== "i2c" || !l.i2c) return base
			const i2c = l.i2c
			const target = i2c.targets[board]
			const peerAddress = i2c.controller === board ? i2c.targets[peer] : undefined
			return { ...base, i2c: { role: i2c.controller === board ? ("controller" as const) : ("target" as const), ...(target !== undefined ? { address: target } : {}), ...(peerAddress !== undefined ? { peerAddress } : {}), pullups: i2c.pullupsOn === board, khz: i2c.khz ?? DEFAULT_I2C_KHZ } }
		})
}
