// A board's side of its links to other boards (docs/system.md): the shape the integrator writes, and the board-level
// checks that wake this board's own agents. The checks between boards live in src/system/checks.ts.
import type { AgentRole, BoardLink, ContractSnapshot, FieldName, LinkPin } from "./types.ts"

export const LINK_CONNECTOR = { mpn: "SM04B-SRSS-TB(LF)(SN)", lcsc: "C160404", footprint: "jst4_sh", pins: ["GND", "VCC", "IO1", "IO2"] }
export const I2C_ON = { SDA: "IO1", SCL: "IO2" } as const
export const other = (p: LinkPin): LinkPin => (p === "IO1" ? "IO2" : "IO1")
export const uartSignals = (l: BoardLink) => ({ tx: `${l.id}_TX`, rx: `${l.id}_RX` })
export const linksOf = (s: ContractSnapshot): BoardLink[] => s.values.links ?? []

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

export function linksShapeError(value: unknown): string | null {
	const shape = "links must be an array of {id, kind: \"uart\"|\"i2c\", peer, connector, supply: \"none\"|\"out\"|\"in\", baud and txOn (uart), i2c {role, address?, pullups, khz} (i2c), messages?}"
	if (!Array.isArray(value)) return shape
	for (const l of value) {
		if (!isObj(l) || typeof l.id !== "string" || typeof l.peer !== "string" || typeof l.connector !== "string" || !["uart", "i2c"].includes(l.kind as string) || !["none", "out", "in"].includes(l.supply as string)) return shape
		if (l.kind === "uart" && !(typeof l.baud === "number" && l.baud > 0 && (l.txOn === "IO1" || l.txOn === "IO2"))) return `links: ${l.id} is a UART link: it needs baud and txOn ("IO1" or "IO2")`
		if (l.kind === "i2c") {
			const b = l.i2c
			if (!isObj(b) || !["controller", "target"].includes(b.role as string) || typeof b.pullups !== "boolean" || typeof b.khz !== "number") return `links: ${l.id} is an I2C link: it needs i2c {role: "controller"|"target", address (a target's 7-bit address), pullups, khz}`
			if (b.role === "target" && !(Number.isInteger(b.address) && (b.address as number) >= 0x08 && (b.address as number) <= 0x77)) return `links: ${l.id}: a target needs a 7-bit address from 0x08 to 0x77`
		}
	}
	return null
}

export type LinkViolationKind = "link-connector-missing" | "link-unwired" | "link-supply-conflict"
export interface LinkViolation {
	kind: LinkViolationKind
	message: string
	fields: FieldName[]
	affects: AgentRole[]
}

// What this board must do for each of its links: the connector as a part on an edge, the UART signals on its IO pins,
// an I2C bus for an I2C link, and no regulator of its own when the link powers it.
export function linkChecks(s: ContractSnapshot): LinkViolation[] {
	const { parts = [], connectors = [], pins = [], rails = [] } = s.values
	const out: LinkViolation[] = []
	// Only once the board is drafted (an MCU and its pins): links handed to an empty contract woke the part selector and
	// the architect before they had read the brief, and they started from the connector alone (real system run, 9 Nov).
	if (!parts.some((p) => p.role === "mcu") || s.values.pins === undefined) return out
	// The ESP32-C3 has two UARTs and the console has UART0: one UART link per board.
	const uarts = linksOf(s).filter((l) => l.kind === "uart")
	if (uarts.length > 1) out.push({ kind: "link-unwired", message: `${uarts.map((l) => l.id).join(", ")} are all UART links, but the ESP32-C3 has one UART free (UART0 is the console): the system must move all but one to I2C`, fields: ["links"], affects: ["integrator"] })
	for (const l of linksOf(s)) {
		const part = parts.find((p) => p.ref === l.connector)
		const what = `link ${l.id} to ${l.peer} (${l.kind.toUpperCase()})`
		if (!part || part.mpn !== LINK_CONNECTOR.mpn)
			out.push({ kind: "link-connector-missing", message: `${what} needs its connector: a part ${l.connector}, role connector, ${LINK_CONNECTOR.mpn} (catalog, JST SH 4-pin)${part ? `; ${l.connector} is ${part.mpn}` : ""}`, fields: ["parts"], affects: ["parts"] })
		else if (!connectors.some((k) => k.ref === l.connector))
			out.push({ kind: "link-connector-missing", message: `${what}: ${l.connector} is not on an edge: list it in connectors (kind "header", ${l.edge ? `on the ${l.edge} edge, ` : ""}about 5.8 × 3 mm), so the cable can leave the board and the case`, fields: ["connectors"], affects: ["architect"] })
		if (l.kind === "uart" && l.txOn) {
			const { tx, rx } = uartSignals(l)
			const want = [
				{ signal: tx, partPin: l.txOn },
				{ signal: rx, partPin: other(l.txOn) },
			]
			const wrong = want.filter((w) => !pins.some((p) => p.signal === w.signal && p.partRef === l.connector && p.partPin === w.partPin))
			if (wrong.length)
				out.push({ kind: "link-unwired", message: `${what}: assign ${wrong.map((w) => `${w.signal} to ${l.connector}.${w.partPin}`).join(" and ")} on free GPIOs (the system crosses TX and RX between the boards; a straight cable joins them)`, fields: ["pins"], affects: ["architect"] })
		}
		if (l.kind === "i2c" && !(pins.some((p) => p.signal === "I2C_SDA") && pins.some((p) => p.signal === "I2C_SCL")))
			out.push({ kind: "link-unwired", message: `${what}: the board has no I2C bus. Assign I2C_SDA and I2C_SCL (to ${l.connector}.IO1 and .IO2 if nothing else is on the bus); the board generator wires the connector to them`, fields: ["pins"], affects: ["architect"] })
		const regulated = rails.some((r) => r.name === "3V3") && parts.some((p) => p.role === "ldo")
		if (l.supply === "in" && regulated)
			out.push({ kind: "link-supply-conflict", message: `${what} powers this board from ${l.peer}'s 3V3, but the board has its own regulator on 3V3: two supplies would fight. Remove the regulator (and what feeds it), or the system powers it its own way`, fields: ["parts", "rails"], affects: ["architect"] })
	}
	return out
}

// For the board's agents and its reviewer: what each link asks of this board, in words.
export function linkFactLines(s: ContractSnapshot): string[] {
	const links = linksOf(s)
	if (links.length === 0) return []
	return [
		"",
		"## Links to other boards (from the system of boards; the integrator owns this field, you follow it)",
		"- These are the engineer's requirements, from the system spec: they amend this board's brief. The link connector, its place on the edge and its opening in the case are wanted, not extras to justify against the brief (real system run 3: a reviewer blocked them as unjustified).",
		...links.map((l) => {
			const power = l.supply === "out" ? `this board's 3V3 powers ${l.peer} through VCC` : l.supply === "in" ? `this board runs from ${l.peer}'s 3V3 through VCC (no regulator of its own)` : "VCC unconnected: each board has its own supply"
			const proto =
				l.kind === "uart"
					? `UART at ${l.baud} baud: ${uartSignals(l).tx} on ${l.connector}.${l.txOn}, ${uartSignals(l).rx} on ${l.connector}.${other(l.txOn!)} (assign both to free GPIOs)`
					: `I2C at ${l.i2c?.khz} kHz on the board's own bus (I2C_SDA on IO1, I2C_SCL on IO2; the generator wires the connector), this board the ${l.i2c?.role}${l.i2c?.address !== undefined ? ` at 0x${l.i2c.address.toString(16)}` : ""}, ${l.i2c?.pullups ? "fitting the bus pull-ups" : "without pull-ups (the other board fits them)"}`
			const msgs = (l.messages ?? []).map((m) => `${m.dir === "send" ? "sends" : "receives"} ${m.name} (${m.fields.map((f) => `${f.name}:${f.type}`).join(", ")})`).join("; ")
			return `- ${l.id} to ${l.peer} on ${l.connector} (${LINK_CONNECTOR.mpn}, JST SH 4-pin: 1 GND, 2 VCC, 3 IO1, 4 IO2${l.edge ? `, on the ${l.edge} edge` : ""}): ${proto}; ${power}${msgs ? `; ${msgs}` : ""}.`
		}),
	]
}
