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

// Source of board.circuit.tsx. Parts are left to tscircuit's packer; only connectors are pinned to the edge.
export function circuitFromContract(s: ContractSnapshot): string {
	const { outline, parts = [], pins = [], connectors = [] } = s.values
	if (!outline) throw new Error("circuitFromContract: contract has no outline")
	const mcuRef = parts.find((p) => p.role === "mcu")?.ref
	const connectorRefs = new Set(connectors.map((c) => c.ref))
	const lines: string[] = []

	for (const p of parts) {
		if (connectorRefs.has(p.ref)) continue
		const labels = p.pins.length > 0 ? ` pinLabels=${pinLabels(p.pins)}` : ""
		lines.push(`<chip name=${q(p.ref)} footprint=${q(footprintFor(p))}${labels} />`)
	}

	for (const c of connectors) {
		const part = parts.find((p) => p.ref === c.ref)
		const footprint = part ? footprintFor(part) : CONNECTOR_FOOTPRINT[c.kind]
		const { x, y } = connectorPosition(c, outline.widthMm, outline.heightMm)
		lines.push(`<connector name=${q(c.ref)} footprint=${q(footprint)} pcbX={${x}} pcbY={${y}} pcbRotation={${EDGE_ROTATION[c.edge]}} />`)
	}

	for (const pin of pins) {
		if (!mcuRef) throw new Error("circuitFromContract: pin assignments need a part with role mcu")
		lines.push(`<net name=${q(pin.signal)} />`)
		lines.push(`<trace name=${q(`${pin.signal}_mcu`)} from=${q(`.${mcuRef} > .GPIO${pin.gpio}`)} to=${q(`net.${pin.signal}`)} />`)
		lines.push(`<trace name=${q(`${pin.signal}_part`)} from=${q(`.${pin.partRef} > .${pin.partPin}`)} to=${q(`net.${pin.signal}`)} />`)
	}

	return [
		"export default () => (",
		`  <board width="${outline.widthMm}mm" height="${outline.heightMm}mm">`,
		...lines.map((l) => `    ${l}`),
		"  </board>",
		")",
		"",
	].join("\n")
}
