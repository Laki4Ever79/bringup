// The board's mechanical interface, for a design that goes into the engineer's own housing (requirements.enclosure
// "own"): everything whoever designs that housing must match, in one frame. Written as interface.md (and .json)
// beside the report, from the same placement the board generator uses, so it follows every board change.
import { antennaOverhang, micPorts, mountingHoles, placedByRole, recoveryPads, testPoints } from "../codegen/circuit.ts"
import { MODULE_FCC_ID } from "./compliance.ts"
import type { ContractSnapshot } from "./types.ts"
import { profileForPart } from "../mcu/profile.ts"

export interface MechanicalInterface {
	board: { widthMm: number; heightMm: number; thicknessMm: number }
	mountingHoles: { ref: string; xMm: number; yMm: number; diameterMm: number }[]
	openings: { ref: string; kind: string; edge: string; offsetMm: number; widthMm: number; heightMm: number }[]
	buttons: { ref: string; xMm: number; yMm: number; edge: string | null }[]
	lights: { ref: string; xMm: number; yMm: number; role: string }[]
	airflow: { ref: string; xMm: number; yMm: number }[]
	soundPorts: { ref: string; xMm: number; yMm: number }[]
	antenna: { edge: string; alongMm: number; widthMm: number; overhangMm: number; clearanceMm: number } | null
	bottomPads: { ref: string; net: string; xMm: number; yMm: number }[]
	label: string | null
}

// Espressif's hardware design guidelines: keep the module's antenna 15 mm clear of metal and other parts.
export const ANTENNA_CLEARANCE_MM = 15

export function mechanicalInterface(s: ContractSnapshot): MechanicalInterface | null {
	const o = s.values.outline
	if (!o) return null
	const [W, H] = [o.widthMm, o.heightMm]
	const connectors = s.values.connectors ?? []
	const at = (p: { xMm: number; yMm: number }) => ({ xMm: +p.xMm.toFixed(2), yMm: +p.yMm.toFixed(2) })
	const antenna = antennaOverhang(s)
	const mcu = (s.values.parts ?? []).find((p) => p.role === "mcu")
	return {
		board: { widthMm: W, heightMm: H, thicknessMm: o.thicknessMm },
		mountingHoles: mountingHoles(s).map((h) => ({ ref: h.ref, xMm: +(h.x + W / 2).toFixed(2), yMm: +(h.y + H / 2).toFixed(2), diameterMm: h.diameterMm })),
		openings: connectors.map((k) => ({ ref: k.ref, kind: k.kind, edge: k.edge, offsetMm: k.offsetMm, widthMm: k.widthMm, heightMm: k.heightMm })),
		buttons: placedByRole(s, "button").map((b) => ({ ref: b.ref, ...at(b), edge: connectors.find((k) => k.ref === b.ref)?.edge ?? null })),
		lights: ["led", "charge-led"].flatMap((role) => placedByRole(s, role).map((l) => ({ ref: l.ref, ...at(l), role }))),
		airflow: placedByRole(s, "sensor").map((p) => ({ ref: p.ref, ...at(p) })),
		soundPorts: micPorts(s).map((m) => ({ ref: m.ref, ...at(m) })),
		antenna: antenna ? { ...antenna, clearanceMm: ANTENNA_CLEARANCE_MM } : null,
		bottomPads: [...testPoints(s).placed, ...recoveryPads(s).placed].map((p) => ({ ref: p.ref, net: p.net, xMm: p.xMm, yMm: p.yMm })),
		label: (() => {
			const prof = mcu ? profileForPart(mcu) : null
			const id = prof ? prof.fccId : mcu?.mpn.toUpperCase().startsWith("ESP32-C3-MINI-1") ? MODULE_FCC_ID : undefined
			return id ? `Contains FCC ID: ${id}` : null
		})(),
	}
}

export function interfaceMarkdown(m: MechanicalInterface, boardStep: string | null): string {
	const xy = (p: { xMm: number; yMm: number }) => `(${p.xMm}, ${p.yMm}) mm`
	const list = <T>(items: T[], line: (x: T) => string, none: string) => (items.length ? items.map((x) => `- ${line(x)}`) : [`- ${none}`])
	return [
		`# Mechanical interface`,
		``,
		`This board goes into your own housing (requirements.enclosure "own"), so Bringup made no case. This is what the housing has to match. It is regenerated from the design on every change.`,
		``,
		`Frame: top view, origin at the board's bottom-left corner, x to the right, y up. Along an edge, an offset runs from the bottom (left and right edges) or from the left (top and bottom edges).`,
		``,
		`## Board`,
		`- ${m.board.widthMm} × ${m.board.heightMm} mm, ${m.board.thicknessMm} mm thick.`,
		`- 3D model with every part's height: ${boardStep ?? "board.step is made by the board build (KiCad), not available for this revision"}.`,
		``,
		`## Mounting holes`,
		...list(m.mountingHoles, (h) => `${h.ref} at ${xy(h)}, ${h.diameterMm} mm (M2)`, "none: the connectors leave no corner free; hold it by its edges"),
		``,
		`## Openings the housing needs`,
		...list(m.openings, (k) => `${k.ref} ${k.kind} on the ${k.edge} edge at ${k.offsetMm} mm, the part's opening ${k.widthMm} × ${k.heightMm} mm (add your own clearance)`, "none"),
		``,
		`## Buttons`,
		...list(m.buttons, (b) => `${b.ref} at ${xy(b)}${b.edge ? `, pressed from the ${b.edge} edge` : ", pressed from above: the housing needs a plunger or an opening over it"}`, "none"),
		``,
		`## Lights to see`,
		...list(m.lights, (l) => `${l.ref} (${l.role === "charge-led" ? "charging" : "status"}) at ${xy(l)}: a window or light pipe over it`, "none"),
		``,
		`## Air and sound`,
		...list(m.airflow, (p) => `${p.ref} (temperature/humidity sensor) at ${xy(p)}: needs outside air over it (a vent), or it measures the inside of the housing`, "no sensor that needs outside air"),
		...m.soundPorts.map((p) => `- ${p.ref} (microphone) hears through a hole in the board at ${xy(p)}: the housing needs an opening under it`),
		``,
		`## Antenna`,
		...(m.antenna
			? [`- The module's PCB antenna hangs ${m.antenna.overhangMm} mm past the ${m.antenna.edge} edge, ${m.antenna.widthMm} mm wide, centred ${m.antenna.alongMm} mm along it.`, `- Keep metal (a metal housing, screws, a battery) at least ${m.antenna.clearanceMm} mm away from it (Espressif's guideline); a metal housing needs a plastic window there.`]
			: [`- no on-board antenna`]),
		``,
		`## Pads on the underside`,
		...list(m.bottomPads, (p) => `${p.ref} ${p.net} at ${xy(p)}`, "none"),
		...(m.bottomPads.length ? [`- Leave them reachable if units will be tested or recovered in the housing, or plan to take the board out.`] : []),
		``,
		`## Label`,
		`- ${m.label ? `Your housing must carry "${m.label}" (the radio module's certification), plus your own regulatory marks.` : "No module certification label from Bringup's catalog."}`,
		``,
	].join("\n")
}
