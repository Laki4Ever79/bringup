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
	dfn4: [5.3, 1.87], sot23_5: [3.6, 2.5], sot23: [3.6, 2.5], "0402": [1.56, 0.64], "0603": [2.45, 0.95], qfn32: [5.8, 5.8],
	pinrow4: [9.12, 1.5], pushbutton: [6, 8], [MODULE_FOOTPRINT]: [MODULE_BODY.w, MODULE_BODY.h],
	jst2_ph: [6, 5], // pads are 3.2 x 1.75; this reserves the S2B-PH-K housing
	// The USB-C courtyard, not its pads: the body reaches 5.5 mm behind the pad row (footprinter usbcmidmount.ts).
	usbcmidmount: [10.35, 8.4],
}
const DEFAULT_SIZE: [number, number] = [3, 3]

// Centre of the reserved box relative to the part's origin, at rotation 0.
const FOOTPRINT_OFFSET: Record<string, [number, number]> = { usbcmidmount: [0, -1.275] }

function offsetAt(footprint: string, rotation: number): { dx: number; dy: number } {
	const [ox, oy] = FOOTPRINT_OFFSET[footprint] ?? [0, 0]
	const t = (rotation * Math.PI) / 180
	return { dx: +(ox * Math.cos(t) - oy * Math.sin(t)).toFixed(3), dy: +(ox * Math.sin(t) + oy * Math.cos(t)).toFixed(3) }
}

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
	const usbBox = usb ? connectorPosition(usb, W, H) : undefined
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
	// The LED goes beside the USB-C port; the battery connector and its charger go on the port's other side.
	const usbV = usb?.offsetMm ?? span / 2
	const ledSide = usbV + 9 <= span - 3 ? 1 : -1
	put(byRole("led"), frame(2, usbV + ledSide * 9))
	put(byRole("charge-led"), frame(2, usbV + ledSide * 13))
	put(byRole("battery"), frame(4, usbV - ledSide * 10))
	put(byRole("charger"), frame(11, usbV - ledSide * 7))
	put(byRole("button"), frame(depth - 4, mcuV < span / 2 ? 4 : span - 4))
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

function at(placement: Map<string, Placed>, ref: string): string {
	const b = placement.get(ref)
	return b ? ` pcbX={${+b.x.toFixed(2)}} pcbY={${+b.y.toFixed(2)}} pcbRotation={${b.rotation}}` : ""
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
			lines.push(`<connector name=${q(p.ref)}${at(placement, p.ref)} footprint=${q(footprint)} />`)
			continue
		}
		const fp = footprint === MODULE_FOOTPRINT ? moduleFootprint() : q(footprint)
		lines.push(`<chip name=${q(p.ref)}${labelsFor(p, footprint)}${at(placement, p.ref)} footprint=${fp} />`)
	}

	for (const c of connectors) {
		const part = parts.find((p) => p.ref === c.ref)
		const footprint = part ? footprintFor(part) : CONNECTOR_FOOTPRINT[c.kind]
		const labels = part ? labelsFor(part, footprint) : ""
		const { x, y } = connectorPosition(c, outline.widthMm, outline.heightMm)
		lines.push(`<connector name=${q(c.ref)}${labels} footprint=${q(footprint)} pcbX={${x}} pcbY={${y}} pcbRotation={${EDGE_ROTATION[c.edge]}} />`)
	}

	for (const pin of pins) {
		if (!mcuRef) throw new Error("circuitFromContract: pin assignments need a part with role mcu")
		lines.push(`<net name=${q(pin.signal)} />`)
		lines.push(`<trace name=${q(`${pin.signal}_mcu`)} from=${q(`.${mcuRef} > .GPIO${pin.gpio}`)} to=${q(`net.${pin.signal}`)} />`)
		// The USB-C footprint has numbered pads only: a contract pin on it (J1.DP) goes to each pad carrying that signal.
		const part = parts.find((p) => p.ref === pin.partRef)
		const pads = part && footprintFor(part) === USBC_FOOTPRINT ? USBC_PADS[pin.partPin as keyof typeof USBC_PADS] : undefined
		for (const pad of pads ?? [pin.partPin])
			lines.push(`<trace name=${q(`${pin.signal}_part${pads && pads.length > 1 ? `_${pad}` : ""}`)} from=${q(`.${pin.partRef} > .${pad}`)} to=${q(`net.${pin.signal}`)} />`)
	}

	lines.push(...powerLines(s, placement))
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
