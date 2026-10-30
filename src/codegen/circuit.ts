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
const LED_RESISTOR = { resistance: "1k", footprint: "0402" }

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

// GND, the 3V3 rail and VBUS, so the board is powered and not just a set of signal traces. A net is only
// emitted when it reaches at least two components; a one-component net can't be routed.
function powerLines(s: ContractSnapshot, footprintOf: Map<string, string>): string[] {
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

	// LED cathode to GND through a series resistor: the contract's own if it has one, else an added 1k.
	const led = parts.find((p) => p.role === "led" && p.pins.includes("K"))
	if (led) {
		const contractResistor = parts.find((p) => p.role === "resistor")
		let r: { ref: string; a: string; b: string } | null = null
		if (contractResistor) {
			r = { ref: contractResistor.ref, a: contractResistor.pins[0] ?? "pin1", b: contractResistor.pins[1] ?? "pin2" }
		} else if (CATALOG.some((c) => c.role === "resistor")) {
			r = { ref: freeRef("R", new Set([...parts.map((p) => p.ref), ...connectors.map((c) => c.ref)])), a: "pin1", b: "pin2" }
			lines.push(`<resistor name=${q(r.ref)} resistance=${q(LED_RESISTOR.resistance)} footprint=${q(LED_RESISTOR.footprint)} />`)
		}
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

// Source of board.circuit.tsx. Parts are left to tscircuit's packer; only connectors are pinned to the edge.
export function circuitFromContract(s: ContractSnapshot): string {
	const { outline, parts = [], pins = [], connectors = [] } = s.values
	if (!outline) throw new Error("circuitFromContract: contract has no outline")
	const mcuRef = parts.find((p) => p.role === "mcu")?.ref
	const connectorRefs = new Set(connectors.map((c) => c.ref))
	const lines: string[] = []
	const footprintOf = new Map<string, string>()

	for (const p of parts) {
		if (connectorRefs.has(p.ref)) continue
		const labels = p.pins.length > 0 ? ` pinLabels=${pinLabels(p.pins)}` : ""
		lines.push(`<chip name=${q(p.ref)} footprint=${q(footprintFor(p))}${labels} />`)
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

	lines.push(...powerLines(s, footprintOf))

	return [
		"export default () => (",
		`  <board width="${outline.widthMm}mm" height="${outline.heightMm}mm">`,
		...lines.map((l) => `    ${l}`),
		"  </board>",
		")",
		"",
	].join("\n")
}
