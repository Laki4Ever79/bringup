// From an adopted repo to a Bringup design contract, and back: `infer` turns a board (and the firmware build that
// fits it) into contract values, validated by the contract's own rules; `checkAgainst` reads the repo as it is now
// into Bringup artifacts and runs Bringup's cross-domain checks against the agreed contract, plus a field-by-field
// diff of what moved. So an existing repo gets the same contract and the same checks as a design Bringup made.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { DesignContract } from "../contract/contract.ts"
import { checkConsistency, type Artifacts, type Violation } from "../contract/consistency.ts"
import { OWNERS, type Connector, type ContractSnapshot, type ContractValues, type FieldName, type Part, type PinAssignment } from "../contract/types.ts"
import { firmwareVariants, type FirmwareVariant } from "./firmware.ts"
import { checkVariant, findMcus, gpioOfPad, rankVariants, type PinCheck } from "./match.ts"
import { loadBoardFile, netMembers, type Board, type Footprint } from "./pcb.ts"
import { pinLabel } from "./pins.ts"

// Which firmware name drives each contract signal, and where it is defined: the link between the contract and the
// firmware, which the contract itself (keyed by board signal) doesn't hold.
export interface Links {
	repo: string
	board: string
	variant: string | null
	mcu: string
	signals: Record<string, { firmware?: { name: string; file: string; line: number } }>
	// What the contract leaves out or estimates, said once so nobody reads a guess as a fact.
	notes: string[]
}

export interface Inferred {
	values: Partial<ContractValues>
	links: Links
	// Fields the contract refused, with its reason (none expected; kept so a refusal is never silent).
	refused: { field: FieldName; reason: string }[]
	snapshot: ContractSnapshot
}

// UPPER_SNAKE signal names (the contract's rule): /MCU Controller/MCU_SCLK → MCU_SCLK, TFT_~{RST} → TFT_RST,
// UART A TX → UART_A_TX, /AD+ → AD_P.
export function signalName(net: string): string {
	const leaf = net.split("/").filter(Boolean).pop() ?? net
	const s = leaf
		.replace(/~\{([^}]*)\}/g, "$1")
		.replace(/\+/g, "_P")
		.replace(/-$/g, "_N")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase()
	return /^[A-Z]/.test(s) ? s : `N_${s}`
}

const generic = (net: string) => /^Net-\(|^unconnected-/.test(net) || /^(?:[A-Z0-9]+_)?(?:GPIO|IO|GP)\d+$|^[DA]\d+$/i.test(net.split("/").pop() ?? "")
const passive = (ref: string) => /^(R|C|L|FB|TP|JP|NT)\d/i.test(ref)

function role(f: Footprint): Part["role"] {
	const t = `${f.value} ${f.lib}`
	if (/usb.?c|type.?c/i.test(t)) return "usb-c"
	if (/^(SW|S|BTN)\d/i.test(f.ref)) return "button"
	if (/^(LED|D)\d/i.test(f.ref) && /led/i.test(t)) return "led"
	if (/^(J|P|CN|X)\d/i.test(f.ref)) return "connector"
	if (/^R\d/i.test(f.ref)) return "resistor"
	if (/^C\d/i.test(f.ref)) return "capacitor"
	return "other"
}

const rail = (net: string) => /^(GND\w*|AGND|DGND|VCC\w*|VDD\w*|VSS|VBUS\d*|VSYS|VBAT|VIN|\+?\d+V\d*(_\w+)?)$/i.test(net.split("/").pop() ?? "")

// A signal as one electrical net: the GPIO's net plus the far side of each two-pad series resistor on it (an LED's
// resistor, a mic's series resistor, an oscillator's damping resistor). Never through a pull-up onto a rail.
export function signalEnds(b: Board, net: string): { ref: string; pad: string; fn: string }[] {
	const members = netMembers(b)
	const byRef = new Map(b.footprints.map((f) => [f.ref, f]))
	const near = members.get(net) ?? []
	const out = [...near]
	for (const r of near.filter((m) => /^R\d/.test(m.ref) && byRef.get(m.ref)?.pads.length === 2)) {
		const far = byRef.get(r.ref)!.pads.find((p) => p.number !== r.pad)?.net
		if (far && far !== net && !rail(far) && !far.startsWith("unconnected-")) out.push(...(members.get(far) ?? []).filter((m) => m.ref !== r.ref))
	}
	return out
}

// The part a GPIO's signal leads to: the first non-passive part on it (through series resistors), else anything.
function peerOf(b: Board, mcuRefs: Set<string>, net: string): { ref: string; pin: string } | null {
	const ends = signalEnds(b, net).filter((m) => !mcuRefs.has(m.ref))
	const peer = ends.find((m) => !passive(m.ref)) ?? ends[0]
	return peer ? { ref: peer.ref, pin: peer.fn || peer.pad } : null
}

// Connector-like parts within reach of an edge, in the contract's frame: offsets from the bottom-left corner, along
// the edge (y up the left/right edges, x along top/bottom). Width is the part's extent along the edge; the cutout's
// height can't be read from a board, so it is a per-kind estimate (said in the links' notes).
const HEIGHT_MM: Record<Connector["kind"], number> = { "usb-c": 3.3, button: 3.5, header: 8.5 }
function connectors(b: Board): Connector[] {
	if (!b.outline) return []
	const { minX, minY, widthMm, heightMm } = b.outline
	const maxX = minX + widthMm
	const maxY = minY + heightMm
	const out: Connector[] = []
	for (const f of b.footprints) {
		if (!/^(J|USB|CN|SW|BTN|P)\d/i.test(f.ref)) continue
		const kind: Connector["kind"] = /usb.?c|type.?c/i.test(`${f.value} ${f.lib}`) ? "usb-c" : /^(SW|BTN)/i.test(f.ref) ? "button" : "header"
		const inFrom: Record<Connector["edge"], number> = { left: f.x - minX, right: maxX - f.x, bottom: maxY - f.y, top: f.y - minY }
		const edge = (Object.keys(inFrom) as Connector["edge"][]).reduce((a, e) => (inFrom[e] < inFrom[a] ? e : a))
		const along = edge === "left" || edge === "right" ? f.size.h : f.size.w
		const across = edge === "left" || edge === "right" ? f.size.w : f.size.h
		// On the edge: its body reaches within 3 mm of it.
		if (inFrom[edge] - across / 2 > 3) continue
		const offsetMm = +(edge === "left" || edge === "right" ? maxY - f.y : f.x - minX).toFixed(2)
		out.push({ ref: f.ref, kind, edge, offsetMm, widthMm: +Math.max(along, 1).toFixed(2), heightMm: HEIGHT_MM[kind] })
	}
	return out.sort((a, b) => a.ref.localeCompare(b.ref))
}

// The contract a board and its firmware imply. Only what the files say: no rails (their current ratings aren't in a
// KiCad file), no requirements or behavior. The MCU is the board's first; Bringup's contract has one.
export function infer(repo: string, boardFile: string, variants: FirmwareVariant[] = firmwareVariants(repo), only?: string): Inferred | null {
	const b = loadBoardFile(boardFile)
	const mcus = findMcus(b)
	if (!b.outline || !mcus.length) return null
	const mcu = mcus[0]
	const mcuRefs = new Set(mcus.map((m) => m.ref))
	// A build that doesn't fit (score at or below zero) isn't this board's firmware: the contract links none, unless
	// the person pinned one.
	const ranked = rankVariants(b, mcus, variants, only)[0]
	const best = ranked && (ranked.score > 0 || only) ? ranked : undefined
	const notes: string[] = [
		"rails, requirements and behavior are not in the contract: a board file has no current ratings or product intent",
		"connector cutout heights are estimates per kind (usb-c 3.3, button 3.5, header 8.5 mm)",
	]
	if (mcus.length > 1) notes.push(`the contract covers the first MCU, ${mcu.ref}; ${mcus.slice(1).map((m) => m.ref).join(", ")} ${mcus.length > 2 ? "are" : "is"} checked by adopt but not in the contract`)

	// The firmware name for each GPIO of this MCU, from the checks that agree (or at least land on a real net).
	const fwByGpio = new Map<number, PinCheck["pin"]>()
	for (const c of best?.checks ?? []) if (c.mcu === mcu.ref && ["agrees", "unnamed", "name-differs"].includes(c.verdict) && !c.pin.unused) fwByGpio.set(c.pin.gpio, c.pin)

	const pins: PinAssignment[] = []
	const signals: Links["signals"] = {}
	const peers = new Map<string, Footprint>()
	const byRef = new Map(b.footprints.map((f) => [f.ref, f]))
	const seen = new Set<string>()
	for (const p of mcu.pads) {
		const gpio = gpioOfPad(mcu, p)
		if (gpio === null || !p.net || p.net.startsWith("unconnected-")) continue
		const fw = fwByGpio.get(gpio)
		// A net with no name of its own takes the firmware's name for the pin, or stays out.
		const signal = !generic(p.net) ? signalName(p.net) : fw ? signalName(fw.name) : null
		const peer = signal && peerOf(b, mcuRefs, p.net)
		if (!signal || !peer || seen.has(signal)) continue
		if (/^(GND\w*|VCC|VDD\w*|VSS|VBUS\d*|VBAT|\+?\d+V\d*)$/i.test(signal)) continue
		seen.add(signal)
		pins.push({ signal, gpio, partRef: peer.ref, partPin: peer.pin })
		signals[signal] = fw ? { firmware: { name: fw.name, file: fw.file, line: fw.line } } : {}
		const pf = byRef.get(peer.ref)
		if (pf) peers.set(pf.ref, pf)
	}
	const part = (f: Footprint, r: Part["role"]): Part => ({ ref: f.ref, role: r, mpn: f.value || f.lib, lcsc: null, footprint: f.lib, pins: [...new Set(f.pads.map((p) => p.fn || p.number))] })
	const values: Partial<ContractValues> = {
		outline: { widthMm: b.outline.widthMm, heightMm: b.outline.heightMm, thicknessMm: b.thicknessMm },
		connectors: connectors(b),
		parts: [part(mcu, "mcu"), ...[...peers.values()].sort((x, y) => x.ref.localeCompare(y.ref)).map((f) => part(f, role(f)))],
		pins: pins.sort((x, y) => x.gpio - y.gpio),
	}

	// Written through the contract itself, in dependency order (pins are validated against parts), so what is saved
	// is exactly what Bringup would accept.
	const contract = new DesignContract()
	const refused: Inferred["refused"] = []
	for (const field of ["outline", "connectors", "parts", "pins"] as const) {
		const value = values[field]
		if (value === undefined) continue
		const r = contract.propose({ field, value, by: OWNERS[field], baseVersion: 0 } as Parameters<DesignContract["propose"]>[0])
		if (r.status === "invalid") refused.push({ field, reason: r.reason })
	}
	const links: Links = { repo: basename(repo), board: relative(repo, boardFile), variant: best?.v.id ?? null, mcu: mcu.ref, signals, notes }
	return { values, links, refused, snapshot: contract.snapshot() }
}

// The repo as it is now, as Bringup artifacts: the board's size and nets (MCU pads as REF.GPIOn, the convention
// the checks use) and the firmware build's pin for each linked signal. Named nets are keyed by their signal name; a
// contract signal whose net had no name is found at its GPIO's pad, if that net still has none. Bringup's check then
// still demands both ends (the MCU's GPIO and the peripheral's pin), so a rewired pad can't pass.
export function artifactsOf(repo: string, links: Links, agreed: ContractSnapshot, variants: FirmwareVariant[] = firmwareVariants(repo)): Artifacts | null {
	const file = join(repo, links.board)
	if (!existsSync(file)) return null
	const b = loadBoardFile(file)
	if (!b.outline) return null
	const mcu = b.footprints.find((f) => f.ref === links.mcu)
	const endOf = (m: { ref: string; pad: string; fn: string }, net: string) => {
		const g = mcu && m.ref === mcu.ref ? gpioOfPad(mcu, { fn: m.fn, net }) : null
		return g !== null ? `${m.ref}.GPIO${g}` : `${m.ref}.${m.fn || m.pad}`
	}
	const members = netMembers(b)
	const nets: Record<string, string[]> = {}
	for (const net of members.keys()) if (!generic(net)) nets[signalName(net)] = signalEnds(b, net).map((m) => endOf(m, net))
	for (const pin of agreed.values.pins ?? []) {
		if (nets[pin.signal] || !mcu) continue
		const pad = mcu.pads.find((p) => gpioOfPad(mcu, p) === pin.gpio)
		if (pad && generic(pad.net) && !pad.net.startsWith("unconnected-")) nets[pin.signal] = signalEnds(b, pad.net).map((m) => endOf(m, pad.net))
	}
	// The firmware's pins as this build compiles them (#if branches evaluated against this board), by linked name.
	const v = variants.find((x) => x.id === links.variant)
	const mcus = findMcus(b)
	const compiled = v && mcus.length ? checkVariant(b, mcus, v).map((c) => c.pin) : []
	const fwPins: Record<string, number> = {}
	for (const [signal, l] of Object.entries(links.signals)) {
		const p = l.firmware && compiled.find((x) => x.name === l.firmware!.name)
		if (p) fwPins[signal] = p.gpio
	}
	return {
		board: { revision: 0, dir: dirname(file), pcbPath: file, stepPath: null, renderPath: null, widthMm: b.outline.widthMm, heightMm: b.outline.heightMm, nets },
		...(v ? { firmware: { revision: 0, ok: true, pins: fwPins, log: "" } } : {}),
	}
}

export interface FieldChange {
	field: FieldName
	what: string
}

// What moved between the agreed contract and the repo now, in the contract's terms: the semantic diff git can't give.
export function diffValues(agreed: Partial<ContractValues>, now: Partial<ContractValues>): FieldChange[] {
	const out: FieldChange[] = []
	const o1 = agreed.outline
	const o2 = now.outline
	if (o1 && o2 && (o1.widthMm !== o2.widthMm || o1.heightMm !== o2.heightMm || o1.thicknessMm !== o2.thicknessMm))
		out.push({ field: "outline", what: `board ${o1.widthMm} × ${o1.heightMm} × ${o1.thicknessMm} mm → ${o2.widthMm} × ${o2.heightMm} × ${o2.thicknessMm} mm` })
	const byRef = <T extends { ref: string }>(xs: T[] | undefined) => new Map((xs ?? []).map((x) => [x.ref, x]))
	const c1 = byRef(agreed.connectors)
	const c2 = byRef(now.connectors)
	for (const [ref, a] of c1) {
		const b = c2.get(ref)
		if (!b) out.push({ field: "connectors", what: `${ref} is gone from the ${a.edge} edge` })
		else if (a.edge !== b.edge || Math.abs(a.offsetMm - b.offsetMm) > 0.1) out.push({ field: "connectors", what: `${ref} moved: ${a.edge} edge at ${a.offsetMm} mm → ${b.edge} edge at ${b.offsetMm} mm` })
	}
	for (const [ref, b] of c2) if (!c1.has(ref)) out.push({ field: "connectors", what: `${ref} is new, on the ${b.edge} edge at ${b.offsetMm} mm` })
	const p1 = byRef(agreed.parts)
	const p2 = byRef(now.parts)
	for (const [ref, a] of p1) {
		const b = p2.get(ref)
		if (b && a.mpn !== b.mpn) out.push({ field: "parts", what: `${ref} changed: ${a.mpn} → ${b.mpn}` })
	}
	const s1 = new Map((agreed.pins ?? []).map((p) => [p.signal, p]))
	const s2 = new Map((now.pins ?? []).map((p) => [p.signal, p]))
	for (const [sig, a] of s1) {
		const b = s2.get(sig)
		if (!b) out.push({ field: "pins", what: `${sig} (${pinLabel(a.gpio)}) is gone from the board` })
		else if (a.gpio !== b.gpio) out.push({ field: "pins", what: `${sig} moved: ${pinLabel(a.gpio)} → ${pinLabel(b.gpio)}` })
		else if (a.partRef !== b.partRef || a.partPin !== b.partPin) out.push({ field: "pins", what: `${sig} now goes to ${b.partRef}.${b.partPin} (was ${a.partRef}.${a.partPin})` })
	}
	for (const [sig, b] of s2) if (!s1.has(sig)) out.push({ field: "pins", what: `${sig} is new on ${pinLabel(b.gpio)}` })
	return out
}

export interface CheckResult {
	board: string
	violations: Violation[]
	changes: FieldChange[]
	missing?: string
}

// Bringup's checks of the repo now against the agreed contract. Only the checks whose inputs a foreign repo has:
// the board's outline and nets, and the firmware's pins (rails, enclosure and power checks need Bringup's own data).
const FOREIGN_CHECKS = new Set<Violation["kind"]>(["outline-mismatch", "net-missing", "pin-mismatch"])

export function checkAgainst(repo: string, dir: string): CheckResult[] {
	const variants = firmwareVariants(repo)
	const out: CheckResult[] = []
	for (const entry of readIndex(dir)) {
		const snapshot = JSON.parse(readFileSync(join(dir, entry, "contract.json"), "utf8")) as ContractSnapshot
		const links = JSON.parse(readFileSync(join(dir, entry, "links.json"), "utf8")) as Links
		const a = artifactsOf(repo, links, snapshot, variants)
		if (!a) {
			out.push({ board: links.board, violations: [], changes: [], missing: `${links.board} is gone or has no outline` })
			continue
		}
		// Firmware pins are compared only for signals linked to a firmware name; the rest have nothing to compare.
		const linked = (v: Violation) => v.kind !== "pin-mismatch" || Boolean(links.signals[/firmware drives (\S+) on/.exec(v.message)?.[1] ?? ""]?.firmware)
		const violations = checkConsistency(snapshot, a).filter((v) => FOREIGN_CHECKS.has(v.kind) && linked(v))
		// Firmware pin messages say GPIO numbers; an STM32 pin reads better as PC13.
		for (const v of violations) v.message = v.message.replace(/GPIO(\d{4})/g, (_, n: string) => pinLabel(Number(n)))
		const now = infer(repo, join(repo, links.board), variants, links.variant ?? undefined)
		const changes = now ? diffValues(snapshot.values, now.values) : []
		// The ripple: a pin the board moved that the firmware still drives where it was.
		const fw = a.firmware?.pins ?? {}
		for (const pin of now?.values.pins ?? []) {
			const was = snapshot.values.pins?.find((p) => p.signal === pin.signal)
			const l = links.signals[pin.signal]?.firmware
			if (was && l && was.gpio !== pin.gpio && fw[pin.signal] === was.gpio)
				changes.push({ field: "pins", what: `the board moved ${pin.signal} to ${pinLabel(pin.gpio)}, but the firmware still drives it on ${pinLabel(was.gpio)} (${l.name}, ${l.file}:${l.line}): update it` })
		}
		out.push({ board: links.board, violations, changes })
	}
	return out
}

const INDEX = "index.json"
function readIndex(dir: string): string[] {
	return JSON.parse(readFileSync(join(dir, INDEX), "utf8")) as string[]
}

// Writes one contract per board with an MCU: <dir>/<board name>/{contract.json, links.json}, and <dir>/index.json.
export function writeContracts(repo: string, boardFiles: string[], dir: string, only?: string): { entry: string; inferred: Inferred }[] {
	const variants = firmwareVariants(repo)
	const written: { entry: string; inferred: Inferred }[] = []
	for (const file of boardFiles) {
		const inferred = infer(repo, file, variants, only)
		if (!inferred) continue
		let entry = relative(repo, file).replace(/\.kicad_pcb$/, "").replace(/[^\w.-]+/g, "_")
		while (written.some((w) => w.entry === entry)) entry += "_"
		mkdirSync(join(dir, entry), { recursive: true })
		writeFileSync(join(dir, entry, "contract.json"), `${JSON.stringify(inferred.snapshot, null, 2)}\n`)
		writeFileSync(join(dir, entry, "links.json"), `${JSON.stringify(inferred.links, null, 2)}\n`)
		written.push({ entry, inferred })
	}
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, INDEX), `${JSON.stringify(written.map((w) => w.entry), null, 2)}\n`)
	return written
}
