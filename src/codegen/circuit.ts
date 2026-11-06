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

// usbcmidmount pads by signal. pin1-pin4 are the shell tabs; pin5-pin16 sit at the same positions as the contact
// pads of KiCad's USB_C_Receptacle_HRO_TYPE-C-31-M-12 footprint, left to right: A1/B12 GND, A4/B9 VBUS, B8, A5 CC1,
// B7 D-, A6 D+, A7 D-, B6 D+, A8, B5 CC2, B4/A9 VBUS, B1/A12 GND. The catalog names these pins; codegen maps them.
const USBC_PADS: Record<"GND" | "VBUS" | "CC1" | "CC2" | "DN" | "DP", string[]> = {
	GND: ["pin5", "pin16"], VBUS: ["pin6", "pin15"], CC1: ["pin8"], CC2: ["pin14"], DN: ["pin9", "pin11"], DP: ["pin10", "pin12"],
}
const USBC_FOOTPRINT = "usbcmidmount"
// Its two plastic locating holes (NPTH ø0.7 mm), from the built KiCad footprint, in tscircuit's frame (y up) at
// rotation 0. tscircuit's autorouter doesn't see them and dropped VBUS vias beside one (the first wake-word board, 4
// hole_clearance errors), so each can get a routing keepout: ø0.7 hole + 0.2 mm hole clearance + the via's own copper (0 errors on that board).
const USBC_LOCATING_HOLES: [number, number][] = [[-2.89, 1.055], [2.89, 1.055]]
const USBC_KEEPOUT_RADIUS_MM = 0.9
function usbKeepouts(x: number, y: number, rotationDeg: number): string[] {
	const t = (rotationDeg * Math.PI) / 180
	return USBC_LOCATING_HOLES.map(([lx, ly]) => {
		const kx = +(x + lx * Math.cos(t) - ly * Math.sin(t)).toFixed(3)
		const ky = +(y + lx * Math.sin(t) + ly * Math.cos(t)).toFixed(3)
		// The connector's own pads sit 0.17 mm from the hole: placements are allowed, traces and vias are not.
		return `<keepout shape="circle" radius={${USBC_KEEPOUT_RADIUS_MM}} pcbX={${kx}} pcbY={${ky}} layers={["top", "bottom"]} allowPlacements />`
	})
}

// pushbutton pads 1-2 and 3-4 are internally connected; the switch closes between the two sides.
const BUTTON_FOOTPRINT = "pushbutton"
const BUTTON_PADS = { A: "pin1", B: "pin3" }

// tscircuit rejects net names that start with a digit, so the 3V3 rail is net V3V3.
function netName(rail: string): string {
	return /^\d/.test(rail) ? `V${rail}` : rail
}

function freeRef(prefix: string, taken: Set<string>): string {
	let n = 1
	while (taken.has(`${prefix}${n}`)) n++
	return `${prefix}${n}`
}

// Passives every board of this kind needs. Each job takes a contract part with the same LCSC number if there is
// one, else codegen adds the part, so the board is complete either way and the BOM lists what is really on it.
interface SupportSpec {
	kind: "resistor" | "capacitor"
	value: string
	lcsc: string
	mpn: string
	footprint: string
}
const SUPPORT = {
	led: { kind: "resistor", value: "1k", lcsc: "C11702", mpn: "0402WGF1001TCE", footprint: "0402" },
	cc: { kind: "resistor", value: "5.1k", lcsc: "C25905", mpn: "0402WGF5101TCE", footprint: "0402" },
	prog: { kind: "resistor", value: "4.7k", lcsc: "C25900", mpn: "0402WGF4701TCE", footprint: "0402" },
	pullup: { kind: "resistor", value: "10k", lcsc: "C25744", mpn: "0402WGF1002TCE", footprint: "0402" },
	bypass: { kind: "capacitor", value: "1uF", lcsc: "C52923", mpn: "CL05A105KA5NQNC", footprint: "0402" },
	bulk: { kind: "capacitor", value: "10uF", lcsc: "C19702", mpn: "CL10A106KP8NNNC", footprint: "0603" },
	// The ICS-43434's SD pull-down and VDD decoupling (DS-000069 Table 8).
	pulldown: { kind: "resistor", value: "100k", lcsc: "C25741", mpn: "0402WGF1003TCE", footprint: "0402" },
	decouple: { kind: "capacitor", value: "100nF", lcsc: "C1525", mpn: "CL05B104KO5NNNC", footprint: "0402" },
} satisfies Record<string, SupportSpec>

type End = { net: string } | { ref: string; pin: string }

export interface Support {
	ref: string
	job: string // what it is for, e.g. "USB-C CC1 (J1.pin8)"
	spec: SupportSpec
	a: End // joined to the part's first pin
	b: End // joined to its second pin
	near: string // placed next to this part
	added: boolean
	pins: [string, string]
}

export function usbRef(s: ContractSnapshot): string | undefined {
	const { parts = [], connectors = [] } = s.values
	const footprintOfRef = (ref: string, fallback?: string) => {
		const part = parts.find((p) => p.ref === ref)
		return part ? footprintFor(part) : fallback
	}
	return (
		connectors.find((c) => footprintOfRef(c.ref, CONNECTOR_FOOTPRINT[c.kind]) === USBC_FOOTPRINT)?.ref ??
		parts.find((p) => footprintFor(p) === USBC_FOOTPRINT)?.ref
	)
}

export function supportParts(s: ContractSnapshot): Support[] {
	const { parts = [], connectors = [], pins = [], rails = [] } = s.values
	const supply = rails.some((r) => r.name === SUPPLY_RAIL) ? netName(SUPPLY_RAIL) : null
	const charger = parts.find((p) => p.role === "charger")
	const ldo = parts.find((p) => p.role === "ldo")
	const led = parts.find((p) => p.role === "led" && p.pins.includes("K"))
	const usb = usbRef(s)
	const jobs: Omit<Support, "ref" | "added" | "pins">[] = []
	const GND = { net: "GND" }

	if (led) jobs.push({ job: `LED ${led.ref} cathode (${led.ref}.K)`, spec: SUPPORT.led, a: { ref: led.ref, pin: "K" }, b: GND, near: led.ref })
	// A charge LED lights while the charger's open-drain CHRG pulls low, powered from VBUS, so it shows charging even
	// with the MCU asleep and never drains the cell.
	const chargeLed = parts.find((p) => p.role === "charge-led" && p.pins.includes("K"))
	if (chargeLed && charger?.pins.includes("CHRG"))
		jobs.push({ job: `charge LED ${chargeLed.ref} cathode (${chargeLed.ref}.K) to charger CHRG`, spec: SUPPORT.led, a: { ref: chargeLed.ref, pin: "K" }, b: { ref: charger.ref, pin: "CHRG" }, near: chargeLed.ref })
	// A USB-C sink needs 5.1k pull-downs on CC1 and CC2, or a C-to-C charger supplies no VBUS.
	if (usb) for (const cc of ["CC1", "CC2"] as const) jobs.push({ job: `USB-C ${cc} (${usb}.${USBC_PADS[cc][0]})`, spec: SUPPORT.cc, a: { ref: usb, pin: USBC_PADS[cc][0] }, b: GND, near: usb })
	if (charger?.pins.includes("PROG")) jobs.push({ job: `charger PROG (${charger.ref}.PROG), sets the charge current`, spec: SUPPORT.prog, a: { ref: charger.ref, pin: "PROG" }, b: GND, near: charger.ref })
	if (supply) for (const p of pins) if (/^I2C_(SDA|SCL)$/.test(p.signal)) jobs.push({ job: `${p.signal} pull-up`, spec: SUPPORT.pullup, a: { net: p.signal }, b: { net: supply }, near: p.partRef })
	// An I2S microphone: its SD line pulled down (it tristates between frames) and VDD decoupled right at the part.
	for (const mic of parts.filter((p) => p.role === "microphone")) {
		const sd = pins.find((p) => p.partRef === mic.ref && p.partPin === "SD")
		if (sd) jobs.push({ job: `${sd.signal} pull-down (${mic.ref}.SD tristates between frames)`, spec: SUPPORT.pulldown, a: { net: sd.signal }, b: GND, near: mic.ref })
		if (supply && mic.pins.includes("VDD")) jobs.push({ job: `decoupling on ${mic.ref}.VDD`, spec: SUPPORT.decouple, a: { net: supply }, b: GND, near: mic.ref })
	}
	if (charger) jobs.push({ job: "decoupling on VBUS (charger input)", spec: SUPPORT.bypass, a: { net: "VBUS" }, b: GND, near: charger.ref })
	if (ldo) jobs.push({ job: `decoupling on ${charger ? "VBAT" : "VBUS"} (LDO input)`, spec: SUPPORT.bypass, a: { net: charger ? "VBAT" : "VBUS" }, b: GND, near: ldo.ref })
	if (ldo && supply) jobs.push({ job: `decoupling on ${supply} (LDO output)`, spec: SUPPORT.bulk, a: { net: supply }, b: GND, near: ldo.ref })

	const claimed = new Set<string>()
	const taken = new Set([...parts.map((p) => p.ref), ...connectors.map((c) => c.ref)])
	return jobs.map((j) => {
		const own = parts.find((p) => p.role === j.spec.kind && p.lcsc === j.spec.lcsc && !claimed.has(p.ref))
		if (own) {
			claimed.add(own.ref)
			return { ...j, ref: own.ref, added: false, pins: [own.pins[0] ?? "pin1", own.pins[1] ?? "pin2"] }
		}
		const ref = freeRef(j.spec.kind === "resistor" ? "R" : "C", taken)
		taken.add(ref)
		return { ...j, ref, added: true, pins: ["pin1", "pin2"] }
	})
}

// Every part that ends up on the board, for the BOM: the contract's parts and connectors plus the passives
// codegen adds.
export interface BoardPart {
	ref: string
	mpn: string
	lcsc: string | null
	footprint: string
	value: string | null
	added: boolean
}

export function boardParts(s: ContractSnapshot): BoardPart[] {
	const { parts = [], connectors = [] } = s.values
	const own = parts.map((p) => ({ ref: p.ref, mpn: p.mpn, lcsc: p.lcsc, footprint: footprintFor(p), value: null, added: false }))
	const bare = connectors
		.filter((c) => !parts.some((p) => p.ref === c.ref))
		.map((c) => ({ ref: c.ref, mpn: "", lcsc: null, footprint: CONNECTOR_FOOTPRINT[c.kind], value: null, added: false }))
	const added = supportParts(s)
		.filter((x) => x.added)
		.map((x) => ({ ref: x.ref, mpn: x.spec.mpn, lcsc: x.spec.lcsc, footprint: x.spec.footprint, value: x.spec.value, added: true }))
	return [...own, ...bare, ...added]
}

// pinLabels for a part: the module's datasheet numbering, the button's two sides, or pins in order. USB-C pins are
// named in the catalog but never labelled: codegen addresses its pads directly (USBC_PADS).
function labelsFor(p: Part, footprint: string): string {
	if (p.pins.length === 0 || footprint === USBC_FOOTPRINT) return ""
	if (footprint === MODULE_FOOTPRINT) return ` pinLabels=${modulePinLabels(p.pins)}`
	if (footprint === BUTTON_FOOTPRINT && p.pins.includes("A") && p.pins.includes("B")) return ` pinLabels={{ pin1: "A", pin3: "B" }}`
	return ` pinLabels=${pinLabels(p.pins)}`
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
	// Silkscreen on the board only: the antenna hangs past the edge (placeParts), where the fab would cut it away.
	const [hw, hh] = [MODULE_BODY.w / 2, MODULE_BODY.h / 2]
	const top = +(MODULE_PAD_AREA_TOP + MODULE_EDGE_MM - 0.25).toFixed(2)
	const outline = [[-hw, top], [-hw, -hh], [hw, -hh], [hw, top]].map(([x, y]) => `{ x: ${x}, y: ${y} }`).join(", ")
	return `{<footprint>${pads.join("")}<silkscreenpath route={[${outline}]} /></footprint>}`
}

// ICS-43434 I2S microphone (TDK DS-000069 Rev 1.2, Figure 13 land pattern, Figure 3 pin configuration, Figure 15
// package). Origin at the package centre, the long side along x. Five 0.522 × 0.600 mm pads in two columns 0.822 mm
// apart, rows at +0.9, 0 and -0.9 mm; the GND ring (ø1.625 mm) is centred 1.252 mm past the second column, 1.040 mm in
// from the package's end. Figure 3 turned 90° clockwise to match Figure 13 (both top views) puts VDD, SD, WS down the
// first column and SCK, LR down the second. The ring is a plated ring around the sound hole: the datasheet asks for a
// hole larger than the 0.375 mm port and at least 0.5 mm; 0.6 mm here. Plating runs to the hole's edge, where the
// datasheet's pattern keeps copper 1.025 mm wide clear (tscircuit has no annular SMT pad); the paste stencil keeps
// solder out of it either way.
export const MIC_FOOTPRINT = "ics43434"
export const MIC_BODY = { w: 3.5, h: 2.65 }
// The sound hole, from the package centre at rotation 0.
export const MIC_PORT = { x: 0.71, y: 0, holeMm: 0.6 }
function micFootprint(): string {
	const n = (v: number) => `${+v.toFixed(3)}mm`
	const c1 = MIC_PORT.x - 1.252 - 0.822
	const c2 = MIC_PORT.x - 1.252
	const pads: [number, number, number][] = [[5, c1, 0.9], [6, c1, 0], [1, c1, -0.9], [4, c2, 0.9], [2, c2, -0.9]]
	const smt = pads.map(([pin, x, y]) => `<smtpad portHints={["pin${pin}"]} pcbX="${n(x)}" pcbY="${n(y)}" width="0.522mm" height="0.6mm" shape="rect" />`).join("")
	const ring = `<platedhole portHints={["pin3"]} pcbX="${n(MIC_PORT.x)}" pcbY="${n(MIC_PORT.y)}" holeDiameter="${n(MIC_PORT.holeMm)}" outerDiameter="1.625mm" shape="circle" />`
	const [hw, hh] = [MIC_BODY.w / 2, MIC_BODY.h / 2]
	const outline = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]].map(([x, y]) => `{ x: ${x}, y: ${y} }`).join(", ")
	return `{<footprint>${smt}${ring}<silkscreenpath route={[${outline}]} /></footprint>}`
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
	// The part's own origin, when it isn't the reserved box's centre: the module, whose antenna hangs off the board.
	ox?: number
	oy?: number
}

const GAP_MM = 1.5
const EDGE_MARGIN_MM = 0.5
const GRID_MM = 0.5

// What tscircuit counts as each part's extent at rotation 0: its courtyard where it has one, else its pads, measured
// from circuit.json of tscircuit 0.0.3042 builds (6 Nov 2026). Pad boxes alone left parts reaching past the board edge
// (J2 by 0.3 mm on 25 mm boards: tscircuit then skips autorouting altogether).
const FOOTPRINT_SIZE: Record<string, [number, number]> = {
	dfn4: [5.8, 2.8], sot23_5: [3.6, 2.5], sot23: [3.6, 2.5], "0402": [1.86, 0.94], "0603": [2.96, 1.46], qfn32: [5.8, 5.8],
	pinrow4: [9.12, 1.5], pushbutton: [7, 9], [MODULE_FOOTPRINT]: [MODULE_BODY.w, MODULE_BODY.h],
	// The S2B-PH-K housing's courtyard: 6.9 × 5.5 mm, not centred on the part (FOOTPRINT_OFFSET).
	jst2_ph: [6.9, 5.5],
	// The USB-C courtyard, not its pads: 9.84 mm along the edge (the shell's plated tabs) and 10.35 mm into the board,
	// measured at rotation 270 on a left edge and turned back to rotation 0 here.
	usbcmidmount: [9.84, 10.35],
	[MIC_FOOTPRINT]: [MIC_BODY.w, MIC_BODY.h],
}
const DEFAULT_SIZE: [number, number] = [3, 3]

// Centre of the reserved box relative to the part's origin, at rotation 0.
const FOOTPRINT_OFFSET: Record<string, [number, number]> = { usbcmidmount: [0, -0.855], jst2_ph: [0, -0.55] }

function offsetAt(footprint: string, rotation: number): { dx: number; dy: number } {
	const [ox, oy] = FOOTPRINT_OFFSET[footprint] ?? [0, 0]
	const t = (rotation * Math.PI) / 180
	return { dx: +(ox * Math.cos(t) - oy * Math.sin(t)).toFixed(3), dy: +(ox * Math.sin(t) + oy * Math.cos(t)).toFixed(3) }
}

// Turns the module's antenna away from the USB-C edge.
const MODULE_ROTATION: Record<Connector["edge"], number> = { left: -90, right: 90, bottom: 0, top: 180 }
const OPPOSITE: Record<Connector["edge"], Connector["edge"]> = { left: "right", right: "left", bottom: "top", top: "bottom" }
// The module sits at the edge opposite the USB-C port, its PCB antenna hanging past the board edge. Espressif, ESP32-C3
// Hardware Design Guidelines, "Positioning a Module on a Base Board": "place the module's on-board PCB antenna outside
// the base board", "the feed point of the antenna close to the edge", "the module should not be placed in the center
// of the board", and keep the USB port "as far away from the antenna as possible". The pad area's top row stays
// MODULE_EDGE_MM inside the edge (copper to board edge), so 0.5 mm of the 5.4 mm antenna is over the board.
export const MODULE_EDGE_MM = 0.5
export const ANTENNA_MM = MODULE_BODY.h / 2 - MODULE_PAD_AREA_TOP
// How far the antenna reaches past the board edge, which edge, and where along it (contract frame, its centre), for
// the case and the test fixture, which must leave it room. null when the design has no ESP32-C3 module.
export function antennaOverhang(s: ContractSnapshot): { edge: Connector["edge"]; alongMm: number; widthMm: number; overhangMm: number } | null {
	const { outline, parts = [] } = s.values
	const mcu = parts.find((p) => p.role === "mcu")
	if (!outline || !mcu || footprintFor(mcu) !== MODULE_FOOTPRINT) return null
	const b = placeParts(s).find((p) => p.ref === mcu.ref)
	if (!b) return null
	const usb = (s.values.connectors ?? []).find((c) => c.kind === "usb-c")
	const edge = OPPOSITE[usb?.edge ?? "left"]
	const along = edge === "left" || edge === "right" ? (b.oy ?? b.y) + outline.heightMm / 2 : (b.ox ?? b.x) + outline.widthMm / 2
	return { edge, alongMm: +along.toFixed(3), widthMm: MODULE_BODY.w, overhangMm: +(ANTENNA_MM - MODULE_EDGE_MM).toFixed(3) }
}

function sizeAt(footprint: string, rotation: number): [number, number] {
	const [w, h] = FOOTPRINT_SIZE[footprint] ?? DEFAULT_SIZE
	return Math.abs(rotation) % 180 === 90 ? [h, w] : [w, h]
}

// Distance from the USB-C connector centre to the LDO target; 8 mm routed cleanly at every tested width (45–70 mm).
export const LDO_FROM_USB_MM = 8

export interface PlacementOptions {
	// Distance from the USB-C connector centre to the LDO target.
	ldoFromUsbMm?: number
	// Routing keepouts at the USB-C locating holes. Off by default: on some layouts J1's own pad traces run too close
	// to them and tscircuit refuses the build (the 45 mm logger), so the board build tries them only after a layout
	// routes with DRC errors.
	usbKeepouts?: boolean
}

// Board mounting holes for M2 screws: 2.2 mm clearance holes, centred 3 mm in from each corner. Nothing is placed
// within the 5.5 mm keep-out square (an M2 pan head is 3.8 mm). The enclosure puts a standoff under each one.
export const MOUNTING_HOLE = { diameterMm: 2.2, insetMm: 3, keepoutMm: 5.5 }

export interface MountingHole {
	ref: string
	x: number // board-centred, like pcbX/pcbY
	y: number
	diameterMm: number
}

function connectorBoxes(s: ContractSnapshot, W: number, H: number): Placed[] {
	const { parts = [], connectors = [] } = s.values
	return connectors.map((c) => {
		const part = parts.find((p) => p.ref === c.ref)
		const rotation = EDGE_ROTATION[c.edge]
		const footprint = part ? footprintFor(part) : CONNECTOR_FOOTPRINT[c.kind]
		const [w, h] = sizeAt(footprint, rotation)
		const { x, y } = connectorPosition(c, W, H)
		const { dx, dy } = offsetAt(footprint, rotation)
		return { ref: c.ref, x: x + dx, y: y + dy, w, h, rotation }
	})
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
	Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2

// The corner holes the board gets: H1 bottom-left, H2 bottom-right, H3 top-left, H4 top-right. A corner whose
// keep-out a connector already covers gets no hole, so the enclosure gets no standoff there either.
export function mountingHoles(s: ContractSnapshot): MountingHole[] {
	const { outline } = s.values
	if (!outline) return []
	const [W, H] = [outline.widthMm, outline.heightMm]
	const dx = W / 2 - MOUNTING_HOLE.insetMm
	const dy = H / 2 - MOUNTING_HOLE.insetMm
	const corners = [[-dx, -dy], [dx, -dy], [-dx, dy], [dx, dy]]
	const taken = connectorBoxes(s, W, H)
	const k = MOUNTING_HOLE.keepoutMm
	return corners
		.map(([x, y], i) => ({ ref: `H${i + 1}`, x: +x.toFixed(3), y: +y.toFixed(3), diameterMm: MOUNTING_HOLE.diameterMm }))
		.filter((h) => !taken.some((b) => overlaps(b, { x: h.x, y: h.y, w: k, h: k })))
}

// Where the board generator places each part with this role, in the contract frame (origin at the board's
// bottom-left corner). The case and the stub builders read positions from here, so they agree with the board.
export function placedByRole(s: ContractSnapshot, role: string): { ref: string; xMm: number; yMm: number; rotation: number }[] {
	const { outline, parts = [] } = s.values
	const refs = new Set(parts.filter((p) => p.role === role).map((p) => p.ref))
	if (!outline || refs.size === 0) return []
	return placeParts(s).filter((p) => refs.has(p.ref)).map((p) => ({ ref: p.ref, xMm: (p.ox ?? p.x) + outline.widthMm / 2, yMm: (p.oy ?? p.y) + outline.heightMm / 2, rotation: p.rotation }))
}

// Each bottom-port microphone's sound hole, in the contract frame: MIC_PORT turned by the part's rotation.
export function micPorts(s: ContractSnapshot): { ref: string; xMm: number; yMm: number }[] {
	return placedByRole(s, "microphone").map((p) => {
		const r = (p.rotation * Math.PI) / 180
		const dx = MIC_PORT.x * Math.cos(r) - MIC_PORT.y * Math.sin(r)
		const dy = MIC_PORT.x * Math.sin(r) + MIC_PORT.y * Math.cos(r)
		return { ref: p.ref, xMm: +(p.xMm + dx).toFixed(3), yMm: +(p.yMm + dy).toFixed(3) }
	})
}

export function placeParts(s: ContractSnapshot, opts: PlacementOptions = {}): Placed[] {
	const { outline, parts = [], connectors = [] } = s.values
	if (!outline) throw new Error("placeParts: contract has no outline")
	const [W, H] = [outline.widthMm, outline.heightMm]
	const placed: Placed[] = connectorBoxes(s, W, H)
	// Hole keep-outs block placement but are not parts, so they are not returned.
	const keepouts = mountingHoles(s).map((h) => ({ x: h.x, y: h.y, w: MOUNTING_HOLE.keepoutMm, h: MOUNTING_HOLE.keepoutMm }))

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
		placed.every((o) => Math.max(Math.abs(b.x - o.x) - (b.w + o.w) / 2, Math.abs(b.y - o.y) - (b.h + o.h) / 2) >= GAP_MM) &&
		keepouts.every((o) => !overlaps(b, o))

	const place = (ref: string, footprint: string, rotation: number, want: { x: number; y: number }): Placed | undefined => {
		const [w, h] = sizeAt(footprint, rotation)
		// A footprint whose extent isn't centred on its origin (FOOTPRINT_OFFSET): the box is placed, the part sits off it.
		const { dx, dy } = offsetAt(footprint, rotation)
		let best: Placed | undefined
		let bestD = Infinity
		for (let i = 0; i <= W / GRID_MM; i++) {
			for (let j = 0; j <= H / GRID_MM; j++) {
				const b = { ref, x: -W / 2 + i * GRID_MM, y: -H / 2 + j * GRID_MM, w, h, rotation }
				const d = Math.hypot(b.x - want.x, b.y - want.y)
				if (d < bestD - 1e-9 && fits(b)) [best, bestD] = [b, d]
			}
		}
		if (best && (dx !== 0 || dy !== 0)) best = { ...best, ox: +(best.x - dx).toFixed(3), oy: +(best.y - dy).toFixed(3) }
		if (best) placed.push(best)
		return best
	}

	const connectorRefs = new Set(connectors.map((c) => c.ref))
	const free = parts.filter((p) => !connectorRefs.has(p.ref))
	const byRole = (role: string) => free.find((p) => p.role === role)
	const usbBox = usb ? connectorPosition(usb, W, H) : undefined
	const done = new Set<string>()
	const put = (p: Part | undefined, want: { x: number; y: number }, rotation = 0, footprint = p ? footprintFor(p) : "") => {
		if (!p || done.has(p.ref)) return undefined
		done.add(p.ref)
		return place(p.ref, footprint, rotation, want)
	}

	// The module: at the far edge, centred along it, its antenna past the edge (MODULE_ROTATION, antennaOverhang).
	// Only its on-board part reserves room; a module that collides with a connector or a hole keep-out isn't placed.
	// Centred along the edge, or the nearest free spot along it (a connector on that edge, a hole keep-out).
	const placeModule = (p: Part): Placed | undefined => {
		done.add(p.ref)
		const rotation = MODULE_ROTATION[edge]
		const onBoard = MODULE_BODY.h / 2 + MODULE_PAD_AREA_TOP + MODULE_EDGE_MM
		const [w, h] = edge === "left" || edge === "right" ? [onBoard, MODULE_BODY.w] : [MODULE_BODY.w, onBoard]
		const half = MODULE_BODY.w / 2 + EDGE_MARGIN_MM
		for (let k = 0; k <= span / GRID_MM; k++) {
			const v = span / 2 + (k % 2 === 0 ? k / 2 : -(k + 1) / 2) * GRID_MM
			if (v < half || v > span - half) continue
			const c = frame(depth - MODULE_PAD_AREA_TOP - MODULE_EDGE_MM, v)
			const box = frame(depth - onBoard / 2, v)
			const b: Placed = { ref: p.ref, x: box.x, y: box.y, w, h, rotation, ox: c.x, oy: c.y }
			const clear = placed.every((o) => Math.max(Math.abs(b.x - o.x) - (b.w + o.w) / 2, Math.abs(b.y - o.y) - (b.h + o.h) / 2) >= GAP_MM) && keepouts.every((o) => !overlaps(b, o))
			if (!clear) continue
			placed.push(b)
			return b
		}
		return undefined
	}
	const mcuPart = byRole("mcu")
	const mcu = mcuPart && footprintFor(mcuPart) === MODULE_FOOTPRINT ? placeModule(mcuPart) : put(mcuPart, { x: 0, y: 0 }, MODULE_ROTATION[edge])
	const centre = mcu ?? { x: 0, y: 0 }
	// The LDO sits a fixed distance in from the USB-C connector, not halfway to the MCU: on wider boards the
	// halfway point left a gap where tscircuit's router dropped a via onto the VBUS pad (55–60 mm boards).
	const inward = { left: [1, 0], right: [-1, 0], bottom: [0, 1], top: [0, -1] }[edge]
	put(byRole("ldo"), usbBox ? { x: usbBox.x + inward[0] * (opts.ldoFromUsbMm ?? LDO_FROM_USB_MM), y: usbBox.y + inward[1] * (opts.ldoFromUsbMm ?? LDO_FROM_USB_MM) } : frame(10, span / 2))
	// The sensor goes halfway between the USB-C edge (the LDO) and the far edge (the module), against a side edge, so
	// neither heats it much (Sensirion's design guide asks for distance from heat sources, without a figure).
	const mcuV = edge === "left" || edge === "right" ? centre.y + H / 2 : centre.x + W / 2
	put(byRole("sensor"), frame(depth / 2, span - 3))
	// The LED goes beside the USB-C port; the battery connector and its charger go on the port's other side.
	const usbV = usb?.offsetMm ?? span / 2
	const ledSide = usbV + 9 <= span - 3 ? 1 : -1
	put(byRole("led"), frame(2, usbV + ledSide * 9))
	put(byRole("charge-led"), frame(2, usbV + ledSide * 13))
	put(byRole("battery"), frame(4, usbV - ledSide * 10))
	put(byRole("charger"), frame(11, usbV - ledSide * 7))
	put(byRole("button"), frame(depth - 4, mcuV < span / 2 ? 4 : span - 4))
	// The microphone goes halfway along, against the other side edge from the sensor, away from the module's noise.
	put(byRole("microphone"), frame(depth / 2, 4))
	// Each support passive sits next to the part it serves.
	const boxOf = (ref: string) => placed.find((b) => b.ref === ref)
	for (const sp of supportParts(s)) {
		const want = boxOf(sp.near) ?? centre
		if (sp.added) {
			if (!done.has(sp.ref)) {
				done.add(sp.ref)
				place(sp.ref, sp.spec.footprint, 0, want)
			}
		} else put(free.find((p) => p.ref === sp.ref), want)
	}
	for (const p of free) put(p, centre)
	return placed
}

// Production-test pads (contract field test): one round copper pad per probed net on the bottom layer, where a
// bed-of-nails fixture's pogo pins reach the board lying face up on it. On a 2.54 mm grid, a common pogo pitch, and
// at least 3 mm in from the edge (the fixture's nest holds the board by its edge). None goes under the module (its antenna
// wants no copper), a connector, the microphone's sound hole, or a mounting hole's keep-out.
export const TEST_PAD = { diameterMm: 1.5, pitchMm: 2.54, edgeMm: 3, clearMm: 1, usbClearMm: 3 }

export interface TestPoint {
	ref: string
	net: string
	// Board-centred, like pcbX/pcbY, and in the contract frame (origin at the board's bottom-left corner), top view.
	x: number
	y: number
	xMm: number
	yMm: number
}

export function testPoints(s: ContractSnapshot): { placed: TestPoint[]; unplaced: string[] } {
	const { outline, test, parts = [], pins = [] } = s.values
	if (!outline || !test) return { placed: [], unplaced: [] }
	const [W, H] = [outline.widthMm, outline.heightMm]
	const boxes = placeParts(s)
	const byRef = new Map(boxes.map((b) => [b.ref, b]))
	const connectorRefs = new Set((s.values.connectors ?? []).map((c) => c.ref))
	const roleBox = (...roles: string[]) => roles.map((r) => parts.find((p) => p.role === r)).map((p) => p && byRef.get(p.ref)).find(Boolean)
	const blocked: { x: number; y: number; w: number; h: number }[] = [
		// Parts with a body or holes below the board's bottom face, or (the module) an antenna over it.
		...boxes.filter((b) => connectorRefs.has(b.ref) || ["mcu", "usb-c", "connector", "button", "battery"].includes(parts.find((p) => p.ref === b.ref)?.role ?? "")).map((b) =>
			// The USB-C connector's pads and locating holes leave its routing little room; a pad beside it pushed a via
			// next to a locating hole (45 mm logger: 2 hole-clearance errors, 0 without the pads).
			connectorRefs.has(b.ref) || parts.find((p) => p.ref === b.ref)?.role === "usb-c" ? { ...b, w: b.w + 2 * TEST_PAD.usbClearMm, h: b.h + 2 * TEST_PAD.usbClearMm } : b),
		...mountingHoles(s).map((h) => ({ x: h.x, y: h.y, w: MOUNTING_HOLE.keepoutMm, h: MOUNTING_HOLE.keepoutMm })),
		...micPorts(s).map((m) => ({ x: m.xMm - W / 2, y: m.yMm - H / 2, w: 3, h: 3 })),
		// Without mounting holes the fixture rests the board on corner supports (py/fixture.py: 5 mm, 3 mm in).
		...(mountingHoles(s).length ? [] : [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => ({ x: sx * (W / 2 - 3), y: sy * (H / 2 - 3), w: 5, h: 5 }))),
	]
	// Where each net is wanted: next to the part it serves, so its trace stays short. VBUS at the charger or LDO input,
	// not at the USB-C connector: there its via landed beside the connector's locating hole (45 mm logger, 2 errors).
	const anchor = (net: string): { x: number; y: number } => {
		const pin = pins.find((p) => p.signal === net)
		const box = pin ? byRef.get(pin.partRef) : net === "VBUS" ? roleBox("charger", "ldo") : net === "VBAT" ? roleBox("battery", "charger") : roleBox("ldo", "mcu")
		return box ?? { x: 0, y: 0 }
	}
	const P = TEST_PAD.pitchMm
	const half = TEST_PAD.diameterMm / 2 + TEST_PAD.clearMm
	const cells: { x: number; y: number }[] = []
	for (let i = -Math.floor(W / 2 / P); i <= Math.floor(W / 2 / P); i++)
		for (let j = -Math.floor(H / 2 / P); j <= Math.floor(H / 2 / P); j++) {
			const c = { x: +(i * P).toFixed(3), y: +(j * P).toFixed(3) }
			if (Math.abs(c.x) > W / 2 - TEST_PAD.edgeMm || Math.abs(c.y) > H / 2 - TEST_PAD.edgeMm) continue
			if (blocked.some((b) => Math.abs(c.x - b.x) < b.w / 2 + half && Math.abs(c.y - b.y) < b.h / 2 + half)) continue
			cells.push(c)
		}
	const placed: TestPoint[] = []
	const unplaced: string[] = []
	const used = new Set<number>()
	test.points.forEach((net, i) => {
		const want = anchor(net)
		let best = -1
		for (let k = 0; k < cells.length; k++) if (!used.has(k) && (best < 0 || Math.hypot(cells[k].x - want.x, cells[k].y - want.y) < Math.hypot(cells[best].x - want.x, cells[best].y - want.y) - 1e-9)) best = k
		if (best < 0) return void unplaced.push(net)
		used.add(best)
		const c = cells[best]
		placed.push({ ref: `TP${i + 1}`, net, x: c.x, y: c.y, xMm: +(c.x + W / 2).toFixed(3), yMm: +(c.y + H / 2).toFixed(3) })
	})
	return { placed, unplaced }
}

function at(placement: Map<string, Placed>, ref: string): string {
	const b = placement.get(ref)
	return b ? ` pcbX={${+(b.ox ?? b.x).toFixed(2)}} pcbY={${+(b.oy ?? b.y).toFixed(2)}} pcbRotation={${b.rotation}}` : ""
}

// The power and USB nets the generator wires on top of the contract's own signals: GND, the 3V3 rail, VBUS, VBAT (when
// there is a charger) and USB D±, with the support passives' ends. Ends are "REF.pin". Only nets that reach at least
// two components are kept; a one-component net can't be routed.
const POWER_NETS = ["GND", netName(SUPPLY_RAIL), "VBUS", "VBAT", "USB_DP", "USB_DN"]

export function generatedNets(s: ContractSnapshot): Map<string, string[]> {
	const { parts = [], rails = [], pins = [] } = s.values
	const supply = netName(SUPPLY_RAIL)
	const nets = new Map<string, string[]>(POWER_NETS.map((n) => [n, []]))
	const hasSupply = rails.some((r) => r.name === SUPPLY_RAIL)
	const ldo = parts.find((p) => p.role === "ldo")
	const charger = parts.find((p) => p.role === "charger")
	const battery = parts.find((p) => p.role === "battery")
	const mcu = parts.find((p) => p.role === "mcu")
	const usb = usbRef(s)
	const join = (net: string, ref: string, pin: string) => nets.get(net)!.push(`${ref}.${pin}`)

	for (const p of parts) {
		if (footprintFor(p) === USBC_FOOTPRINT || p.role === "button") continue
		for (const pin of p.pins) {
			if (GROUND_PINS.has(pin)) join("GND", p.ref, pin)
			if (hasSupply && p.role !== "ldo" && p.role !== "charger" && SUPPLY_PINS.has(pin)) join(supply, p.ref, pin)
		}
	}
	// The ESP32-C3 must not have EN floating; tied straight to 3V3 (the datasheet suggests an RC delay, see catalog/README.md).
	if (hasSupply && mcu?.pins.includes("EN")) join(supply, mcu.ref, "EN")

	// USB-C VBUS feeds the charger when there is one, else the LDO directly. The charger's BAT output, the battery
	// and the LDO input share VBAT.
	const ldoIn = charger ? "VBAT" : "VBUS"
	if (ldo) {
		if (hasSupply && ldo.pins.includes("VOUT")) join(supply, ldo.ref, "VOUT")
		for (const pin of ["VIN", "EN"]) if (ldo.pins.includes(pin)) join(ldoIn, ldo.ref, pin)
	}
	if (charger) {
		const chargeLed = parts.find((p) => p.role === "charge-led" && p.pins.includes("A"))
		if (chargeLed && charger.pins.includes("CHRG")) join("VBUS", chargeLed.ref, "A")
		if (charger.pins.includes("VCC")) join("VBUS", charger.ref, "VCC")
		if (charger.pins.includes("BAT")) join("VBAT", charger.ref, "BAT")
		if (battery?.pins.includes("VBAT")) join("VBAT", battery.ref, "VBAT")
	}
	if (usb) {
		for (const pad of USBC_PADS.GND) join("GND", usb, pad)
		for (const pad of USBC_PADS.VBUS) join("VBUS", usb, pad)
		// D+/D- to the ESP32-C3's native USB (GPIO19/GPIO18), unless the contract uses those GPIOs for something else.
		const usbGpiosFree = !pins.some((p) => p.gpio === 18 || p.gpio === 19)
		if (mcu?.pins.includes("GPIO18") && mcu.pins.includes("GPIO19") && usbGpiosFree) {
			for (const pad of USBC_PADS.DP) join("USB_DP", usb, pad)
			for (const pad of USBC_PADS.DN) join("USB_DN", usb, pad)
			join("USB_DP", mcu.ref, "GPIO19")
			join("USB_DN", mcu.ref, "GPIO18")
		}
	}

	// A microphone's LR select tied low puts its data in the I2S frame's left channel (DS-000069 Table 8).
	for (const m of parts.filter((p) => p.role === "microphone" && p.pins.includes("LR")))
		if (!pins.some((p) => p.partRef === m.ref && p.partPin === "LR")) join("GND", m.ref, "LR")

	// A button closes between its two sides: the side a pin assignment uses goes to the GPIO, the other to GND.
	for (const b of parts.filter((p) => p.role === "button" && p.pins.includes("A") && p.pins.includes("B"))) {
		const used = new Set(pins.filter((p) => p.partRef === b.ref).map((p) => p.partPin))
		const free = ["B", "A"].find((t) => !used.has(t))
		if (free) join("GND", b.ref, free)
	}

	for (const sp of supportParts(s)) {
		for (const [end, pin] of [[sp.a, sp.pins[0]], [sp.b, sp.pins[1]]] as const) if (!("ref" in end) && nets.has(end.net)) join(end.net, sp.ref, pin)
	}
	return new Map([...nets].filter(([, ends]) => new Set(ends.map((e) => e.split(".")[0])).size >= 2))
}

// The board ports a contract pin lands on: each pad carrying the signal on the USB-C footprint (which has numbered
// pads only, D- on pin9 and pin11), else the pin's own label. Codegen wires them; the consistency check looks for them.
export function partPads(part: Part | undefined, pin: string): string[] {
	const pads = part && footprintFor(part) === USBC_FOOTPRINT ? USBC_PADS[pin as keyof typeof USBC_PADS] : undefined
	return pads ?? [pin]
}

// What USB-C pad pinN carries, for people reading generated nets ("J1.pin10" is D+).
export function usbPadSignal(pin: string): string | undefined {
	return (Object.entries(USBC_PADS) as [string, string[]][]).find(([, pads]) => pads.includes(pin))?.[0].replace(/^DP$/, "D+").replace(/^DN$/, "D-")
}

function powerLines(s: ContractSnapshot, placement: Map<string, Placed>): string[] {
	const lines: string[] = []
	const port = (ref: string, pin: string) => `.${ref} > .${pin}`
	for (const sp of supportParts(s)) {
		if (sp.added) {
			const attr = sp.spec.kind === "resistor" ? "resistance" : "capacitance"
			lines.push(`<${sp.spec.kind} name=${q(sp.ref)} ${attr}=${q(sp.spec.value)}${at(placement, sp.ref)} footprint=${q(sp.spec.footprint)} />`)
		}
		for (const [end, pin] of [[sp.a, sp.pins[0]], [sp.b, sp.pins[1]]] as const) {
			if ("ref" in end) lines.push(`<trace name=${q(`${end.ref}_${end.pin}_${sp.ref}`)} from=${q(port(end.ref, end.pin))} to=${q(port(sp.ref, pin))} />`)
			else if (!POWER_NETS.includes(end.net)) lines.push(`<trace name=${q(`${end.net}_${sp.ref}_${pin}`)} from=${q(port(sp.ref, pin))} to=${q(`net.${end.net}`)} />`)
		}
	}
	for (const [net, ends] of generatedNets(s)) {
		lines.push(`<net name=${q(net)} />`)
		for (const end of ends) {
			const [ref, pin] = end.split(".")
			lines.push(`<trace name=${q(`${net}_${ref}_${pin}`)} from=${q(port(ref, pin))} to=${q(`net.${net}`)} />`)
		}
	}
	return lines
}

// The part's MPN on the board itself (circuit.json manufacturer_part_number), so the consistency check can compare
// what was placed with the contract's parts list.
const mpnOf = (p: Part) => (p.mpn ? ` manufacturerPartNumber=${q(p.mpn)}` : "")

// Source of board.circuit.tsx. Every part gets a fixed position from placeParts; tscircuit only routes.
export function circuitFromContract(s: ContractSnapshot, opts: PlacementOptions = {}): string {
	const { outline, parts = [], pins = [], connectors = [] } = s.values
	if (!outline) throw new Error("circuitFromContract: contract has no outline")
	const mcuRef = parts.find((p) => p.role === "mcu")?.ref
	const connectorRefs = new Set(connectors.map((c) => c.ref))
	const lines: string[] = []
	const placement = new Map(placeParts(s, opts).map((b) => [b.ref, b]))

	for (const p of parts) {
		if (connectorRefs.has(p.ref)) continue
		const footprint = footprintFor(p)
		if (footprint === USBC_FOOTPRINT) {
			lines.push(`<connector name=${q(p.ref)}${mpnOf(p)}${at(placement, p.ref)} footprint=${q(footprint)} />`)
			const b = placement.get(p.ref)
			if (b && opts.usbKeepouts) lines.push(...usbKeepouts(b.x, b.y, b.rotation))
			continue
		}
		const fp = footprint === MODULE_FOOTPRINT ? moduleFootprint() : footprint === MIC_FOOTPRINT ? micFootprint() : q(footprint)
		lines.push(`<chip name=${q(p.ref)}${labelsFor(p, footprint)}${mpnOf(p)}${at(placement, p.ref)} footprint=${fp} />`)
	}

	for (const c of connectors) {
		const part = parts.find((p) => p.ref === c.ref)
		const footprint = part ? footprintFor(part) : CONNECTOR_FOOTPRINT[c.kind]
		const labels = part ? labelsFor(part, footprint) : ""
		const { x, y } = connectorPosition(c, outline.widthMm, outline.heightMm)
		lines.push(`<connector name=${q(c.ref)}${labels}${part ? mpnOf(part) : ""} footprint=${q(footprint)} pcbX={${x}} pcbY={${y}} pcbRotation={${EDGE_ROTATION[c.edge]}} />`)
		if (footprint === USBC_FOOTPRINT && opts.usbKeepouts) lines.push(...usbKeepouts(x, y, EDGE_ROTATION[c.edge]))
	}

	for (const pin of pins) {
		if (!mcuRef) throw new Error("circuitFromContract: pin assignments need a part with role mcu")
		lines.push(`<net name=${q(pin.signal)} />`)
		lines.push(`<trace name=${q(`${pin.signal}_mcu`)} from=${q(`.${mcuRef} > .GPIO${pin.gpio}`)} to=${q(`net.${pin.signal}`)} />`)
		// The USB-C footprint has numbered pads only: a contract pin on it (J1.DP) goes to each pad carrying that signal.
		const pads = partPads(parts.find((p) => p.ref === pin.partRef), pin.partPin)
		for (const pad of pads)
			lines.push(`<trace name=${q(`${pin.signal}_part${pads.length > 1 ? `_${pad}` : ""}`)} from=${q(`.${pin.partRef} > .${pad}`)} to=${q(`net.${pin.signal}`)} />`)
	}

	lines.push(...powerLines(s, placement))
	// Test pads join their net by name: a contract signal's net, or a generated power net (one that reaches two parts).
	const nets = new Set([...pins.map((p) => p.signal), ...generatedNets(s).keys()])
	for (const tp of testPoints(s).placed.map((t) => ({ ...t, net: nets.has(t.net) ? t.net : netName(t.net) })).filter((t) => nets.has(t.net))) {
		lines.push(`<testpoint name=${q(tp.ref)} footprintVariant="pad" padShape="circle" padDiameter="${TEST_PAD.diameterMm}mm" layer="bottom" pcbX={${tp.x}} pcbY={${tp.y}} />`)
		lines.push(`<trace name=${q(`${tp.net}_${tp.ref}`)} from=${q(`.${tp.ref} > .pin1`)} to=${q(`net.${tp.net}`)} />`)
	}
	for (const h of mountingHoles(s)) lines.push(`<hole pcbX={${h.x}} pcbY={${h.y}} diameter="${h.diameterMm}mm" />`)

	return [
		"export default () => (",
		`  <board width="${outline.widthMm}mm" height="${outline.heightMm}mm" minViaHoleDiameter="0.25mm" minViaPadDiameter="0.45mm">`,
		...lines.map((l) => `    ${l}`),
		"  </board>",
		")",
		"",
	].join("\n")
}
