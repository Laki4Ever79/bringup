// The checks between boards (docs/system.md), in plain code from both boards' contracts and the system spec. Each
// finding names the boards that can fix it; the system run sends it to them as a change request.
import { resolve } from "node:path"
import type { BoardLink, ContractSnapshot } from "../contract/types.ts"
import { uartSignals } from "../contract/links.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import { boardLinks } from "./derive.ts"
import { DEFAULT_I2C_KHZ, type SystemLink, type SystemSpec } from "./spec.ts"

export interface SystemFinding {
	kind: "link-pending" | "uart-crossover" | "uart-baud" | "i2c-controllers" | "i2c-address" | "i2c-target-has-bus" | "i2c-pullups" | "i2c-cable-too-long" | "link-power" | "link-voltage" | "message-mismatch" | "logic-level"
	link: string
	message: string
	boards: string[] // who can fix it
	estimate?: boolean // the figure behind it is an estimate, and says so
}

// Figures behind the electrical checks. The ESP32-C3-MINI-1's supply floor is from the catalog's datasheet note; the
// wire's resistance is copper's; the cable's capacitance is an ESTIMATE for an untwisted 28 AWG JST SH cable.
export const WIRE_OHM_PER_M = 0.213 // 28 AWG copper
export const CABLE_PF_PER_M = 50 // estimate
export const BOARD_PF = 10 // estimate: pins, pads and traces on each board
export const DEVICE_PF = 5 // estimate: each other device on the bus
export const PULLUP_OHM = 10_000 // the board generator's I2C pull-ups (codegen/circuit.ts SUPPORT.pullup)
export const MCU_MIN_V = 3.0
// I2C rise-time limits (I2C specification, standard and fast mode); rise time ≈ 0.8473 × R × C.
const RISE_NS = (khz: number) => (khz > 100 ? 300 : 1000)

// The longest cable an I2C bus allows at this speed with the generator's pull-ups (estimate: the cable's pF/m), and the
// capacitance budget it comes from. `devices` counts the I2C devices on the bus besides the two boards' own pins.
export function i2cCableLimit(khz: number, devices: number): { maxPf: number; maxMm: number } {
	const fixedPf = 2 * BOARD_PF + devices * DEVICE_PF
	const maxPf = (RISE_NS(khz) * 1e-9) / (0.8473 * PULLUP_OHM) / 1e-12
	return { maxPf, maxMm: Math.max(0, ((maxPf - fixedPf) / CABLE_PF_PER_M) * 1000) }
}

const catalog = loadCatalog(resolve(import.meta.dirname, "../.."))
const i2cDevices = (s: ContractSnapshot) =>
	(s.values.parts ?? []).flatMap((p) => {
		const a = (catalog.find((c) => c.mpn.toUpperCase() === p.mpn.toUpperCase()) as { i2cAddress?: number } | undefined)?.i2cAddress
		return a === undefined ? [] : [{ ref: p.ref, mpn: p.mpn, address: a }]
	})
const hex = (a: number) => `0x${a.toString(16).padStart(2, "0")}`
const rail = (s: ContractSnapshot, name: string) => (s.values.rails ?? []).find((r) => r.name === name)

export function systemChecks(spec: SystemSpec, contracts: Record<string, ContractSnapshot | undefined>): SystemFinding[] {
	const out: SystemFinding[] = []
	for (const l of spec.links) {
		const [A, B] = [contracts[l.a.board], contracts[l.b.board]]
		const mine = (board: string, s?: ContractSnapshot): BoardLink | undefined => s?.values.links?.find((x) => x.id === l.id)
		const [la, lb] = [mine(l.a.board, A), mine(l.b.board, B)]
		const want = (board: string) => boardLinks(spec, board).find((x) => x.id === l.id)
		const pending = [[l.a.board, la], [l.b.board, lb]].filter(([board, got]) => JSON.stringify(got) !== JSON.stringify(want(board as string))).map(([b]) => b as string)
		if (!A || !B || pending.length) {
			out.push({ kind: "link-pending", link: l.id, message: `${l.id}: ${!A || !B ? "a board has no contract yet" : `${pending.join(" and ")} ${pending.length > 1 ? "haven't" : "hasn't"} taken the link yet`}`, boards: pending })
			continue
		}
		out.push(...(l.kind === "uart" ? uartChecks(l, A, B, la!, lb!) : l.kind === "i2c" ? i2cChecks(l, contracts) : []))
		out.push(...powerChecks(l, A, B))
		for (const [board, s] of [[l.a.board, A], [l.b.board, B]] as const)
			if (!rail(s, "3V3")) out.push({ kind: "logic-level", link: l.id, message: `${l.id}: ${board} has no 3V3 rail; both ends of a link run 3.3 V logic`, boards: [board] })
		// One definition on both sides: a message one board sends, the other receives, with the same hash.
		for (const m of la!.messages ?? []) {
			const theirs = lb!.messages?.find((x) => x.name === m.name)
			if (!theirs || theirs.hash !== m.hash || theirs.dir === m.dir) out.push({ kind: "message-mismatch", link: l.id, message: `${l.id}: message ${m.name} differs between ${l.a.board} and ${l.b.board} (${theirs ? `hash ${m.hash.slice(0, 8)} vs ${theirs.hash.slice(0, 8)}` : `missing on ${l.b.board}`})`, boards: [l.a.board, l.b.board] })
		}
	}
	return out
}

// A straight cable joins IO1 to IO1: one board's TX must sit on the pin where the other has its RX.
function uartChecks(l: SystemLink, A: ContractSnapshot, B: ContractSnapshot, la: BoardLink, lb: BoardLink): SystemFinding[] {
	const out: SystemFinding[] = []
	const pinOf = (s: ContractSnapshot, link: BoardLink, signal: string) => s.values.pins?.find((p) => p.signal === signal && p.partRef === link.connector)?.partPin
	const [sa, sb] = [uartSignals(la), uartSignals(lb)]
	const [aTx, aRx, bTx, bRx] = [pinOf(A, la, sa.tx), pinOf(A, la, sa.rx), pinOf(B, lb, sb.tx), pinOf(B, lb, sb.rx)]
	if (aTx && bRx && aTx !== bRx) out.push({ kind: "uart-crossover", link: l.id, message: `${l.id}: ${l.a.board}'s TX is on ${aTx} but ${l.b.board}'s RX is on ${bRx}: through a straight cable they don't meet (${l.b.board}'s RX belongs on ${aTx})`, boards: [l.b.board] })
	if (bTx && aRx && bTx !== aRx) out.push({ kind: "uart-crossover", link: l.id, message: `${l.id}: ${l.b.board}'s TX is on ${bTx} but ${l.a.board}'s RX is on ${aRx}: through a straight cable they don't meet`, boards: [l.a.board] })
	if (la.baud !== lb.baud) out.push({ kind: "uart-baud", link: l.id, message: `${l.id}: ${l.a.board} talks at ${la.baud} baud, ${l.b.board} at ${lb.baud}`, boards: [l.a.board, l.b.board] })
	return out
}

// One bus across the cable: one controller, unique addresses (each board's own devices included), one set of pull-ups,
// and a cable short enough for the rise time at the bus speed.
function i2cChecks(l: SystemLink, contracts: Record<string, ContractSnapshot | undefined>): SystemFinding[] {
	const out: SystemFinding[] = []
	const ends = [l.a.board, l.b.board]
	const links = ends.map((b) => contracts[b]!.values.links!.find((x) => x.id === l.id)!)
	const controllers = ends.filter((_, i) => links[i].i2c?.role === "controller")
	if (controllers.length !== 1) out.push({ kind: "i2c-controllers", link: l.id, message: `${l.id}: an I2C bus has one controller; this one has ${controllers.length || "none"} (${controllers.join(", ")})`, boards: ends })
	// Every address on the bus: the targets' own, and each board's devices (they all share the one bus).
	const seen = new Map<number, string>()
	for (const [i, board] of ends.entries()) {
		const s = contracts[board]!
		const addrs = [...(links[i].i2c?.address !== undefined ? [{ who: `${board} (target)`, address: links[i].i2c!.address! }] : []), ...i2cDevices(s).map((d) => ({ who: `${board} ${d.ref} ${d.mpn}`, address: d.address }))]
		for (const { who, address } of addrs) {
			const was = seen.get(address)
			if (was) out.push({ kind: "i2c-address", link: l.id, message: `${l.id}: ${who} and ${was} both answer at ${hex(address)} on the shared bus: give the target another address in the system spec`, boards: [board] })
			else seen.set(address, who)
		}
		// The ESP32-C3 has one I2C controller: a board that is the link's target can't also drive its own sensor.
		if (links[i].i2c?.role === "target" && i2cDevices(s).length) out.push({ kind: "i2c-target-has-bus", link: l.id, message: `${l.id}: ${board} is the link's target but also drives ${i2cDevices(s).map((d) => d.ref).join(", ")} on its own bus; its ESP32-C3 has one I2C controller. Make ${board} the controller, or move the link to UART`, boards: [board] })
	}
	const pullups = ends.filter((_, i) => links[i].i2c?.pullups)
	if (pullups.length !== 1) out.push({ kind: "i2c-pullups", link: l.id, message: `${l.id}: the bus needs exactly one set of pull-ups; ${pullups.length ? `${pullups.join(" and ")} both fit them` : "no board fits them"}`, boards: ends })
	// Rise time ≈ 0.8473 × R × C must stay under the limit: the cable's capacitance is an estimate.
	const khz = links[0].i2c?.khz ?? DEFAULT_I2C_KHZ
	const devices = ends.reduce((n, b) => n + i2cDevices(contracts[b]!).length, 0)
	const { maxPf, maxMm } = i2cCableLimit(khz, devices)
	if (l.cable.lengthMm > maxMm)
		out.push({ kind: "i2c-cable-too-long", link: l.id, message: `${l.id}: at ${khz} kHz with ${PULLUP_OHM / 1000}k pull-ups the bus allows about ${Math.round(maxPf)} pF, so about ${Math.round(maxMm)} mm of cable (estimate: ${CABLE_PF_PER_M} pF/m); this cable is ${l.cable.lengthMm} mm. Shorten it, slow the bus, or use UART`, boards: ends, estimate: true })
	return out
}

// Power over the link: the supplying board's regulator carries both boards' peaks, and the cable's drop leaves the
// powered board above the module's 3.0 V floor.
function powerChecks(l: SystemLink, A: ContractSnapshot, B: ContractSnapshot): SystemFinding[] {
	if (!l.power) return []
	const [from, to, fromName, toName] = l.power.from === l.a.board ? [A, B, l.a.board, l.b.board] : [B, A, l.b.board, l.a.board]
	const out: SystemFinding[] = []
	const r = rail(from, "3V3")
	const peer = rail(to, "3V3")
	const peerMa = peer?.loadMa ?? 0
	if (r && r.loadMa + peerMa > r.regulatorMaxMa)
		out.push({ kind: "link-power", link: l.id, message: `${l.id}: ${fromName}'s 3V3 regulator is rated ${r.regulatorMaxMa} mA but carries its own ${r.loadMa} mA peak plus ${toName}'s ${peerMa} mA through the cable`, boards: [fromName] })
	const dropV = (peerMa / 1000) * WIRE_OHM_PER_M * 2 * (l.cable.lengthMm / 1000)
	if (3.3 - dropV < MCU_MIN_V)
		out.push({ kind: "link-voltage", link: l.id, message: `${l.id}: ${l.cable.lengthMm} mm of 28 AWG drops ${dropV.toFixed(2)} V at ${toName}'s ${peerMa} mA peak, leaving ${(3.3 - dropV).toFixed(2)} V, under the module's ${MCU_MIN_V} V: shorten the cable or give ${toName} its own supply`, boards: [toName], estimate: true })
	return out
}
