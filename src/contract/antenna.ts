// The ESP32-C3 module's PCB antenna and what sits near it (17 Nov 2026). Espressif's ESP32-C3 hardware design
// guidelines ("Positioning a Module on a Base Board"): the antenna past the board edge, which the placer already does
// (circuit.ts antennaOverhang), and inside the product "a clearance of at least 15 mm is recommended in all
// directions". The guideline gives no figure for parts on the base board itself, so this is advisory: the report names
// every board part within 15 mm of the antenna, and no layout changes for it yet.
// https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/pcb-layout-design.html
import { ANTENNA_MM, antennaOverhang, placeParts } from "../codegen/circuit.ts"
import type { ContractSnapshot } from "./types.ts"

export const ANTENNA_CLEARANCE_MM = 15

export interface AntennaClearance {
	edge: "top" | "bottom" | "left" | "right"
	// Board parts nearer the antenna than ANTENNA_CLEARANCE_MM, nearest first: ref and gap (mm, box to antenna).
	near: { ref: string; mm: number }[]
}

// The antenna as a box in the board-centred frame placeParts uses: its width along the edge, from where it starts over
// the board to how far it hangs past the edge.
function antennaBox(s: ContractSnapshot): { x: number; y: number; w: number; h: number; edge: AntennaClearance["edge"] } | null {
	const a = antennaOverhang(s)
	const o = s.values.outline
	if (!a || !o) return null
	const W = o.widthMm, H = o.heightMm
	const inward = a.antennaMm - a.overhangMm
	const depth = a.antennaMm
	// Its centre across the edge: half its length from where it starts, inward of the edge.
	const across = depth / 2 - inward
	if (a.edge === "top") return { x: a.alongMm - W / 2, y: H / 2 + across, w: a.widthMm, h: depth, edge: a.edge }
	if (a.edge === "bottom") return { x: a.alongMm - W / 2, y: -H / 2 - across, w: a.widthMm, h: depth, edge: a.edge }
	if (a.edge === "right") return { x: W / 2 + across, y: a.alongMm - H / 2, w: depth, h: a.widthMm, edge: a.edge }
	return { x: -W / 2 - across, y: a.alongMm - H / 2, w: depth, h: a.widthMm, edge: a.edge }
}

export function antennaClearance(s: ContractSnapshot): AntennaClearance | null {
	const ant = antennaBox(s)
	if (!ant) return null
	const mcu = (s.values.parts ?? []).find((p) => p.role === "mcu")?.ref
	const near = placeParts(s)
		.filter((b) => b.ref !== mcu)
		.map((b) => {
			const dx = Math.max(0, Math.abs(b.x - ant.x) - (b.w + ant.w) / 2)
			const dy = Math.max(0, Math.abs(b.y - ant.y) - (b.h + ant.h) / 2)
			return { ref: b.ref, mm: +Math.hypot(dx, dy).toFixed(1) }
		})
		.filter((x) => x.mm < ANTENNA_CLEARANCE_MM)
		.sort((a, b) => a.mm - b.mm || a.ref.localeCompare(b.ref))
	return { edge: ant.edge, near }
}

// The report's line: what is within the recommended clearance, or that nothing is.
export function antennaLine(s: ContractSnapshot): string | null {
	const c = antennaClearance(s)
	if (!c) return null
	return c.near.length
		? `- Antenna (advisory): ${c.near.length} part${c.near.length === 1 ? "" : "s"} within Espressif's recommended ${ANTENNA_CLEARANCE_MM} mm of the module's antenna (past the ${c.edge} edge): ${c.near.map((n) => `${n.ref} ${n.mm} mm`).join(", ")}`
		: `- Antenna: past the ${c.edge} edge, no board part within Espressif's recommended ${ANTENNA_CLEARANCE_MM} mm`
}
