import { readFileSync } from "node:fs"
import type { Connector, ContractSnapshot, Part } from "../contract/types.ts"

interface CatalogEntry {
	ref?: string
	role: string
	mpn: string
	lcsc: string | null
	footprint: string
	pins: string[]
}

const CATALOG: CatalogEntry[] = JSON.parse(readFileSync(new URL("../../catalog/parts.json", import.meta.url), "utf8"))

const CONNECTOR_FOOTPRINT: Record<Connector["kind"], string> = {
	"usb-c": "usbcmidmount",
	header: "pinrow4",
	button: "pushbutton",
}

// Centre of the footprint, measured in from the board edge. Verified for usbcmidmount on the left edge.
const CONNECTOR_INSET_MM = 6

// Rotation that turns the connector mouth outwards. Only the left edge has been built and checked.
const EDGE_ROTATION: Record<Connector["edge"], number> = { left: -90, right: 90, bottom: 0, top: 180 }

const q = (s: string) => JSON.stringify(s)

// A vetted catalog footprint wins over whatever the contract says, so placeholders like "module" still build.
function footprintFor(p: Part): string {
	return CATALOG.find((c) => c.mpn === p.mpn)?.footprint ?? p.footprint
}

function pinLabels(pins: string[]): string {
	return `{{ ${pins.map((name, i) => `pin${i + 1}: ${q(name)}`).join(", ")} }}`
}

// offsetMm runs from the bottom-left corner: along x for top/bottom edges, along y for left/right.
// The board is centred on the origin, as tscircuit places it.
function connectorPosition(c: Connector, w: number, h: number): { x: number; y: number } {
	switch (c.edge) {
		case "left":
			return { x: -w / 2 + CONNECTOR_INSET_MM, y: -h / 2 + c.offsetMm }
		case "right":
			return { x: w / 2 - CONNECTOR_INSET_MM, y: -h / 2 + c.offsetMm }
		case "bottom":
			return { x: -w / 2 + c.offsetMm, y: -h / 2 + CONNECTOR_INSET_MM }
		case "top":
			return { x: -w / 2 + c.offsetMm, y: h / 2 - CONNECTOR_INSET_MM }
	}
}

const GROUND_PINS = new Set(["GND", "VSS"])
const SUPPLY_PINS = new Set(["3V3", "VDD", "VCC"])
const SUPPLY_RAIL = "3V3"
const LED_RESISTOR = { resistance: "1k", footprint: "0402", lcsc: "C11702" }

// usbcmidmount numbers its 4 shell tabs pin1-pin4, then the 12 contact pads left to right. The two outer
// (wider, merged) pads on each side are GND then VBUS, as on every 16-pin USB-C receptacle. CC and D± are
// not wired yet: see catalog/README.md.
const USBC_MIDMOUNT_PADS = { GND: ["pin5", "pin16"], VBUS: ["pin6", "pin15"] }

// tscircuit rejects net names that start with a digit, so the 3V3 rail is net V3V3.
function netName(rail: string): string {
	return /^\d/.test(rail) ? `V${rail}` : rail
}

function freeRef(prefix: string, taken: Set<string>): string {
	let n = 1
	while (taken.has(`${prefix}${n}`)) n++
	return `${prefix}${n}`
}

// LED cathode to GND through a series resistor: the contract's own (a 1k first) if it has one, else an
// added 1k that is on the board but not in the contract's BOM.
function ledResistor(s: ContractSnapshot): { ref: string; a: string; b: string; added: boolean } | null {
	const { parts = [], connectors = [] } = s.values
	if (!parts.some((p) => p.role === "led" && p.pins.includes("K"))) return null
	const resistors = parts.filter((p) => p.role === "resistor")
	const own = resistors.find((p) => p.lcsc === LED_RESISTOR.lcsc) ?? resistors[0]
	if (own) return { ref: own.ref, a: own.pins[0] ?? "pin1", b: own.pins[1] ?? "pin2", added: false }
	if (!CATALOG.some((c) => c.role === "resistor")) return null
	return { ref: freeRef("R", new Set([...parts.map((p) => p.ref), ...connectors.map((c) => c.ref)])), a: "pin1", b: "pin2", added: true }
}

// ESP32-C3-MINI-1 (datasheet v2.2, Table 3-1 and Figure 11-1). Origin at the module centre, antenna toward +y.
// The 53 pads keep the datasheet's numbering and sides; their offsets are approximate (see catalog/README.md).
const MODULE_FOOTPRINT = "esp32_c3_mini_1"
const MODULE_BODY = { w: 13.2, h: 16.6 }
const MODULE_PAD_AREA_TOP = 2.9 // the top 5.4 mm is the antenna
const MODULE_PINS: Record<string, number> = {
	GND: 1, "3V3": 3, GPIO2: 5, GPIO3: 6, EN: 8, GPIO0: 12, GPIO1: 13, GPIO10: 16, GPIO4: 18, GPIO5: 19, GPIO6: 20,
	GPIO7: 21, GPIO8: 22, GPIO9: 23, GPIO18: 26, GPIO19: 27, GPIO20: 30, GPIO21: 31,
}

function modulePads(): { pin: number; x: number; y: number; w: number; h: number }[] {
	const pads = []
	for (let k = 1; k <= 11; k++) pads.push({ pin: k, x: -6.2, y: 1.3 - 0.8 * (k - 1), w: 0.8, h: 0.4 }) // left, top down
	for (let k = 12; k <= 24; k++) pads.push({ pin: k, x: -4.8 + 0.8 * (k - 12), y: -7.9, w: 0.4, h: 0.8 }) // bottom, left to right
	for (let k = 25; k <= 35; k++) pads.push({ pin: k, x: 6.2, y: -6.7 + 0.8 * (k - 25), w: 0.8, h: 0.4 }) // right, bottom up
	for (let k = 36; k <= 48; k++) pads.push({ pin: k, x: 4.8 - 0.8 * (k - 36), y: 2.5, w: 0.4, h: 0.8 }) // top GND row, right to left
	pads.push({ pin: 49, x: 0, y: -2.7, w: 5.4, h: 5.4 }) // thermal pad
	for (const [pin, x, y] of [[50, 6.2, 2.5], [51, 6.2, -7.9], [52, -6.2, -7.9], [53, -6.2, 2.5]]) pads.push({ pin, x, y, w: 0.7, h: 0.7 })
	return pads
}

function moduleFootprint(): string {
	const n = (v: number) => `${+v.toFixed(2)}mm`
	const pads = modulePads().map((p) => `<smtpad portHints={["pin${p.pin}"]} pcbX="${n(p.x)}" pcbY="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" shape="rect" />`)
	const [hw, hh] = [MODULE_BODY.w / 2, MODULE_BODY.h / 2]
	const outline = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]].map(([x, y]) => `{ x: ${x}, y: ${y} }`).join(", ")
	const antenna = `{ x: ${-hw}, y: ${MODULE_PAD_AREA_TOP} }, { x: ${hw}, y: ${MODULE_PAD_AREA_TOP} }`
	return `{<footprint>${pads.join("")}<silkscreenpath route={[${outline}]} /><silkscreenpath route={[${antenna}]} /></footprint>}`
}

function modulePinLabels(pins: string[]): string {
	const known = pins.filter((name) => MODULE_PINS[name] !== undefined)
	return `{{ ${known.map((name) => `pin${MODULE_PINS[name]}: ${q(name)}`).join(", ")} }}`
}

// Deterministic placement. Connectors sit at their contract edge and offset; every other part takes the free
// spot nearest a role-based target, on a 0.5 mm grid, keeping a 1.5 mm gap to everything already placed.
export interface Placed {
	ref: string
	x: number
	y: number
	w: number // reserved size along x and y, after rotation
	h: number
	rotation: number
}

const GAP_MM = 1.5
const EDGE_MARGIN_MM = 0.5
const GRID_MM = 0.5

// Pad bounding boxes at rotation 0, measured from tscircuit 0.0.3042 builds.
const FOOTPRINT_SIZE: Record<string, [number, number]> = {
	dfn4: [5.3, 1.87], sot23_5: [3.6, 2.5], "0402": [1.56, 0.64], "0603": [2.45, 0.95], qfn32: [5.8, 5.8],
	usbcmidmount: [9.85, 6.2], pinrow4: [9.12, 1.5], pushbutton: [6, 8], [MODULE_FOOTPRINT]: [MODULE_BODY.w, MODULE_BODY.h],
}
const DEFAULT_SIZE: [number, number] = [3, 3]

// Turns the module's antenna away from the USB-C edge.
const MODULE_ROTATION: Record<Connector["edge"], number> = { left: -90, right: 90, bottom: 0, top: 180 }

function sizeAt(footprint: string, rotation: number): [number, number] {
	const [w, h] = FOOTPRINT_SIZE[footprint] ?? DEFAULT_SIZE
	return Math.abs(rotation) % 180 === 90 ? [h, w] : [w, h]
}

// Distance from the USB-C connector centre to the LDO target; 8 mm routed cleanly at every tested width (45–70 mm).
export const LDO_FROM_USB_MM = 8

export interface PlacementOptions {
	// Distance from the USB-C connector centre to the LDO target.
	ldoFromUsbMm?: number
}

export function placeParts(s: ContractSnapshot, opts: PlacementOptions = {}): Placed[] {
	const { outline, parts = [], connectors = [] } = s.values
	if (!outline) throw new Error("placeParts: contract has no outline")
	const [W, H] = [outline.widthMm, outline.heightMm]
	const placed: Placed[] = []

	for (const c of connectors) {
		const part = parts.find((p) => p.ref === c.ref)
		const rotation = EDGE_ROTATION[c.edge]
		const [w, h] = sizeAt(part ? footprintFor(part) : CONNECTOR_FOOTPRINT[c.kind], rotation)
		placed.push({ ref: c.ref, ...connectorPosition(c, W, H), w, h, rotation })
	}

	// (u, v) runs inward from the USB-C edge and along it, so role targets don't depend on which edge that is.
	const usb = connectors.find((c) => c.kind === "usb-c")
	const edge = usb?.edge ?? "left"
	const [depth, span] = edge === "left" || edge === "right" ? [W, H] : [H, W]
	const frame = (u: number, v: number): { x: number; y: number } => {
		switch (edge) {
			case "left": return { x: -W / 2 + u, y: -H / 2 + v }
			case "right": return { x: W / 2 - u, y: -H / 2 + v }
			case "bottom": return { x: -W / 2 + v, y: -H / 2 + u }
			case "top": return { x: -W / 2 + v, y: H / 2 - u }
		}
	}

	const fits = (b: Placed) =>
		Math.abs(b.x) + b.w / 2 <= W / 2 - EDGE_MARGIN_MM &&
		Math.abs(b.y) + b.h / 2 <= H / 2 - EDGE_MARGIN_MM &&
		placed.every((o) => Math.max(Math.abs(b.x - o.x) - (b.w + o.w) / 2, Math.abs(b.y - o.y) - (b.h + o.h) / 2) >= GAP_MM)

	const place = (ref: string, footprint: string, rotation: number, want: { x: number; y: number }): Placed | undefined => {
		const [w, h] = sizeAt(footprint, rotation)
		let best: Placed | undefined
		let bestD = Infinity
		for (let i = 0; i <= W / GRID_MM; i++) {
			for (let j = 0; j <= H / GRID_MM; j++) {
				const b = { ref, x: -W / 2 + i * GRID_MM, y: -H / 2 + j * GRID_MM, w, h, rotation }
				const d = Math.hypot(b.x - want.x, b.y - want.y)
				if (d < bestD - 1e-9 && fits(b)) [best, bestD] = [b, d]
			}
		}
		if (best) placed.push(best)
		return best
	}

	const connectorRefs = new Set(connectors.map((c) => c.ref))
	const free = parts.filter((p) => !connectorRefs.has(p.ref))
	const byRole = (role: string) => free.find((p) => p.role === role)
	const usbBox = usb ? placed.find((b) => b.ref === usb.ref) : undefined
	const done = new Set<string>()
	const put = (p: Part | undefined, want: { x: number; y: number }, rotation = 0, footprint = p ? footprintFor(p) : "") => {
		if (!p || done.has(p.ref)) return undefined
		done.add(p.ref)
		return place(p.ref, footprint, rotation, want)
	}

	const mcu = put(byRole("mcu"), { x: 0, y: 0 }, MODULE_ROTATION[edge])
	const centre = mcu ?? { x: 0, y: 0 }
	// The LDO sits a fixed distance in from the USB-C connector, not halfway to the MCU: on wider boards the
	// halfway point left a gap where tscircuit's router dropped a via onto the VBUS pad (55–60 mm boards).
	const inward = { left: [1, 0], right: [-1, 0], bottom: [0, 1], top: [0, -1] }[edge]
	put(byRole("ldo"), usbBox ? { x: usbBox.x + inward[0] * (opts.ldoFromUsbMm ?? LDO_FROM_USB_MM), y: usbBox.y + inward[1] * (opts.ldoFromUsbMm ?? LDO_FROM_USB_MM) } : frame(10, span / 2))
	// The sensor goes to the far edge, in the corner away from the MCU, so neither the MCU nor the LDO heats it.
	const mcuV = edge === "left" || edge === "right" ? centre.y + H / 2 : centre.x + W / 2
	put(byRole("sensor"), frame(depth - 3, mcuV < span / 2 ? span - 4 : 4))
	const usbV = usb?.offsetMm ?? span / 2
	const led = put(byRole("led"), frame(2, usbV + 9 <= span - 3 ? usbV + 9 : usbV - 9))
	const r = ledResistor(s)
	if (r && led) {
		if (r.added) place(r.ref, LED_RESISTOR.footprint, 0, led)
		else put(free.find((p) => p.ref === r.ref), led)
	}
	for (const p of free) put(p, centre)
	return placed
}

function at(placement: Map<string, Placed>, ref: string): string {
	const b = placement.get(ref)
	return b ? ` pcbX={${+b.x.toFixed(2)}} pcbY={${+b.y.toFixed(2)}} pcbRotation={${b.rotation}}` : ""
}

// GND, the 3V3 rail and VBUS, so the board is powered and not just a set of signal traces. A net is only
// emitted when it reaches at least two components; a one-component net can't be routed.
function powerLines(s: ContractSnapshot, footprintOf: Map<string, string>, placement: Map<string, Placed>): string[] {
	const { parts = [], rails = [], connectors = [] } = s.values
	const supply = netName(SUPPLY_RAIL)
	const nets = new Map<string, string[]>([["GND", []], [supply, []], ["VBUS", []]])
	const lines: string[] = []
	const port = (ref: string, pin: string) => `.${ref} > .${pin}`
	const hasSupply = rails.some((r) => r.name === SUPPLY_RAIL)
	const ldo = parts.find((p) => p.role === "ldo")

	for (const p of parts) {
		for (const pin of p.pins) {
			if (GROUND_PINS.has(pin)) nets.get("GND")!.push(port(p.ref, pin))
			if (hasSupply && p.role !== "ldo" && SUPPLY_PINS.has(pin)) nets.get(supply)!.push(port(p.ref, pin))
		}
	}
	if (ldo) {
		if (hasSupply && ldo.pins.includes("VOUT")) nets.get(supply)!.push(port(ldo.ref, "VOUT"))
		for (const pin of ["VIN", "EN"]) if (ldo.pins.includes(pin)) nets.get("VBUS")!.push(port(ldo.ref, pin))
	}

	for (const c of connectors) {
		if (footprintOf.get(c.ref) !== "usbcmidmount") continue
		for (const pin of USBC_MIDMOUNT_PADS.GND) nets.get("GND")!.push(port(c.ref, pin))
		for (const pin of USBC_MIDMOUNT_PADS.VBUS) nets.get("VBUS")!.push(port(c.ref, pin))
	}

	const led = parts.find((p) => p.role === "led" && p.pins.includes("K"))
	if (led) {
		const r = ledResistor(s)
		if (r?.added) lines.push(`<resistor name=${q(r.ref)} resistance=${q(LED_RESISTOR.resistance)}${at(placement, r.ref)} footprint=${q(LED_RESISTOR.footprint)} />`)
		if (r) {
			lines.push(`<trace name=${q(`${led.ref}_K_${r.ref}`)} from=${q(port(led.ref, "K"))} to=${q(port(r.ref, r.a))} />`)
			nets.get("GND")!.push(port(r.ref, r.b))
		} else {
			nets.get("GND")!.push(port(led.ref, "K"))
		}
	}

	for (const [net, ends] of nets) {
		if (new Set(ends.map((e) => e.split(" > ")[0])).size < 2) continue
		lines.push(`<net name=${q(net)} />`)
		for (const end of ends) {
			const [ref, pin] = end.slice(1).split(" > .")
			lines.push(`<trace name=${q(`${net}_${ref}_${pin}`)} from=${q(end)} to=${q(`net.${net}`)} />`)
		}
	}
	return lines
}

// Source of board.circuit.tsx. Every part gets a fixed position from placeParts; tscircuit only routes.
export function circuitFromContract(s: ContractSnapshot, opts: PlacementOptions = {}): string {
	const { outline, parts = [], pins = [], connectors = [] } = s.values
	if (!outline) throw new Error("circuitFromContract: contract has no outline")
	const mcuRef = parts.find((p) => p.role === "mcu")?.ref
	const connectorRefs = new Set(connectors.map((c) => c.ref))
	const lines: string[] = []
	const footprintOf = new Map<string, string>()
	const placement = new Map(placeParts(s, opts).map((b) => [b.ref, b]))

	for (const p of parts) {
		if (connectorRefs.has(p.ref)) continue
		const footprint = footprintFor(p)
		const isModule = footprint === MODULE_FOOTPRINT
		const labels = p.pins.length > 0 ? ` pinLabels=${isModule ? modulePinLabels(p.pins) : pinLabels(p.pins)}` : ""
		lines.push(`<chip name=${q(p.ref)}${labels}${at(placement, p.ref)} footprint=${isModule ? moduleFootprint() : q(footprint)} />`)
	}

	for (const c of connectors) {
		const part = parts.find((p) => p.ref === c.ref)
		const footprint = part ? footprintFor(part) : CONNECTOR_FOOTPRINT[c.kind]
		footprintOf.set(c.ref, footprint)
		const { x, y } = connectorPosition(c, outline.widthMm, outline.heightMm)
		lines.push(`<connector name=${q(c.ref)} footprint=${q(footprint)} pcbX={${x}} pcbY={${y}} pcbRotation={${EDGE_ROTATION[c.edge]}} />`)
	}

	for (const pin of pins) {
		if (!mcuRef) throw new Error("circuitFromContract: pin assignments need a part with role mcu")
		lines.push(`<net name=${q(pin.signal)} />`)
		lines.push(`<trace name=${q(`${pin.signal}_mcu`)} from=${q(`.${mcuRef} > .GPIO${pin.gpio}`)} to=${q(`net.${pin.signal}`)} />`)
		lines.push(`<trace name=${q(`${pin.signal}_part`)} from=${q(`.${pin.partRef} > .${pin.partPin}`)} to=${q(`net.${pin.signal}`)} />`)
	}

	lines.push(...powerLines(s, footprintOf, placement))

	return [
		"export default () => (",
		`  <board width="${outline.widthMm}mm" height="${outline.heightMm}mm">`,
		...lines.map((l) => `    ${l}`),
		"  </board>",
		")",
		"",
	].join("\n")
}
