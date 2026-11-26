import { armInputNet, armRails, withArmRails } from "../contract/arm-rails.ts"
import { armInputTvs } from "../arm/tvs.ts"
import { planeRegions, type PlaneRegion } from "./plane-regions.ts"
import { ROUTE } from "../tools/freerouting.ts"
import { chipEntry, chipSupport as catalogChipSupport, type ChipCtx, type ChipJob, type Spec as ChipSpec } from "./chip-support.ts"
import { readFileSync } from "node:fs"
import { canName, canSignals } from "../contract/links.ts"
import { isEncoderPlug, isMotorPlug } from "../mechanics/refs.ts"
import type { Connector, ContractSnapshot, Part } from "../contract/types.ts"
import { chipCrystal, chipPadLabels, chipPinLabels, chipPowerPins, chipSupport, type ChipCrystal } from "../mcu/board.ts"
import { mcuPinName } from "../mcu/pins.ts"
import { loadProfiles, profileForPart, type McuProfile } from "../mcu/profile.ts"
import { stepperDriverCtx, spindleDriverCtx } from "../cnc/board.ts"

interface CatalogEntry {
	ref?: string
	role: string
	mpn: string
	lcsc: string | null
	footprint: string
	pins: string[]
	bootPin?: string
	// The strapping pin that must read high at reset for download boot (the ESP32-C3's GPIO8).
	downloadPin?: string
	// The GPIOs that can wake the chip from deep sleep, and its strapping pins (read at reset).
	wakeGpios?: number[]
	strapGpios?: number[]
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
// An MCU with a profile and no catalog entry takes its package's footprint from the profile.
export function footprintFor(p: Part): string {
	return CATALOG.find((c) => c.mpn === p.mpn)?.footprint ?? (p.role === "mcu" ? chipProfile(p)?.package.footprint : undefined) ?? p.footprint
}

// The profile of a part that is a bare chip (not a module): its pads are labelled and powered from the profile.
function chipProfile(p: Part | undefined): McuProfile | null {
	if (!p || p.role !== "mcu") return null
	const prof = profileForPart(p)
	return prof?.kind === "chip" && prof.board.supported ? prof : null
}

// A bare chip whose pin parts sit CHIP_GAP_MM off its box: an MCU with a chip profile, or any quad package (the
// TMC2209's QFN28): with the parts' 1.5 mm gap its VCP and 5VOUT capacitors landed 6-8 mm from their pads, past
// tscircuit's 5 mm (CNC mock 8, 26 Nov 2026).
function bareChip(p: Part): boolean {
	return !!chipProfile(p) || /^(?:qfn|lqfp)\d/.test(footprintFor(p))
}

function pinLabels(pins: string[]): string {
	return `{{ ${pins.map((name, i) => `pin${i + 1}: ${q(name)}`).join(", ")} }}`
}

// offsetMm runs from the bottom-left corner: along x for top/bottom edges, along y for left/right.
// The board is centred on the origin, as tscircuit places it.
// Footprints that sit differently at an edge: the JST SH link connector's mouth faces its mounting tabs (+y), the
// opposite of the USB-C footprint's, so it turns a half turn more; and its centre is 2.5 mm in, so the mouth meets the
// edge (pads to 2.1 mm from centre, the housing's front a little past them). Seen on the 9 Nov render of the logger
// with a UART link: at the USB-C's 6 mm and rotation, its mouth faced into the board.
const EDGE_FIT: Record<string, { insetMm: number; turnDeg: number }> = { jst4_sh: { insetMm: 2.5, turnDeg: 180 }, jst6_sh: { insetMm: 2.5, turnDeg: 180 } }
const fitOf = (footprint: string) => EDGE_FIT[footprint] ?? { insetMm: CONNECTOR_INSET_MM, turnDeg: 0 }
const edgeRotation = (c: Connector, footprint: string) => {
	const turn = fitOf(footprint).turnDeg
	return turn === 0 ? EDGE_ROTATION[c.edge] : ((EDGE_ROTATION[c.edge] + turn + 540) % 360) - 180
}

function connectorPosition(c: Connector, w: number, h: number, footprint = ""): { x: number; y: number } {
	const inset = fitOf(footprint).insetMm
	switch (c.edge) {
		case "left":
			return { x: -w / 2 + inset, y: -h / 2 + c.offsetMm }
		case "right":
			return { x: w / 2 - inset, y: -h / 2 + c.offsetMm }
		case "bottom":
			return { x: -w / 2 + c.offsetMm, y: -h / 2 + inset }
		case "top":
			return { x: -w / 2 + c.offsetMm, y: h / 2 - inset }
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
// hole_clearance errors), so each can get a routing keepout: ø0.7 hole + 0.2 mm hole clearance + the via's own copper
// (0 errors on that board). 0.8 mm, not 0.9: at 0.9 tscircuit refused J1's own VBUS and GND traces 0.095 mm from it,
// so the keepout layout never built (the 45 mm logger with recovery pads, 8 Nov: 2 hole_clearance errors, 0 at 0.8).
const USBC_LOCATING_HOLES: [number, number][] = [[-2.89, 1.055], [2.89, 1.055]]
const USBC_KEEPOUT_RADIUS_MM = 0.8
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
export function netName(rail: string): string {
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
	kind: "resistor" | "capacitor" | "inductor" | "diode"
	value: string
	lcsc: string
	mpn: string
	footprint: string
}
const SUPPORT = {
	// The AP63205 step-down's parts at 5 V (Diodes AP63200/1/3/5 datasheet, Table 3 and Figure 21): L 4.7 uH (Taiyo
	// Yuden NRS4018T4R7MDGJ: 2.0 A saturation, 70 mOhm, its catalog's land pattern), C1 10 uF in, C2 2 x 22 uF out (25 V
	// X5R 0805, JLCPCB basic parts, rated over a 2S-6S pack's input), C3 100 nF BST to SW.
	buckL: { kind: "inductor", value: "4.7uH", lcsc: "C92961", mpn: "NRS4018T4R7MDGJ", footprint: "nrs4018" },
	buckIn: { kind: "capacitor", value: "10uF", lcsc: "C15850", mpn: "CL21A106KAYNNNE", footprint: "0805" },
	buckOut: { kind: "capacitor", value: "22uF", lcsc: "C45783", mpn: "CL21A226MAQNNNE", footprint: "0805" },
	// The SY8205 servo supply's parts (Silergy AN_SY8205 Rev. 0.4, Applications Information): L 4.7 uH with saturation
	// over 5.9 A (TDK SPM6545VT-4R7M-D: 10.9 A, 22 mOhm), Vout = 0.6 x (1 + 22k/3k) = 5.00 V (JLCPCB basic resistors).
	// TDK SPM6545VT-4R7M-D: 4.7 uH, 10.9 A saturation, 22 mOhm, LCSC C1332501 (2,865 in stock, 26 Nov 2026), over the
	// TPS54560's 8.3 A current limit. Before: SPM7054VT-4R7M-D (C2047699), out of stock in cad's arm package (26 Nov 2026).
	servoL: { kind: "inductor", value: "4.7uH", lcsc: "C1332501", mpn: "SPM6545VT-4R7M-D", footprint: "spm6545" },
	fbTop: { kind: "resistor", value: "22k", lcsc: "C25768", mpn: "0402WGF2202TCE", footprint: "0402" },
	fbBottom: { kind: "resistor", value: "3k", lcsc: "C25895", mpn: "0402WGF3001TCE", footprint: "0402" },
	// The arm's brick input (arm task 6, a 19.5 V laptop brick; up to 24 V): 10 uF rated 50 V; the 25 V CL21A106 sits at its rating there and keeps little of
	// its capacitance under that bias. Samsung CL31A106KBHNNNE (LCSC C13585: 10uF 50V X5R 1206).
	buckIn50: { kind: "capacitor", value: "10uF", lcsc: "C13585", mpn: "CL31A106KBHNNNE", footprint: "1206" },
	// The arm rails' 6.0 V divider top: 0.6 V x (1 + 27k/3k) (UNI-ROYAL 0402WGF2702TCE, LCSC C25771).
	fbTop27k: { kind: "resistor", value: "27k", lcsc: "C25771", mpn: "0402WGF2702TCE", footprint: "0402" },
	// The arm's brick input protection (arm task 6, lead decision 25 Nov 2026; armInrush): a TVS across the input, cathode
	// (pad 1, the band) on the brick's net, and a bulk electrolytic whose ESR damps the cable's ringing on a hot plug.
	// MDD SMBJ20A (LCSC C364296): VRWM 20.0 V, VBR 22.2-24.5 V at 1 mA, VC 32.4 V at IPP 18.6 A, 600 W (MDD SMBJ datasheet).
	tvs: { kind: "diode", value: "SMBJ20A", lcsc: "C364296", mpn: "SMBJ20A", footprint: "smb" },
	// Panasonic EEEFK1V101P (LCSC C128462): 100 uF 35 V, case F 8 x 10.2 mm, 0.16 ohm at 100 kHz, 600 mA ripple (FK datasheet).
	bulkElec: { kind: "capacitor", value: "100uF", lcsc: "C128462", mpn: "EEEFK1V101P", footprint: "cap_elec_8x10" },
	led: { kind: "resistor", value: "1k", lcsc: "C11702", mpn: "0402WGF1001TCE", footprint: "0402" },
	cc: { kind: "resistor", value: "5.1k", lcsc: "C25905", mpn: "0402WGF5101TCE", footprint: "0402" },
	prog: { kind: "resistor", value: "4.7k", lcsc: "C25900", mpn: "0402WGF4701TCE", footprint: "0402" },
	pullup: { kind: "resistor", value: "10k", lcsc: "C25744", mpn: "0402WGF1002TCE", footprint: "0402" },
	bypass: { kind: "capacitor", value: "1uF", lcsc: "C52923", mpn: "CL05A105KA5NQNC", footprint: "0402" },
	bulk: { kind: "capacitor", value: "10uF", lcsc: "C19702", mpn: "CL10A106KP8NNNC", footprint: "0603" },
	// The ICS-43434's SD pull-down and VDD decoupling (DS-000069 Table 8).
	pulldown: { kind: "resistor", value: "100k", lcsc: "C25741", mpn: "0402WGF1003TCE", footprint: "0402" },
	// An STM32's BOOT0 held low (boot from flash): 10k to GND, ST AN2586 §2.4 / AN4325 §3.
	bootPulldown: { kind: "resistor", value: "10k", lcsc: "C25744", mpn: "0402WGF1002TCE", footprint: "0402" },
	// USB full-speed device D+ pull-up where the chip has none inside (STM32F103: 1.5k to 3V3, RM0008 §23.4).
	usbPullup: { kind: "resistor", value: "1.5k", lcsc: "C25867", mpn: "0402WGF1501TCE", footprint: "0402" },
	// An ESP32 module's EN RC delay: 10 kΩ to 3V3 and 1 µF to GND (ESP32-C3-MINI-1 datasheet, "Peripheral Schematics":
	// "the recommended setting for the RC delay circuit is usually R = 10 kΩ and C = 1 µF").
	enPullup: { kind: "resistor", value: "10k", lcsc: "C25744", mpn: "0402WGF1002TCE", footprint: "0402" },
	enCap: { kind: "capacitor", value: "1uF", lcsc: "C52923", mpn: "CL05A105KA5NQNC", footprint: "0402" },
	decouple: { kind: "capacitor", value: "100nF", lcsc: "C1525", mpn: "CL05B104KO5NNNC", footprint: "0402" },
	canTerm: { kind: "resistor", value: "120", lcsc: "C25079", mpn: "0402WGF1200TCE", footprint: "0402" },
	// The USB-sense divider's top: 68k over the 100k pull-down puts VBUS 4.75–5.25 V at 2.83–3.13 V on the pin, above
	// the ESP32-C3's 2.475 V high threshold (0.75 × VDD) and under its 3.3 V supply. A JLCPCB Extended part.
	senseTop: { kind: "resistor", value: "68k", lcsc: "C36871", mpn: "0402WGF6802TCE", footprint: "0402" },
	// The DRV8833's internal regulator (VINT, 2.2 µF to GND) and charge pump (VCP, 10 nF to VM): TI DRV8833 §7.3
	// "External components" table.
	vint: { kind: "capacitor", value: "2.2uF", lcsc: "C12530", mpn: "CL05A225MQ5NSNC", footprint: "0402" },
	vcp: { kind: "capacitor", value: "10nF", lcsc: "C15195", mpn: "CL05B103KB5NNNC", footprint: "0402" },
	// An STM32F4's core regulator output with one VCAP pin: 4.7 µF ceramic, ESR < 1 Ω (DS10314 Table 16, DS10693
	// Table 18). A JLCPCB Basic part.
	vcap: { kind: "capacitor", value: "4.7uF", lcsc: "C23733", mpn: "CL05A475MP5NRNC", footprint: "0402" },
} satisfies Record<string, SupportSpec>

// Where each support passive's value comes from, for the part card (engineer, 13 Nov 2026: "explanation for each
// individual component as to why it was used"). The same sources as the comments above, as data.
const SUPPORT_SOURCES: Record<keyof typeof SUPPORT, string> = {
	buckL: "the AP63205 step-down's inductor: 4.7 µH at 5 V out (Diodes AP63200/1/3/5 datasheet, Table 3)",
	buckIn: "the AP63205 step-down's input capacitor: 10 µF (Diodes AP63200/1/3/5 datasheet, Table 3)",
	buckOut: "the AP63205 step-down's output capacitors: 2 x 22 µF (Diodes AP63200/1/3/5 datasheet, Table 3)",
	servoL: "the SY8205 servo supply's inductor: 4.7 µH, saturation over 5.9 A at 5 A out (Silergy AN_SY8205, Output inductor L)",
	fbTop: "the SY8205's feedback divider top: Vout = 0.6 V x (1 + 22k/3k) = 5.00 V (Silergy AN_SY8205)",
	fbBottom: "the SY8205's feedback divider bottom: Vout = 0.6 V x (1 + 22k/3k) = 5.00 V (Silergy AN_SY8205)",
	buckIn50: "a brick input's capacitors: 10 uF rated 50 V (the SY8368A asks at least 10 uF at IN; the AP63205's Table 3 10 uF), twice the input's voltage",
	tvs: "the brick input's TVS: SMBJ20A, stand-off 20 V over a 19.5 V brick, breakdown 22.2-24.5 V, so a hot-plug spike is held under the SY8368A's 28 V (armInrush; MDD SMBJ series datasheet)",
	bulkElec: "the brick input's bulk electrolytic: 100 uF 35 V, its ESR (0.16 ohm) damps the ringing of the cable's inductance with the ceramic input capacitors on a hot plug (Panasonic FK series datasheet)",
	fbTop27k: "the SY8368A's feedback divider top for the arm's 6 V rail: Vout = 0.6 V x (1 + 27k/3k) = 6.00 V (Silergy SY8368A Rev. 0.9C)",
	led: "a current-limiting resistor in series with the LED (any LED driven from a GPIO needs one)",
	cc: "USB Type-C: a sink presents 5.1 kΩ (Rd) on CC1 and CC2, or a C-to-C charger supplies no VBUS",
	prog: "the charger's PROG resistor sets its charge current (TP4054 datasheet, PROG table)",
	pullup: "a 10 kΩ pull-up: I2C is open-drain and needs one per line; a pin held high at reset or a driver's enable uses the same",
	bypass: "input decoupling: the regulator's and charger's datasheets ask for at least 1 µF ceramic at the input (RT9080 DS9080-09)",
	bulk: "output and bulk decoupling, 10 µF (RT9080 DS9080-09: at least 1 µF on VOUT; more for the radio's current peaks)",
	pulldown: "the ICS-43434's SD line pulled down, it tristates between frames (DS-000069 Table 8); also the USB-sense divider's bottom",
	bootPulldown: "an STM32's BOOT0 held low, so it boots from flash (ST AN2586 §2.4, AN4325 §3)",
	usbPullup: "USB full-speed device attach: 1.5 kΩ from D+ to 3V3 where the chip has none inside (STM32F103 RM0008 §23.4)",
	enPullup: "Espressif's reset RC on EN: 10 kΩ to 3V3 (ESP32-C3-MINI-1 datasheet, Peripheral Schematics)",
	enCap: "Espressif's reset RC on EN: 1 µF to GND (ESP32-C3-MINI-1 datasheet, Peripheral Schematics)",
	decouple: "100 nF decoupling right at a part's supply pin (its datasheet's recommended circuit)",
	canTerm: "120 Ω across CANH and CANL at each end of a CAN bus, the cable's characteristic impedance (TI SN65HVD230 datasheet SLOS346O, Figure 37 and §11.2.1)",
	senseTop: "the USB-sense divider's top: 68k over 100k puts VBUS at 2.83–3.13 V on the pin, above the ESP32-C3's high threshold and under its supply",
	vint: "the DRV8833's internal regulator capacitor, 2.2 µF (TI DRV8833 §7.3, external components)",
	vcp: "the DRV8833's charge-pump capacitor, 10 nF to VM (TI DRV8833 §7.3, external components)",
	vcap: "the STM32F4's internal core regulator needs 4.7 µF ceramic (ESR < 1 Ω) on its single VCAP_1 pin (DS10314 Table 16, DS10693 Table 18)",
}
// The source for a support passive's value, or null for one built on the fly (a crystal's load capacitors).
export function supportSource(spec: SupportSpec): string | null {
	const key = (Object.keys(SUPPORT) as (keyof typeof SUPPORT)[]).find((k) => SUPPORT[k] === spec)
	return key ? SUPPORT_SOURCES[key] : null
}

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
	// The decoupling trace bound its chip's catalog entry gives (chip-support.ts), over capBound's default.
	bound?: number
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

// The MCU's boot strapping pin (catalog bootPin, e.g. the ESP32-C3's GPIO9: held low at reset, it boots the ROM
// downloader), when the firmware deep-sleeps. A deep-sleeping ESP32-C3 has its USB off, so without this pin a board can
// only be reflashed while it happens to be awake, and never once a bad image stops it booting (real run 3, 7 Nov).
export function recoveryBootPin(s: ContractSnapshot): { mcu: Part; pin: string; gpio: number } | null {
	const mcu = (s.values.parts ?? []).find((p) => p.role === "mcu")
	const pin = mcu ? CATALOG.find((c) => c.mpn.toUpperCase() === mcu.mpn.toUpperCase())?.bootPin : undefined
	if (!mcu || !pin || !mcu.pins.includes(pin) || !s.values.requirements?.dutyCycle) return null
	return { mcu, pin, gpio: Number(pin.replace(/\D/g, "")) }
}

// The other pin download boot needs: on the ESP32-C3, GPIO9 low enters the ROM downloader only with GPIO8 high (TRM
// v1.4, Table 7.2-1), and GPIO8 floats at reset with no pull-up on the module (catalog notes). Without one, the recovery
// pads could land the chip in SPI download boot or the invalid combination (found researching GPIO2, 9 Nov; datasheet
// reading, not yet tried on a board). The board generator pulls it up (supportParts), so it may carry a signal that
// leaves it high at reset (a button to GND, a UART line), but not one held low: an LED, a pulled-down line.
export function downloadStrap(s: ContractSnapshot): { mcu: Part; pin: string; gpio: number } | null {
	const boot = recoveryBootPin(s)
	const pin = boot ? CATALOG.find((c) => c.mpn.toUpperCase() === boot.mcu.mpn.toUpperCase())?.downloadPin : undefined
	if (!boot || !pin || !boot.mcu.pins.includes(pin)) return null
	return { mcu: boot.mcu, pin, gpio: Number(pin.replace(/\D/g, "")) }
}

// A signal the boot pin can share with the BOOT pad: an I2C line, which the board generator pulls up, so the pin reads
// high at reset and the chip boots normally; shorting the pads only holds the open-drain bus low meanwhile.
export const sharesBootPin = (signal: string) => /^I2C_(SDA|SCL)$/.test(signal)

// USB wake (engineer, 9 Nov 2026, after real run 4's reviewer held the brief's "USB-C for flashing, no special cable"):
// a deep-sleeping board has its USB off, so a divider from VBUS to a deep-sleep wake pin wakes it when a cable is
// plugged in, and the firmware stays awake while VBUS is there; the cable alone then flashes it. The pin is the first
// free wake GPIO that is not a strapping pin (GPIO2 would read low at reset with USB unplugged). requirements.usbWake
// false turns it off. gpio is null when every wake pin is taken (a violation for the architect).
export const USB_SENSE_NET = "USB_SENSE"
export function usbWake(s: ContractSnapshot): { mcu: Part; gpio: number | null; free: number[] } | null {
	const boot = recoveryBootPin(s)
	if (!boot || s.values.requirements?.usbWake === false || !usbRef(s) || !nativeUsbWired(s)) return null
	const entry = CATALOG.find((c) => c.mpn.toUpperCase() === boot.mcu.mpn.toUpperCase())
	const used = new Set((s.values.pins ?? []).map((p) => p.gpio))
	const free = (entry?.wakeGpios ?? []).filter((g) => !(entry?.strapGpios ?? []).includes(g) && boot.mcu.pins.includes(`GPIO${g}`))
	return { mcu: boot.mcu, gpio: free.find((g) => !used.has(g)) ?? null, free }
}

// The MCU's native USB pins, from its profile (an MCU part without one is the ESP32-C3: GPIO19 D+, GPIO18 D-), when the
// part lists both; null for a chip with no USB device.
export function mcuUsbPins(mcu: Part | undefined): { dp: string; dm: string; dpIndex: number; dmIndex: number; pullupOnDp: boolean } | null {
	if (!mcu) return null
	const prof = profileForPart(mcu)
	const usb = prof ? prof.usb : { dp: "GPIO19", dm: "GPIO18" }
	if (!usb || !mcu.pins.includes(usb.dp) || !mcu.pins.includes(usb.dm)) return null
	const idx = (n: string) => prof?.pins.find((x) => x.name === n)?.index ?? Number(n.replace(/\D/g, ""))
	return { dp: usb.dp, dm: usb.dm, dpIndex: idx(usb.dp), dmIndex: idx(usb.dm), pullupOnDp: prof?.usb?.pullupOnDp ?? false }
}

// The ESP32-C3's native USB reaches the connector: GPIO18/19 on the module and not used for anything else.
// Either the generator wires them, or the contract does, D- on GPIO18 and D+ on GPIO19 to the USB-C connector (real
// system run 2: an architect assigned USB_DN/USB_DP itself, and USB wake was dropped as if the pins were taken).
function nativeUsbWired(s: ContractSnapshot): boolean {
	const native = mcuUsbPins((s.values.parts ?? []).find((p) => p.role === "mcu"))
	if (!native) return false
	const usb = usbRef(s)
	const on = (s.values.pins ?? []).filter((p) => p.gpio === native.dmIndex || p.gpio === native.dpIndex)
	return on.every((p) => p.partRef === usb && ((p.gpio === native.dmIndex && p.partPin === "DN") || (p.gpio === native.dpIndex && p.partPin === "DP")))
}

// The pins the MCU's native USB takes on a board with a USB-C port (D+ and D-): never free for another signal, or the
// generator leaves USB unwired (generatedUsb) and the one cable no longer programs the board. Empty without either.
export function nativeUsbIndexes(s: ContractSnapshot): number[] {
	const native = mcuUsbPins((s.values.parts ?? []).find((p) => p.role === "mcu"))
	return native && usbRef(s) ? [native.dpIndex, native.dmIndex] : []
}

// The MCU's native USB as the generator wires it to the USB-C port: D+/D- to the connector, when the contract uses
// neither pin for anything else (generatedNets). null when there is no port, no MCU USB, or the pins are taken.
function generatedUsb(s: ContractSnapshot): (NonNullable<ReturnType<typeof mcuUsbPins>> & { mcu: Part }) | null {
	const mcu = (s.values.parts ?? []).find((p) => p.role === "mcu")
	const native = mcuUsbPins(mcu)
	if (!mcu || !native || !usbRef(s)) return null
	if ((s.values.pins ?? []).some((p) => p.gpio === native.dpIndex || p.gpio === native.dmIndex)) return null
	return { ...native, mcu }
}

// A bare chip's crystal (its profile's clock.crystal, chipCrystal) on the board: Y1 beside the OSC_IN pad, pin 1 to
// OSC_IN, pin 3 to OSC_OUT, pins 2 and 4 to GND, a load capacitor from each crystal pin to GND (supportParts).
export interface BoardCrystal extends ChipCrystal {
	ref: string
	mcuRef: string
}
export function boardCrystal(s: ContractSnapshot): BoardCrystal | null {
	const { parts = [], connectors = [] } = s.values
	const mcu = parts.find((p) => p.role === "mcu")
	const chip = chipProfile(mcu)
	const x = chip ? chipCrystal(chip) : null
	if (!mcu || !x || !mcu.pins.includes(x.inPin) || !mcu.pins.includes(x.outPin)) return null
	return { ...x, ref: freeRef("Y", new Set([...parts.map((p) => p.ref), ...connectors.map((c) => c.ref)])), mcuRef: mcu.ref }
}

// SMD3225-4P crystal land pattern: KiCad Crystal_SMD_3225-4Pin_3.2x2.5mm (Crystal.pretty, kicad/kicad:10.0 image,
// checked 11 Nov 2026), y flipped to tscircuit's y-up: 1.4 × 1.2 mm pads, pin 1 bottom-left, counter-clockwise. Pins 1
// and 3 (diagonal) are the crystal, 2 and 4 its lid, to GND.
export const CRYSTAL_FOOTPRINT = "smd3225_4p"
const CRYSTAL_PADS: Record<string, [number, number]> = { pin1: [-1.1, -0.85], pin2: [1.1, -0.85], pin3: [1.1, 0.85], pin4: [-1.1, 0.85] }
function crystalFootprint(): string {
	const pads = Object.entries(CRYSTAL_PADS).map(([pin, [x, y]]) => `<smtpad portHints={["${pin}"]} pcbX="${x}mm" pcbY="${y}mm" width="1.4mm" height="1.2mm" shape="rect" />`)
	const outline = [[-1.6, -1.25], [1.6, -1.25], [1.6, 1.25], [-1.6, 1.25], [-1.6, -1.25]].map(([x, y]) => `{ x: ${x}, y: ${y} }`).join(", ")
	return `{<footprint>${pads.join("")}<silkscreenpath route={[${outline}]} /></footprint>}`
}

// The context each chip with a catalog support list works in (chip-support.ts ChipCtx): what feeds it, what it makes.
// Each design kind registers how it hands it (the arm's servo rails below; the CNC's stepper drivers, lead-3).
const chipContexts: ((s: ContractSnapshot, part: Part) => ChipCtx | null)[] = []
export const registerChipContext = (f: (s: ContractSnapshot, part: Part) => ChipCtx | null) => void chipContexts.push(f)
export function chipInstances(s: ContractSnapshot): { part: Part; ctx: ChipCtx; jobs: ChipJob[]; joins: { net: string; ref: string; pin: string }[] }[] {
	return (s.values.parts ?? []).flatMap((part) => {
		const entry = part.mpn ? chipEntry(part.mpn) : undefined
		if (!entry) return []
		const ctx = chipContexts.map((f) => f(s, part)).find((c) => c)
		if (!ctx) return []
		return [{ part, ctx, ...catalogChipSupport({ ref: part.ref, pins: part.pins }, entry, ctx, SUPPORT as unknown as Record<string, ChipSpec>) }]
	})
}
// The power tree's step-down (the logic's 5 V): fed by the pack or the brick (packNet), making BUCK_NET at 5 V.
registerChipContext((s, part) => (part.role === "buck" && powerTree(s)?.buck?.ref === part.ref ? { in: packNet(s), out: BUCK_NET, outV: 5 } : null))
// A CNC's stepper drivers: the motor rail, the address straps and the plug nets per motor (src/cnc/board.ts).
registerChipContext(stepperDriverCtx)
// A CNC's spindle gate driver: VCC on the logic 5 V (the power tree's step-down), OE on GND until the e-stop cuts it.
registerChipContext((s, part) => spindleDriverCtx(s, part, BUCK_NET))
// An arm's servo rail chip: fed by the brick's input, making its rail at the arm's rail voltage.
registerChipContext((s, part) => {
	const rail = (armRails(s) ?? []).find((r) => r.supplyRef === part.ref)
	return rail ? { in: armInputNet, out: rail.net, outV: rail.railV } : null
})

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
	// One set of pull-ups per bus: on a bus shared with another board, only the board its link names fits them.
	const pullups = !(s.values.links ?? []).some((l) => l.kind === "i2c" && l.i2c && !l.i2c.pullups)
	if (supply && pullups) for (const p of pins.filter((x, i) => pins.findIndex((y) => y.signal === x.signal) === i)) if (/^I2C_(SDA|SCL)$/.test(p.signal)) jobs.push({ job: `${p.signal} pull-up`, spec: SUPPORT.pullup, a: { net: p.signal }, b: { net: supply }, near: p.partRef })
	// An I2S microphone: its SD line pulled down (it tristates between frames) and VDD decoupled right at the part.
	for (const mic of parts.filter((p) => p.role === "microphone")) {
		const sd = pins.find((p) => p.partRef === mic.ref && p.partPin === "SD")
		if (sd) jobs.push({ job: `${sd.signal} pull-down (${mic.ref}.SD tristates between frames)`, spec: SUPPORT.pulldown, a: { net: sd.signal }, b: GND, near: mic.ref })
		if (supply && mic.pins.includes("VDD")) jobs.push({ job: `decoupling on ${mic.ref}.VDD`, spec: SUPPORT.decouple, a: { net: supply }, b: GND, near: mic.ref })
	}
	// A pull-cord start plug (role start): START pulled up, so it reads high once the cord's loop to GND is pulled out.
	const start = parts.find((p) => p.role === "start")
	const startPin = start ? pins.find((p) => p.partRef === start.ref && p.partPin === "START") : undefined
	if (supply && startPin) jobs.push({ job: `${startPin.signal} pull-up (${start!.ref}: high once the start cord is pulled)`, spec: SUPPORT.pullup, a: { net: startPin.signal }, b: { net: supply }, near: start!.ref })
	for (const driver of motorDrivers(parts)) {
		const vm = motorSupplyNet(parts)
		if (driver.pins.includes("VM")) {
			jobs.push({ job: `${driver.ref}.VM bulk (the motors' supply)`, spec: SUPPORT.bulk, a: { net: vm }, b: GND, near: driver.ref })
			jobs.push({ job: `${driver.ref}.VM decoupling`, spec: SUPPORT.decouple, a: { net: vm }, b: GND, near: driver.ref })
		}
		if (driver.pins.includes("VINT")) jobs.push({ job: `${driver.ref}.VINT (internal regulator) to GND`, spec: SUPPORT.vint, a: { ref: driver.ref, pin: "VINT" }, b: GND, near: driver.ref })
		// VCP to the driver's own VM pin, as TI draws it: to the VM net, tscircuit joined the far end 9.8 mm away, past
		// the 5 mm bound (the rover at 33×42 mm, 14 Nov 2026).
		if (driver.pins.includes("VCP")) jobs.push({ job: `${driver.ref}.VCP (charge pump) to VM`, spec: SUPPORT.vcp, a: { ref: driver.ref, pin: "VCP" }, b: driver.pins.includes("VM") ? { ref: driver.ref, pin: "VM" } : { net: vm }, near: driver.ref })
		if (supply && driver.pins.includes("nSLEEP")) jobs.push({ job: `${driver.ref}.nSLEEP pull-up (the driver awake)`, spec: SUPPORT.pullup, a: { ref: driver.ref, pin: "nSLEEP" }, b: { net: supply }, near: driver.ref })
	}
	// The PCA9685: 100 nF at its VDD. The servo supply's EN: 10 kΩ to GND, so the module's own 100 kΩ pull-up to VIN can't
	// hold it on once the emergency stop opens (EN at about 0.76 V from a full 2S pack, under its 1.2 V threshold).
	const pwmPart = parts.find((p) => p.role === "pwm-driver")
	if (pwmPart && supply) jobs.push({ job: `decoupling on ${pwmPart.ref}.VDD`, spec: SUPPORT.decouple, a: { net: supply }, b: GND, near: pwmPart.ref })
	// The IMU: 100 nF on VDD and on VDDIO (ST DocID030071 Rev 3, Table 2 note 1).
	const imuPart = parts.find((p) => p.role === "imu")
	if (imuPart && supply) for (const pin of ["VDD", "VDDIO"]) if (imuPart.pins.includes(pin)) jobs.push({ job: `decoupling on ${imuPart.ref}.${pin}`, spec: SUPPORT.decouple, a: { ref: imuPart.ref, pin }, b: GND, near: imuPart.ref })
	// An arm (values.arm) has a servo supply per rail (armRails) and no emergency stop: its rails are built below.
	const servoSupply = s.values.arm ? undefined : parts.find((p) => p.role === "servo-supply")
	const brick = machineInput(s)
	if (brick) {
		// The TVS picked for the brick (tvs.ts: the smallest stand-off over its maximum output); SMBJ20A when none covers it,
		// the check (inrush.ts) says so. An arm's and a CNC's brick alike.
		const { jack, net: inNet } = brick
		const t = armInputTvs(s.values.arm ? s.values.arm.input : { volts: brick.volts })
		const tvs: SupportSpec = t ? { kind: "diode", value: t.mpn, lcsc: t.lcsc, mpn: t.mpn, footprint: "smb" } : SUPPORT.tvs
		jobs.push({ job: `${inNet} TVS (${jack.ref}: a hot-plugged brick's spike under the rail chips' maximum)`, spec: tvs, a: { net: inNet }, b: GND, near: jack.ref })
		jobs.push({ job: `${inNet} bulk electrolytic (${jack.ref}: damps the cable's ringing)`, spec: SUPPORT.bulkElec, a: { net: inNet }, b: GND, near: jack.ref })
	}
	for (const rail of armRails(s) ?? []) {
		const near = rail.supplyRef
		const railChipPart = parts.find((p) => p.ref === near)
		// A chip whose catalog entry lists its parts brings them itself (chipInstances, below); this is the SY8368A's.
		if (!railChipPart || (railChipPart.mpn && chipEntry(railChipPart.mpn))) continue
		const [sw, fb] = [`${rail.net}_SW`, `${rail.net}_FB`]
		for (const k of [1, 2]) jobs.push({ job: `${near} input capacitor ${k} of 2 (IN, ${armInputNet}, at least 10 uF)`, spec: SUPPORT.buckIn50, a: { net: armInputNet }, b: GND, near })
		jobs.push({ job: `${near} inductor (LX to ${rail.net})`, spec: SUPPORT.servoL, a: { net: sw }, b: { net: rail.net }, near })
		for (let k = 1; k <= 5; k++) jobs.push({ job: `${near} output capacitor ${k} of 5 (${rail.net})`, spec: SUPPORT.buckOut, a: { net: rail.net }, b: GND, near })
		jobs.push({ job: `${near} bootstrap capacitor (BS to LX)`, spec: SUPPORT.decouple, a: { ref: near, pin: "BS" }, b: { net: sw }, near })
		jobs.push({ job: `${near} internal LDO capacitor (VCC)`, spec: SUPPORT.bypass, a: { ref: near, pin: "VCC_INT" }, b: GND, near })
		jobs.push({ job: `${near} feedback divider top (${rail.divider.voutV.toFixed(2)} V)`, spec: rail.divider.r1 === "27k" ? SUPPORT.fbTop27k : SUPPORT.fbTop, a: { net: rail.net }, b: { net: fb }, near })
		jobs.push({ job: `${near} feedback divider bottom`, spec: SUPPORT.fbBottom, a: { net: fb }, b: GND, near })
	}
	// The SY8205 servo supply (a chip: its pins include LX): AN_SY8205's parts beside it.
	if (servoSupply?.pins.includes("LX")) {
		const near = servoSupply.ref
		const vin = parts.some((p) => p.role === "battery") ? "VBAT" : "VBUS"
		for (const k of [1, 2]) jobs.push({ job: `${near} input capacitor ${k} of 2 (PVIN, at least 10 uF)`, spec: SUPPORT.buckIn, a: { net: vin }, b: GND, near })
		jobs.push({ job: `${near} inductor (LX to ${SERVO_5V_NET})`, spec: SUPPORT.servoL, a: { net: SERVO_SW_NET }, b: { net: SERVO_5V_NET }, near })
		// Over 47 uF for the SY8205 (AN_SY8205), 100 uF for the 8 A SY8368A (its characterisation's COUT): 3 or 5 x 22 uF.
		const outs = servoSupply.pins.includes("SS") ? 3 : 5
		for (let k = 1; k <= outs; k++) jobs.push({ job: `${near} output capacitor ${k} of ${outs}`, spec: SUPPORT.buckOut, a: { net: SERVO_5V_NET }, b: GND, near })
		jobs.push({ job: `${near} bootstrap capacitor (BS to LX)`, spec: SUPPORT.decouple, a: { ref: near, pin: "BS" }, b: { net: SERVO_SW_NET }, near })
		jobs.push({ job: `${near} internal LDO capacitor (VCC)`, spec: SUPPORT.bypass, a: { ref: near, pin: "VCC_INT" }, b: GND, near })
		if (servoSupply.pins.includes("SS")) jobs.push({ job: `${near} soft-start capacitor (0.6 ms)`, spec: SUPPORT.vcp, a: { ref: near, pin: "SS" }, b: GND, near })
		jobs.push({ job: `${near} feedback divider top (5.00 V)`, spec: SUPPORT.fbTop, a: { net: SERVO_5V_NET }, b: { net: SERVO_FB_NET }, near })
		jobs.push({ job: `${near} feedback divider bottom`, spec: SUPPORT.fbBottom, a: { net: SERVO_FB_NET }, b: GND, near })
	}
	if (servoSupply?.pins.includes("EN")) jobs.push({ job: `${servoSupply.ref}.EN pull-down (the servos off when the emergency stop opens)`, spec: SUPPORT.pullup, a: { ref: servoSupply.ref, pin: "EN" }, b: GND, near: servoSupply.ref })
	// A CAN transceiver: 100 nF at its VCC, and 120 Ω across the bus at a bus end (links' can.terminate).
	const can = parts.find((p) => p.role === "can-transceiver")
	if (can && supply) jobs.push({ job: `decoupling on ${can.ref}.VCC`, spec: SUPPORT.decouple, a: { net: supply }, b: GND, near: can.ref })
	for (const l of (s.values.links ?? []).filter((x) => x.kind === "can" && x.can?.terminate))
		if (can) jobs.push({ job: `${canName(l)} CAN termination, 120 Ω across CANH and CANL (this board is a bus end)`, spec: SUPPORT.canTerm, a: { net: canSignals(l).h }, b: { net: canSignals(l).l }, near: can.ref })
	if (charger) jobs.push({ job: "decoupling on VBUS (charger input)", spec: SUPPORT.bypass, a: { net: "VBUS" }, b: GND, near: charger.ref })
	const ldoInNet = ldoInputNet(s)
	if (ldo) jobs.push({ job: `decoupling on ${ldoInNet} (LDO input)`, spec: SUPPORT.bypass, a: { net: ldoInNet }, b: GND, near: ldo.ref })
	if (ldo && supply) jobs.push({ job: `decoupling on ${supply} (LDO output)`, spec: SUPPORT.bulk, a: { net: supply }, b: GND, near: ldo.ref })
	// The AP63205 step-down (a chip: its pins include SW): Table 3's parts at 5 V, beside it.
	const buckIc = powerTree(s)?.buck
	// A step-down whose catalog entry lists its parts brings them itself (chipInstances); this is the AP63205's.
	if (buckIc?.pins.includes("SW") && !(buckIc.mpn && chipEntry(buckIc.mpn))) {
		const near = buckIc.ref
		jobs.push({ job: `${buckIc.ref} input capacitor (${packNet(s)})`, spec: machineInput(s) ? SUPPORT.buckIn50 : SUPPORT.buckIn, a: { net: packNet(s) }, b: GND, near })
		jobs.push({ job: `${buckIc.ref} inductor (SW to ${BUCK_NET})`, spec: SUPPORT.buckL, a: { net: BUCK_SW_NET }, b: { net: BUCK_NET }, near })
		for (const k of [1, 2]) jobs.push({ job: `${buckIc.ref} output capacitor ${k} of 2 (${BUCK_NET})`, spec: SUPPORT.buckOut, a: { net: BUCK_NET }, b: GND, near })
		if (buckIc.pins.includes("BST")) jobs.push({ job: `${buckIc.ref} bootstrap capacitor (BST to SW)`, spec: SUPPORT.decouple, a: { ref: buckIc.ref, pin: "BST" }, b: { net: BUCK_SW_NET }, near })
	}
	// The download-boot strap pulled high (downloadStrap), unless the I2C pull-up above already does it; not on a pin that
	// drives an LED (a violation for the architect: the pull-up would light it in deep sleep).
	const strap = downloadStrap(s)
	if (strap && supply) {
		const on = pins.find((p) => p.gpio === strap.gpio)
		const pulled = on && /^I2C_(SDA|SCL)$/.test(on.signal) && pullups
		const led = on && parts.some((p) => p.ref === on.partRef && (p.role === "led" || p.role === "charge-led"))
		if (!pulled && !led) jobs.push({ job: `${strap.mcu.ref}.${strap.pin} pull-up (download boot needs it high at reset)`, spec: SUPPORT.pullup, a: on ? { net: on.signal } : { ref: strap.mcu.ref, pin: strap.pin }, b: { net: supply }, near: strap.mcu.ref })
	}
	const enMcu = parts.find((p) => p.role === "mcu" && p.pins.includes("EN"))
	if (enMcu && supply) {
		jobs.push({ job: `${enMcu.ref}.EN reset RC, 10k to 3V3 (the chip starts once 3V3 is up)`, spec: SUPPORT.enPullup, a: { net: MCU_EN_NET }, b: { net: supply }, near: enMcu.ref })
		jobs.push({ job: `${enMcu.ref}.EN reset RC, 1uF to GND (a debug cable pulls EN low to reset)`, spec: SUPPORT.enCap, a: { net: MCU_EN_NET }, b: GND, near: enMcu.ref })
	}
	const wake = usbWake(s)
	if (wake?.gpio != null) {
		jobs.push({ job: `USB-sense divider top, VBUS to ${wake.mcu.ref}.GPIO${wake.gpio} (wakes it when USB is plugged in)`, spec: SUPPORT.senseTop, a: { net: "VBUS" }, b: { net: USB_SENSE_NET }, near: wake.mcu.ref })
		jobs.push({ job: `USB-sense divider bottom (${USB_SENSE_NET} low with USB unplugged)`, spec: SUPPORT.pulldown, a: { net: USB_SENSE_NET }, b: GND, near: wake.mcu.ref })
	}

	// What the chip itself needs (its profile's support list): decoupling per supply pad, the reset pin's capacitor, a
	// boot pin pull-down. Modules bring their own.
	const mcuPart = parts.find((p) => p.role === "mcu")
	const chip = chipProfile(mcuPart)
	if (chip && mcuPart && supply)
		for (const j of chipSupport(chip, mcuPart.ref, supply)) jobs.push({ job: `${mcuPart.ref} ${j.job}`, spec: SUPPORT[j.spec], a: j.a, b: j.b, near: mcuPart.ref })
	// A chip without its own D+ pull-up (the STM32F103) gets 1.5k from D+ to the rail when its USB reaches the port.
	const usbData = generatedUsb(s)
	if (chip && usbData?.pullupOnDp && supply)
		jobs.push({ job: `${usbData.mcu.ref}.${usbData.dp} USB D+ pull-up (full-speed device attach)`, spec: SUPPORT.usbPullup, a: { ref: usbData.mcu.ref, pin: usbData.dp }, b: { net: supply }, near: usbData.mcu.ref })
	// The crystal's load capacitors, one per crystal pin (chipCrystal has the values).
	const xtal = boardCrystal(s)
	if (xtal) {
		const spec: SupportSpec = { kind: "capacitor", value: xtal.loadCap.value, lcsc: xtal.loadCap.lcsc, mpn: xtal.loadCap.mpn, footprint: "0402" }
		for (const [pin, side] of [["pin1", xtal.inPin], ["pin3", xtal.outPin]] as const)
			jobs.push({ job: `${xtal.ref} load capacitor (${xtal.ref}.${pin}, ${side})`, spec, a: { ref: xtal.ref, pin }, b: GND, near: xtal.ref })
	}

	// A capacitor on a part's pin ends its ground side on that part's own GND pin when it has one, as the datasheets draw
	// it (TI DRV8833 §9.2: VINT's 2.2 µF to its GND): to the GND net, tscircuit reached ground wherever it chose, 25 mm
	// away on the 50×29 mm rover (no ground pour), past the 5 mm bound that counts the ground return too (15 Nov 2026).
	// Capacitors only: the USB-C connector's CC resistors end on GND too, and tscircuit's connector has no GND port.
	for (const j of jobs) {
		if (j.spec.kind !== "capacitor" || !("ref" in j.a) || !("net" in j.b) || j.b.net !== "GND") continue
		const owner = parts.find((p) => p.ref === (j.a as { ref: string }).ref)
		if (owner?.pins.includes("GND")) j.b = { ref: owner.ref, pin: "GND" }
	}

	// Chips whose catalog entry lists their support parts (chip-support.ts), in the context the design gives them.
	for (const c of chipInstances(s)) {
		for (const j of c.jobs) {
			if (j.pins) throw new Error(`chip support: ${j.job} is a multi-pin part, which the board generator doesn't place yet`)
			jobs.push({ job: j.job, spec: j.spec as SupportSpec, a: j.a!, b: j.b!, near: j.near, ...(j.bound !== undefined ? { bound: j.bound } : {}) })
		}
	}

	const claimed = new Set<string>()
	const taken = new Set([...parts.map((p) => p.ref), ...connectors.map((c) => c.ref)])
	return jobs.map((j) => {
		// A passive the contract already lists stands in for the generated one it duplicates: same kind and the same part,
		// by its LCSC number or its maker's part number (an agent's CL05A105KA5NQNC under another LCSC number, or none,
		// was left wired to nothing beside the generator's own: cad's arm run C4, 26 Nov 2026). One with nets of its own
		// is the agents' wiring, not a duplicate.
		const own = parts.find((p) => p.role === j.spec.kind && (p.lcsc === j.spec.lcsc || (!p.nets && p.mpn === j.spec.mpn)) && !claimed.has(p.ref))
		if (own) {
			claimed.add(own.ref)
			return { ...j, ref: own.ref, added: false, pins: [own.pins[0] ?? "pin1", own.pins[1] ?? "pin2"] }
		}
		const ref = freeRef(j.spec.kind === "resistor" ? "R" : j.spec.kind === "inductor" ? "L" : j.spec.kind === "diode" ? "D" : "C", taken)
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
	const xtal = boardCrystal(s)
	const crystal = xtal ? [{ ref: xtal.ref, mpn: xtal.crystal.mpn, lcsc: xtal.crystal.lcsc, footprint: CRYSTAL_FOOTPRINT, value: `${xtal.mhz}MHz`, added: true }] : []
	return [...own, ...bare, ...crystal, ...added]
}

// pinLabels for a part: the module's datasheet numbering, the button's two sides, or pins in order. USB-C pins are
// named in the catalog but never labelled: codegen addresses its pads directly (USBC_PADS).
function labelsFor(p: Part, footprint: string): string {
	if (p.pins.length === 0 || footprint === USBC_FOOTPRINT) return ""
	const m = MODULES[footprint]
	if (m) return ` pinLabels=${modulePinLabels(m, p.pins)}`
	const chip = chipProfile(p)
	if (chip && footprint === chip.package.footprint) return ` pinLabels={${JSON.stringify(chipPinLabels(chip))}}`
	if (footprint === BUTTON_FOOTPRINT && p.pins.includes("A") && p.pins.includes("B")) return ` pinLabels={{ pin1: "A", pin3: "B" }}`
	return ` pinLabels=${pinLabels(p.pins)}`
}

// ESP32-C3-MINI-1 (datasheet v2.2, Table 3-1 and Figure 11-1). Origin at the module centre, antenna toward +y.
// The 53 pads keep the datasheet's numbering and sides; their offsets are approximate (see catalog/README.md).
export const MODULE_FOOTPRINT = "esp32_c3_mini_1"
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

// ESP32-S3-MINI-1 (datasheet v1.7: Figure 3-1 pin layout, Figure 11-1 recommended land pattern). Origin at the module
// centre, antenna toward +y. 15 pads a side at 0.85 mm pitch (11.9 mm between the end pads), the side columns 14 mm
// apart, the top row 5.05 mm below the antenna end; left 1-15 top down, bottom 16-30 left to right, right 31-45 bottom up,
// top 46-60 right to left; corner pads 62 (top left), 63, 64, 65 (top right); pin 61 the 4.5 mm thermal pad of nine
// 1.2 mm squares. The offsets are read off the figure, approximate (see catalog/README.md), like the C3's.
const S3_BODY = { w: 15.4, h: 20.5 }
const S3_TOP_ROW = S3_BODY.h / 2 - 5.05
function s3Pads(): { pin: number; x: number; y: number; w: number; h: number }[] {
	const pads = []
	const c = S3_TOP_ROW - 7 // the pad field's centre
	const at = (k: number) => 0.85 * (k - 7) // k = 0..14 along a side
	for (let k = 0; k < 15; k++) pads.push({ pin: 1 + k, x: -7, y: c - at(k), w: 0.8, h: 0.4 }) // left, top down
	for (let k = 0; k < 15; k++) pads.push({ pin: 16 + k, x: at(k), y: c - 7, w: 0.4, h: 0.8 }) // bottom, left to right
	for (let k = 0; k < 15; k++) pads.push({ pin: 31 + k, x: 7, y: c + at(k), w: 0.8, h: 0.4 }) // right, bottom up
	for (let k = 0; k < 15; k++) pads.push({ pin: 46 + k, x: -at(k), y: c + 7, w: 0.4, h: 0.8 }) // top, right to left
	pads.push({ pin: 61, x: 0, y: c, w: 4.5, h: 4.5 }) // thermal pad (nine 1.2 mm squares in the datasheet, one pad here)
	for (const [pin, x, y] of [[62, -7, c + 7], [63, -7, c - 7], [64, 7, c - 7], [65, 7, c + 7]]) pads.push({ pin, x, y, w: 0.8, h: 0.8 })
	return pads
}

// A radio module whose PCB antenna hangs past the board edge: its body, where its pad area ends toward the antenna, its
// pins by datasheet pad number, and its land pattern.
export interface RadioModule {
	footprint: string
	body: { w: number; h: number }
	padAreaTop: number
	pins: Record<string, number>
	pads: () => { pin: number; x: number; y: number; w: number; h: number }[]
}
// The S3's pins by pad, from its profile (catalog/mcu/esp32-s3-mini-1.json, the datasheet's Table 3-1): each GPIO's pad,
// and one pad each for GND, 3V3 and EN.
const s3Pins = (): Record<string, number> => {
	const prof = loadProfiles().find((x) => x.id === "esp32-s3-mini-1")
	if (!prof) return {}
	return Object.fromEntries([...prof.pins.map((x) => [x.name, +x.pads[0]] as const), ...prof.power.map((x) => [x.name, +x.pads[0]] as const)])
}
export const MODULES: Record<string, RadioModule> = {
	[MODULE_FOOTPRINT]: { footprint: MODULE_FOOTPRINT, body: MODULE_BODY, padAreaTop: MODULE_PAD_AREA_TOP, pins: MODULE_PINS, pads: modulePads },
	esp32_s3_mini_1: { footprint: "esp32_s3_mini_1", body: S3_BODY, padAreaTop: +(S3_TOP_ROW + 0.4).toFixed(2), get pins() { return s3Pins() }, pads: s3Pads },
}
// The radio module a part is, by its footprint; null for any other part.
export function moduleOf(p: Part | undefined): RadioModule | null {
	return p ? MODULES[footprintFor(p)] ?? null : null
}
// How far the antenna reaches past the pad area.
export const antennaOf = (m: RadioModule) => +(m.body.h / 2 - m.padAreaTop).toFixed(3)

function moduleFootprint(m: RadioModule): string {
	const n = (v: number) => `${+v.toFixed(2)}mm`
	const pads = m.pads().map((p) => `<smtpad portHints={["pin${p.pin}"]} pcbX="${n(p.x)}" pcbY="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" shape="rect" />`)
	// Silkscreen on the board only: the antenna hangs past the edge (placeParts), where the fab would cut it away.
	const [hw, hh] = [m.body.w / 2, m.body.h / 2]
	const top = +(m.padAreaTop + MODULE_EDGE_MM - 0.25).toFixed(2)
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

// LSM6DS3TR-C IMU (ST DocID030071 Rev 3: Figure 1 pin connections, bottom view; Figure 17 LGA-14 2.5x3x0.86 mm).
// Origin at the package centre, x along its 3.0 mm width, y along its 2.5 mm length, top view (the bottom view
// mirrored in x). Pads 0.25 x 0.475 mm on a 0.5 mm pitch, flush with the body's edges: 1-4 down the left side, 5-7
// left to right along the bottom, 8-11 up the right side, 12-14 right to left along the top. The lands are the pads
// 0.05 mm wider and 0.1 mm longer outward (0.3 x 0.575 mm, an estimate: ST gives its land pattern in a separate
// technical note). 0.2 mm between lands.
// Power inductors drawn from their makers' recommended land patterns: two rectangular pads, centred on the body.
//   nrs4018: Taiyo Yuden NR/NRS4018 (catalog, Recommended Land Patterns: A 1.2, B 2.8, C 3.7 mm): 1.2 x 3.7 mm pads,
//            2.8 mm apart, 4 x 4 mm body.
//   spm7054: TDK SPM7054VT-D (data sheet, Recommended land pattern: 3.3 mm tall, 3.1 mm apart, 8.8 mm overall): 2.85 x
//            3.3 mm pads, 7.5 x 7.0 mm body.
export const INDUCTOR_FOOTPRINTS: Record<string, { padW: number; padH: number; cx: number; body: [number, number] }> = {
	nrs4018: { padW: 1.2, padH: 3.7, cx: 2.0, body: [4, 4] },
	spm7054: { padW: 2.85, padH: 3.3, cx: 2.975, body: [7.5, 7.0] },
	// An 8 x 10.2 mm SMD aluminium electrolytic (Panasonic FK case F): JLCPCB's EasyEDA footprint CAP-SMD_BD8.0-L8.3-W8.3-FD for
	// C128462 (easyeda.com/api/products/C128462/components, 25 Nov 2026): 4.2 x 1.4 mm pads, centres 6.53 mm apart; pad 1 is +
	// (the chamfered corners and the + mark on its side).
	cap_elec_8x10: { padW: 4.2, padH: 1.4, cx: 3.267, body: [8.3, 8.3] },
	// A 7.1 x 6.6 mm molded power inductor (KOHER MDA7030, the LMR16010's 15 uH): JLCPCB's EasyEDA footprint
	// IND-SMD_L7.1-W6.6 for C2847486 (easyeda.com/api/products/C2847486/components, 26 Nov 2026): 2.15 x 3.32 mm pads,
	// centres 5.83 mm apart.
	mda7030: { padW: 2.15, padH: 3.32, cx: 2.913, body: [7.1, 6.6] },
	// TDK SPM6545VT (7.0 x 6.5 mm): JLCPCB's EasyEDA footprint IND-SMD_L7.0-W6.5-1 for C1332501 (26 Nov 2026): 2.3 x 3.3 mm
	// pads, centres 5.9 mm apart.
	spm6545: { padW: 2.3, padH: 3.3, cx: 2.95, body: [7.0, 6.5] },
}
export const INDUCTOR_FOOTPRINT = "nrs4018"
function inductorFootprint(name: string): string {
	const f = INDUCTOR_FOOTPRINTS[name]
	const pads = [1, 2].map((pin, i) => `<smtpad portHints={["pin${pin}"]} pcbX="${i ? f.cx : -f.cx}mm" pcbY="0mm" width="${f.padW}mm" height="${f.padH}mm" shape="rect" />`).join("")
	const [hw, hh] = [f.body[0] / 2 + 0.2, f.body[1] / 2 + 0.2]
	const outline = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]].map(([x, y]) => `{ x: ${+x.toFixed(2)}, y: ${+y.toFixed(2)} }`).join(", ")
	return `{<footprint>${pads}<silkscreenpath route={[${outline}]} /></footprint>}`
}
// Silergy SO8E (AN_SY8205 Rev. 0.4, SO8E Package outline & PCB layout design, Recommended Pad Layout): 0.60 x 1.55 mm
// pads at 1.27 mm pitch, the rows 5.40 mm apart centre to centre; 1-4 down the left, 5-8 up the right (top view); the
// exposed pad 2.55 x 3.20 mm is pin 9 (the chip's GND), so its label can wire it.
// SY8368AQQC QFN3x3-12: polygon pads from JLCPCB's own footprint (catalog/footprints/sy8368a.json, its _about).
export const SY8368_FOOTPRINT = "qfn12_sy8368a"
// A pad's centre (its polygon's box) on the SY8368A's land pattern: without it the servo buck's BS and VCC capacitors had
// no pad to sit beside and went 5-11 mm away, past their 5 mm bound (real run 21, 25 Nov 2026).
let sy8368Pads: { pin: number; points: [number, number][] }[] | undefined
function sy8368PadCentre(pin: number): { x: number; y: number } | null {
	sy8368Pads ??= (JSON.parse(readFileSync(new URL("../../catalog/footprints/sy8368a.json", import.meta.url), "utf8")) as { pads: { pin: number; points: [number, number][] }[] }).pads
	const pts = sy8368Pads.find((p) => p.pin === pin)?.points
	if (!pts) return null
	const [xs, ys] = [pts.map((q) => q[0]), pts.map((q) => q[1])]
	return { x: +((Math.min(...xs) + Math.max(...xs)) / 2).toFixed(3), y: +((Math.min(...ys) + Math.max(...ys)) / 2).toFixed(3) }
}
function sy8368Footprint(): string {
	const f = JSON.parse(readFileSync(new URL("../../catalog/footprints/sy8368a.json", import.meta.url), "utf8")) as { pads: { pin: number; points: [number, number][] }[] }
	const pads = f.pads.map((p) => `<smtpad portHints={["pin${p.pin}"]} shape="polygon" points={[${p.points.map(([x, y]) => `{ x: ${x}, y: ${y} }`).join(", ")}]} />`).join("")
	const outline = [[-1.6, -1.65], [1.6, -1.65], [1.6, 1.65], [-1.6, 1.65], [-1.6, -1.65]].map(([x, y]) => `{ x: ${x}, y: ${y} }`).join(", ")
	return `{<footprint>${pads}<silkscreenpath route={[${outline}]} /><silkscreenpath route={[{ x: -1.9, y: 1.7 }, { x: -1.9, y: 1.4 }]} /></footprint>}`
}
// Amass XT60PW-M right-angle PCB plug, from JLCPCB's EasyEDA footprint CONN-TH_XT60PW-M (C98732): the two contacts
// Ø2.9 mm drilled in Ø3.8 mm pads 7.2 mm apart (pin 1 "-", pin 2 "+"), the body's two pegs 1.8 x 0.8 mm slots in
// 2.4 x 1.4 mm pads, 6 mm behind them, 13.5 mm apart. Top view, mm.
export const XT60_FOOTPRINT = "xt60pw_m"
function xt60Footprint(): string {
	const pins = [[1, 3.0, -3.6], [2, 3.0, 3.6]].map(([pin, x, y]) => `<platedhole portHints={["pin${pin}"]} pcbX="${x}mm" pcbY="${y}mm" holeDiameter="2.9mm" outerDiameter="3.8mm" shape="circle" />`)
	const pegs = [[3, -3.0, -6.75], [4, -3.0, 6.75]].map(([pin, x, y]) => `<platedhole portHints={["pin${pin}"]} pcbX="${x}mm" pcbY="${y}mm" holeWidth="1.8mm" holeHeight="0.8mm" outerWidth="2.4mm" outerHeight="1.4mm" shape="pill" />`)
	const outline = [[-4.4, -8.2], [4.4, -8.2], [4.4, 8.2], [-4.4, 8.2], [-4.4, -8.2]].map(([x, y]) => `{ x: ${x}, y: ${y} }`).join(", ")
	return `{<footprint>${[...pins, ...pegs].join("")}<silkscreenpath route={[${outline}]} /></footprint>}`
}
// The brick input jack (the arm, 25 Nov 2026): XunPu DC-091-A250, rated 24 V 8 A, pads from JLCPCB's own footprint
// (catalog/footprints/dc091a250.json). Pin 1 the centre pin, 2 the switch, 3-6 the sleeve's four shield legs.
export const DC091_FOOTPRINT = "dc091a250"
export function dc091Footprint(): string {
	type Pad = { pin: number; shape: string; x: number; y: number; outer?: number; hole?: number; outerW?: number; outerH?: number; holeW?: number; holeH?: number }
	const f = JSON.parse(readFileSync(new URL("../../catalog/footprints/dc091a250.json", import.meta.url), "utf8")) as { pads: Pad[]; holes: { x: number; y: number; d: number }[]; body: { w: number; h: number } }
	const pads = f.pads.map((p) => p.shape === "circle"
		? `<platedhole portHints={["pin${p.pin}"]} pcbX="${p.x}mm" pcbY="${p.y}mm" holeDiameter="${p.hole}mm" outerDiameter="${p.outer}mm" shape="circle" />`
		: `<platedhole portHints={["pin${p.pin}"]} pcbX="${p.x}mm" pcbY="${p.y}mm" holeWidth="${p.holeW}mm" holeHeight="${p.holeH}mm" outerWidth="${p.outerW}mm" outerHeight="${p.outerH}mm" shape="pill" />`)
	const holes = f.holes.map((h) => `<hole pcbX="${h.x}mm" pcbY="${h.y}mm" diameter="${h.d}mm" />`)
	const [w, h] = [f.body.w / 2, f.body.h / 2]
	const outline = [[-w, -h], [w, -h], [w, h], [-w, h], [-w, -h]].map(([x, y]) => `{ x: ${x}, y: ${y} }`).join(", ")
	return `{<footprint>${[...pads, ...holes].join("")}<silkscreenpath route={[${outline}]} /></footprint>}`
}
export const SO8E_FOOTPRINT = "so8e_silergy"
// TI's HSOP-8 PowerPAD (DDA0008B, TPS54560 SLVSBN0C Land Pattern Example): the same 1.55 x 0.6 mm pads at 1.27 mm pitch,
// rows 5.4 mm apart, with a 2.71 x 3.4 mm thermal pad (its solder mask opening): pin 9.
export const DDA_FOOTPRINT = "so8_powerpad_dda"
const SO8_EP: Record<string, [number, number]> = { [SO8E_FOOTPRINT]: [2.55, 3.2], [DDA_FOOTPRINT]: [2.71, 3.4] }
function so8eFootprint(name = SO8E_FOOTPRINT): string {
	const [epW, epH] = SO8_EP[name]
	const pads: string[] = []
	for (let k = 0; k < 4; k++) pads.push(`<smtpad portHints={["pin${1 + k}"]} pcbX="-2.7mm" pcbY="${+(1.905 - 1.27 * k).toFixed(3)}mm" width="1.55mm" height="0.6mm" shape="rect" />`)
	for (let k = 0; k < 4; k++) pads.push(`<smtpad portHints={["pin${5 + k}"]} pcbX="2.7mm" pcbY="${+(-1.905 + 1.27 * k).toFixed(3)}mm" width="1.55mm" height="0.6mm" shape="rect" />`)
	pads.push(`<smtpad portHints={["pin9"]} pcbX="0mm" pcbY="0mm" width="${epW}mm" height="${epH}mm" shape="rect" />`)
	const outline = [[-2, -2.55], [2, -2.55], [2, 2.55], [-2, 2.55], [-2, -2.55]].map(([x, y]) => `{ x: ${x}, y: ${y} }`).join(", ")
	return `{<footprint>${pads.join("")}<silkscreenpath route={[${outline}]} /><silkscreenpath route={[{ x: -3.7, y: 2.4 }, { x: -3.7, y: 2.0 }]} /></footprint>}`
}
// The footprints the generator draws itself (a module's land pattern, or a part tscircuit's string doesn't draw right):
// the land pattern as JSX, or null for a tscircuit footprint string. test/footprint-clearance.test.ts skips these.
export function ownFootprint(footprint: string): string | null {
	return MODULES[footprint] ? moduleFootprint(MODULES[footprint]) : footprint === MIC_FOOTPRINT ? micFootprint() : footprint === IMU_FOOTPRINT ? imuFootprint() : footprint === SO8E_FOOTPRINT || footprint === DDA_FOOTPRINT ? so8eFootprint(footprint) : footprint === XT60_FOOTPRINT ? xt60Footprint() : footprint === SY8368_FOOTPRINT ? sy8368Footprint() : footprint === DC091_FOOTPRINT ? dc091Footprint() : null
}
export const IMU_FOOTPRINT = "lga14_2.5x3"
export const IMU_BODY = { w: 3.0, h: 2.5 }
export function imuLands(): { pin: number; x: number; y: number; w: number; h: number }[] {
	const side = +(IMU_BODY.w / 2 - 0.475 / 2 + 0.05).toFixed(4) // 1.3125
	const row = +(IMU_BODY.h / 2 - 0.475 / 2 + 0.05).toFixed(4) // 1.0625
	const out = []
	for (let k = 0; k < 4; k++) out.push({ pin: 1 + k, x: -side, y: 0.75 - 0.5 * k, w: 0.575, h: 0.3 })
	for (let k = 0; k < 3; k++) out.push({ pin: 5 + k, x: -0.5 + 0.5 * k, y: -row, w: 0.3, h: 0.575 })
	for (let k = 0; k < 4; k++) out.push({ pin: 8 + k, x: side, y: -0.75 + 0.5 * k, w: 0.575, h: 0.3 })
	for (let k = 0; k < 3; k++) out.push({ pin: 12 + k, x: 0.5 - 0.5 * k, y: row, w: 0.3, h: 0.575 })
	return out
}
function imuFootprint(): string {
	const n = (v: number) => `${+v.toFixed(4)}mm`
	const pads = imuLands().map((p) => `<smtpad portHints={["pin${p.pin}"]} pcbX="${n(p.x)}" pcbY="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" shape="rect" />`).join("")
	// The body outline on silkscreen, 0.25 mm outside it, with the pin-1 corner marked.
	const [hw, hh] = [IMU_BODY.w / 2 + 0.25, IMU_BODY.h / 2 + 0.25]
	const outline = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]].map(([x, y]) => `{ x: ${x}, y: ${y} }`).join(", ")
	const dot = `<silkscreenpath route={[{ x: ${-hw - 0.3}, y: ${hh} }, { x: ${-hw - 0.3}, y: ${hh - 0.3} }]} />`
	return `{<footprint>${pads}<silkscreenpath route={[${outline}]} />${dot}</footprint>}`
}

function modulePinLabels(m: RadioModule, pins: string[]): string {
	const map = m.pins
	const known = pins.filter((name) => map[name] !== undefined)
	return `{{ ${known.map((name) => `pin${map[name]}: ${q(name)}`).join(", ")} }}`
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
// A bare chip's decoupling, its crystal and the crystal's capacitors may sit this close to the chip's box (its pads plus
// 0.25 mm): with the full gap, the F103's crowded left side (OSC_IN, OSC_OUT, NRST, VDDA on pads 5–9) pushed NRST's and
// VDDA's capacitors past 7 mm of trace (11 Nov 2026).
const CHIP_GAP_MM = 0.5
const EDGE_MARGIN_MM = 0.5
const GRID_MM = 0.5
// Footprints with plated holes (pads on both faces): nothing goes on the bottom over them.
export const THROUGH_HOLE_FOOTPRINT = /^(pinrow|pinheader|dip|to92|to220|axial|jst\d+_ph)/

// What tscircuit counts as each part's extent at rotation 0: its courtyard where it has one, else its pads, measured
// from circuit.json of tscircuit 0.0.3042 builds (6 Nov 2026). Pad boxes alone left parts reaching past the board edge
// (J2 by 0.3 mm on 25 mm boards: tscircuit then skips autorouting altogether).
const FOOTPRINT_SIZE: Record<string, [number, number]> = {
	// The CNC spindle switch (26 Nov 2026): soic8 from tscircuit's pads (x ±2.15 ± 0.5, the 4.9 mm body) + 0.25 mm a side;
	// sma its courtyard (7 × 3.5); the KF128R terminal 11.16 mm along its pin row (tscircuit's courtyard) by 8 mm, the
	// block's depth an ESTIMATE (its LCSC drawing didn't download).
	soic8: [5.8, 5.4],
	sma: [7, 3.5],
	"pinrow2_p5.08mm": [11.16, 8],
	dfn4: [5.8, 2.8], sot23_5: [3.6, 2.5], sot23: [3.6, 2.5],
	// SOT-23-6 (the AP63205 buck): the SOT-23-5's outline with a sixth lead (JEDEC MO-178); measured on a mock Eurobot's
	// board (20 Nov 2026): pads + 0.25 mm 4.1 × 3.0, as PAD_EXTENT has it.
	sot23_6: [3.6, 2.5], "0402": [1.86, 0.94], "0603": [2.96, 1.46], qfn32: [5.8, 5.8],
	// A 4-pin 2.54 mm header (a bought module on pins): 4 × 2.54 + 1 mm by 3.6 mm, like pinrow2 and pinrow3 (it was
	// 1.5 mm deep, so the placer put the Eurobot base's 5 V module 0.27 mm past the board edge, 17 Nov 2026).
	pinrow4: [11.2, 3.6], pushbutton: [7, 9],
	// A 1206 chip part (the arm's 50 V input capacitors): tscircuit's pads span 4.05 x 1.75 mm (measured from circuit.json,
	// 25 Nov 2026), plus 0.25 mm a side.
	"1206": [4.55, 2.25],
	// The electrolytic (cap_elec_8x10): its pads reach past the 8.3 mm base (centres 6.53 mm apart, 4.2 mm long: 10.73 mm)
	// plus 0.25 mm a side; 8.3 mm tall. Before (26 Nov 2026) the base alone (8.8): pad 2 sat on JD1's locating hole.
	cap_elec_8x10: [11.25, 8.8],
	// The MDA7030 inductor: its pads span 7.98 mm (past the 7.1 mm body), plus 0.25 mm a side; the body 6.6 mm tall.
	mda7030: [8.5, 7.1],
	// The SPM6545: pads span 8.2 mm, plus 0.25 mm a side; the 6.5 mm body plus 0.25 mm a side.
	spm6545: [8.7, 7.0],
	// SMB (DO-214AA, the input TVS): tscircuit's pads 2.5 x 2.3 mm at +-2.15 mm span 6.8 x 2.3 mm (measured from circuit.json,
	// 25 Nov 2026), plus 0.25 mm a side.
	smb: [7.3, 2.8],
	// SOD-123 (a Schottky): pads and body about 4.4 × 1.6 mm (an estimate of the footprinter's sod123).
	sod123: [4.4, 1.6],
	// TSSOP-28 (the PCA9685): 9.7 mm long, leads across 6.4 mm, with pads about 10.4 × 7.9 mm (an estimate).
	"tssop28_w6.4mm_p0.65mm": [10.4, 7.9],
	// A 3-pin 2.54 mm header (a servo's plug).
	pinrow3: [8.6, 3.6],
	// SC-70-6 (the LM66100 ideal diode): about 2.8 × 2.6 mm with pads (an estimate of the footprinter's sot363).
	sot363: [2.8, 2.6], [MODULE_FOOTPRINT]: [MODULE_BODY.w, MODULE_BODY.h], esp32_s3_mini_1: [S3_BODY.w, S3_BODY.h], [IMU_FOOTPRINT]: [3.6, 3.1], nrs4018: [5.6, 4.4], spm7054: [8.8, 7.6], [SO8E_FOOTPRINT]: [7.2, 5.4], [DDA_FOOTPRINT]: [7.2, 5.4], [SY8368_FOOTPRINT]: [3.9, 3.6], [XT60_FOOTPRINT]: [9.4, 17], [DC091_FOOTPRINT]: [13.6, 10.6],
	// The S2B-PH-K housing's courtyard: 6.9 × 5.5 mm, not centred on the part (FOOTPRINT_OFFSET).
	jst2_ph: [6.9, 5.5],
	// JST XH 4-pin vertical (a CNC's stepper plug, B4B-XH-A): tscircuit's own courtyard, 13.4 × 6.75 mm, 0.525 mm behind
	// the pins (circuit.json of footprinter jst4_xh, 26 Nov 2026). Unlisted, it got the 3 mm default and the CNC mock's
	// plugs were placed on top of the drivers and their capacitors (6 of 7 board builds failed).
	jst4_xh: [13.4, 6.75],
	// JST SH 4-pin right angle (link connector): pads 6.8 × 4.2 mm (footprinter jst4_sh), the body a little deeper.
	jst4_sh: [7, 5.5],
	// The robot plugs added 16 Nov, their courtyards from circuit.json of a tscircuit 0.0.3042 build of the Eurobot base
	// (the 3 × 3 mm default had the space model compact the board until tscircuit's courtyards overlapped): the encoder
	// gearmotor's JST SH 6-pin (pads 8.8 × 4.2), the e-stop's JST XH 2-pin, the start cord's 2.54 mm header.
	jst6_sh: [9.8, 5.3],
	"pinrow2_p2.5_id1_od1.8": [6, 3.5],
	pinrow2: [6.1, 3.6],
	// The USB-C courtyard, not its pads: 9.84 mm along the edge (the shell's plated tabs) and 10.35 mm into the board,
	// measured at rotation 270 on a left edge and turned back to rotation 0 here.
	usbcmidmount: [9.84, 10.35],
	[MIC_FOOTPRINT]: [MIC_BODY.w, MIC_BODY.h],
	// The crystal's pads (CRYSTAL_PADS): 3.6 × 2.9 mm, no courtyard in the inline footprint.
	smd3225_4p: [3.6, 2.9],
	// The DRV8833's TSSOP-16 (6.4 mm lead span, 0.65 mm pitch): pads across x, 8 rows along y.
	"tssop16_w6.4mm_p0.65mm_thermalpad2.31mmx2.46mm": [7.9, 5.6],
	// A SOIC-8 CAN transceiver (SN65HVD230, TI's D package): pad centres 2.7 mm either side (TI's land pattern), 1.27 mm
	// pitch; the box takes the pads and the 4.9 mm body.
	"soic8_w4.4mm_p1.27mm": [7, 5.4],
	// A HAT's 2 × 20 female header (ADAFRUIT-2223): 20 columns and 2 rows at 2.54 mm, the housing's 50.8 × 5.08 mm.
	"pinrow40_rows2_female_pinnumbering(columnmajor)": [50.8, 5.08],
	// A 2-pin 5.0 mm screw terminal (KF301-5.0-2P, a 5 A power input): two Ø2.6 mm pads 5 mm apart; the housing is
	// about 10 × 7.5 mm (ESTIMATE from the KF301 family's drawings, not measured on a build).
	"pinrow2_p5_id1.3_od2.6": [10, 7.5],
}
const DEFAULT_SIZE: [number, number] = [3, 3]
// Whether the space model knows a footprint's size (its table or a chip profile's package); else it gets DEFAULT_SIZE.
export const knowsFootprintSize = (footprint: string) => footprint in FOOTPRINT_SIZE || packageSize(footprint) !== null

// A dual-row IC's pin position at rotation 0 (tscircuit's soic/tssop: pin 1 top-left, down the left side, then up
// the right), from the footprint's pin count, lead span (w) and pitch (p). Null for other footprints.
export function icPinOffset(footprint: string, pin: number): { x: number; y: number } | null {
	const m = /^(?:tssop|soic)(\d+)(?:_w([\d.]+)mm)?(?:_p([\d.]+)mm)?/.exec(footprint)
	if (!m || pin < 1) return null
	const n = Number(m[1]), w = Number(m[2] ?? 6.4), p = Number(m[3] ?? 0.65), half = n / 2
	if (pin > n) return null
	const row = pin <= half ? pin - 1 : n - pin
	return { x: pin <= half ? -w / 2 : w / 2, y: ((half - 1) / 2 - row) * p }
}

// A quad package's pad centre at rotation 0 (tscircuit's lqfp/qfn: pin 1 at the top of the left side, counter-clockwise:
// down the left, along the bottom, up the right, back along the top), from the pin count, the pitch and the distance of
// the pad centres from the middle (ringMm: the profile's package.ringMm, measured from footprinter's output).
export function quadPinOffset(footprint: string, pin: number, ringMm: number | undefined): { x: number; y: number } | null {
	const m = /^(?:lqfp|qfn)(\d+)(?:_w[\d.]+mm)?(?:_h[\d.]+mm)?(?:_p([\d.]+)mm)?/.exec(footprint)
	if (!m || pin < 1 || ringMm === undefined) return null
	const n = Number(m[1]), p = Number(m[2] ?? 0.5), side = n / 4
	if (pin > n || !Number.isInteger(side)) return null
	const c = ringMm
	const k = (pin - 1) % side, at = Math.floor((pin - 1) / side), along = (k - (side - 1) / 2) * p
	return [{ x: -c, y: -along }, { x: along, y: -c }, { x: c, y: along }, { x: -along, y: c }][at]
}

// The pad ring of the quad packages that aren't MCUs (no profile to carry ringMm), measured from tscircuit's footprinter
// (0.0.3042's @tscircuit/footprinter, 26 Nov 2026): the TMC2209's QFN28 pads sit 2.425 mm out. Without it the reach
// check skipped every stepper driver capacitor and tscircuit refused U4.VS to C11 at 6.12 mm (CNC mock 8, 26 Nov 2026).
export const QUAD_RING_MM: Record<string, number> = {
	"qfn28_w5.8mm_h5.8mm_p0.5mm_pl0.75mm_pw0.25mm_thermalpad3.7mmx3.7mm": 2.425,
}
export function quadRingMm(footprint: string): number | undefined {
	return loadProfiles().find((x) => x.package.footprint === footprint)?.package.ringMm ?? QUAD_RING_MM[footprint]
}

// A pad's centre from the part's origin at the part's rotation (counter-clockwise, as tscircuit's pcbRotation and
// offsetAt turn), for a dual-row or quad package; null for other footprints.
// A SOT-23-5/6's pad centre at rotation 0, from tscircuit 0.0.3042's own pads (circuit.json of the arm board, 26 Nov
// 2026): pins 1-3 down the left at 0.95 mm pitch, the rest back up the right (sot23_5 has no middle pin on the right).
// Without it the AP63205's BST capacitor had no pad to sit beside: placed last, 14.56 mm away, past its 5 mm bound, and
// unreachableCaps couldn't see it (the arm board, 26 Nov 2026).
const SOT23_PADS: Record<string, { x: number; ys: number[] }> = { sot23_6: { x: 1.3, ys: [0.95, 0, -0.95, -0.95, 0, 0.95] }, sot23_5: { x: 1.137, ys: [0.95, 0, -0.95, -0.95, 0.95] } }
export function sotPinOffset(footprint: string, pin: number): { x: number; y: number } | null {
	const f = SOT23_PADS[footprint]
	if (!f || pin < 1 || pin > f.ys.length) return null
	return { x: pin <= 3 ? -f.x : f.x, y: f.ys[pin - 1] }
}
// known: the pads learnt since 26 Nov 2026 count (SOT-23, the generator's own lands): the checks always; placement only
// in the fallback layout (PlacementOptions.pinPads), so a plain layout places as it did before.
// The land patterns the generator draws itself (imuFootprint, so8eFootprint): their pad centres from the same numbers.
// Without them the reach check skipped their capacitors: a rover's IMU (U6, LGA-14) VDD capacitor 5.09 mm out passed the
// check and tscircuit refused the layout (rover mock, 26 Nov 2026).
function ownPadOffset(footprint: string, pin: number): { x: number; y: number } | null {
	if (footprint === IMU_FOOTPRINT) {
		const l = imuLands().find((x) => x.pin === pin)
		return l ? { x: l.x, y: l.y } : null
	}
	if ((footprint === SO8E_FOOTPRINT || footprint === DDA_FOOTPRINT) && pin >= 1 && pin <= 9) return pin === 9 ? { x: 0, y: 0 } : pin <= 4 ? { x: -2.7, y: +(1.905 - 1.27 * (pin - 1)).toFixed(3) } : { x: 2.7, y: +(-1.905 + 1.27 * (pin - 5)).toFixed(3) }
	return null
}
function padOffset(footprint: string, pad: number, rotation: number, known = true): { x: number; y: number } | null {
	const at = icPinOffset(footprint, pad) ?? (known ? ownPadOffset(footprint, pad) ?? sotPinOffset(footprint, pad) : null) ?? quadPinOffset(footprint, pad, quadRingMm(footprint)) ?? (footprint === SY8368_FOOTPRINT ? sy8368PadCentre(pad) : null)
	if (!at) return null
	const t = (rotation * Math.PI) / 180
	return { x: +(at.x * Math.cos(t) - at.y * Math.sin(t)).toFixed(3), y: +(at.x * Math.sin(t) + at.y * Math.cos(t)).toFixed(3) }
}

// Centre of the reserved box relative to the part's origin, at rotation 0.
const FOOTPRINT_OFFSET: Record<string, [number, number]> = { usbcmidmount: [0, -0.855], jst2_ph: [0, -0.55], jst4_xh: [0, -0.525] }

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
// the case and the test fixture, which must leave it room; antennaMm its whole length. null with no radio module.
export function antennaOverhang(s: ContractSnapshot): { edge: Connector["edge"]; alongMm: number; widthMm: number; overhangMm: number; antennaMm: number } | null {
	const { outline, parts = [] } = s.values
	const mcu = parts.find((p) => p.role === "mcu")
	const m = moduleOf(mcu)
	if (!outline || !mcu || !m) return null
	const b = placeParts(s).find((p) => p.ref === mcu.ref)
	if (!b) return null
	const usb = (s.values.connectors ?? []).find((c) => c.kind === "usb-c")
	const edge = OPPOSITE[usb?.edge ?? "left"]
	const along = edge === "left" || edge === "right" ? (b.oy ?? b.y) + outline.heightMm / 2 : (b.ox ?? b.x) + outline.widthMm / 2
	return { edge, alongMm: +along.toFixed(3), widthMm: m.body.w, overhangMm: +(antennaOf(m) - MODULE_EDGE_MM).toFixed(3), antennaMm: antennaOf(m) }
}

// Where the module must go, and what keeps it out: it only ever sits at the edge opposite USB-C (placeModule), so a
// connector there, or a mounting hole at that edge's corners, can leave it no spot whatever the board's size. The build
// said only "no room for U1", and the architect grew the beacon from 50×30 to 64×40 mm when moving SW1 off that edge
// would have done (real system run 4, 9 Nov). null when there's no module or it is placed.
// Whether moving connectors along their own edges frees the module: each one in its way has an offset on its edge
// that clears it. Then module-blocked's "move it to …" is the answer and a bigger board is not; otherwise (a connector
// with no clearing spot on its edge: the rover's link connector JL1 on the module's edge in a system, 15 Nov 2026) a
// bigger board is an answer too.
export function moduleFreedAlongEdges(s: ContractSnapshot): boolean {
	const m = moduleBlocked(s)
	const outline = s.values.outline
	if (!m || !outline || m.blockers.length === 0) return false
	const conns = s.values.connectors ?? []
	return m.blockers.every((ref) => {
		const k = conns.find((x) => x.ref === ref)
		if (!k) return false
		const len = k.edge === "left" || k.edge === "right" ? outline.heightMm : outline.widthMm
		for (let off = k.widthMm / 2 + 1; off <= len - k.widthMm / 2 - 1; off += 0.5)
			if (!moduleBlocked({ ...s, values: { ...s.values, connectors: conns.map((x) => (x.ref === ref ? { ...x, offsetMm: off } : x)) } })) return true
		return false
	})
}

export function moduleBlocked(s: ContractSnapshot): { ref: string; edge: Connector["edge"]; usbRef?: string; needMm: number; depthMm: number; edgeMm: number; blockers: string[] } | null {
	const { outline, parts = [], connectors = [] } = s.values
	const mcu = parts.find((p) => p.role === "mcu")
	const m = moduleOf(mcu)
	if (!outline || !mcu || !m) return null
	// Whether the module got its spot: the module-only check (moduleSpotFree, the placement's own answer for the module,
	// 810/810 sizes in test/module-clear.test.ts) where it decides alone, the whole placement only when the engineer
	// placed parts. A full placement per call made the space model's size search 3.5x slower once the connector fitting
	// asked this for every offset (the rover-with-a-Pi system test timed out, 22 Nov 2026).
	const spot = moduleSpotFree(s)
	if (spot === true || (spot === null && placeParts(s).some((b) => b.ref === mcu.ref))) return null
	const usb = connectors.find((c) => c.kind === "usb-c")
	const edge = OPPOSITE[usb?.edge ?? "left"]
	const [W, H] = [outline.widthMm, outline.heightMm]
	const depthMm = +(m.body.h / 2 + m.padAreaTop + MODULE_EDGE_MM).toFixed(1)
	// Connectors whose box reaches into the strip along that edge the module's on-board part needs, gap included.
	const reach = depthMm + GAP_MM
	const into = (b: Placed) => {
		switch (edge) {
			case "left": return b.x - b.w / 2 < -W / 2 + reach
			case "right": return b.x + b.w / 2 > W / 2 - reach
			case "bottom": return b.y - b.h / 2 < -H / 2 + reach
			case "top": return b.y + b.h / 2 > H / 2 - reach
		}
	}
	const blockers = connectorBoxes(s, W, H).filter(into).map((b) => b.ref)
	return { ref: mcu.ref, edge, usbRef: usb?.ref, needMm: +(m.body.w + 2 * EDGE_MARGIN_MM).toFixed(1), depthMm, edgeMm: edge === "left" || edge === "right" ? H : W, blockers }
}

// Whether the radio module finds its spot, judged without the whole placement: the layout places it right after the
// connectors and the hole keep-outs (layoutUncached placeModule, same grid, frame and gap), so this is its answer when no
// part was placed by the engineer (Part.at, placed before it); null then, and for a board without a module. The
// connector fitting asks it for every offset it tries (contract/connectors.ts clearModule): the full placement there took
// the space model's size search from 1.4 s to 166 s (21 Nov 2026).
export function moduleSpotFree(s: ContractSnapshot, gapMm = GAP_MM): boolean | null {
	const { outline, parts = [], connectors = [] } = s.values
	const mcu = parts.find((p) => p.role === "mcu")
	const m = moduleOf(mcu)
	if (!outline || !mcu || !m || parts.some((p) => p.at && !moduleOf(p))) return null
	const [W, H] = [outline.widthMm, outline.heightMm]
	const placed = connectorBoxes(s, W, H)
	const keepouts = mountingHoles(s).map((h) => ({ x: h.x, y: h.y, w: MOUNTING_HOLE.keepoutMm, h: MOUNTING_HOLE.keepoutMm }))
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
	const onBoard = m.body.h / 2 + m.padAreaTop + MODULE_EDGE_MM
	const [w, h] = edge === "left" || edge === "right" ? [onBoard, m.body.w] : [m.body.w, onBoard]
	const half = m.body.w / 2 + EDGE_MARGIN_MM
	for (let k = 0; k <= span / GRID_MM; k++) {
		const v = span / 2 + (k % 2 === 0 ? k / 2 : -(k + 1) / 2) * GRID_MM
		if (v < half || v > span - half) continue
		const box = frame(depth - onBoard / 2, v)
		const b = { x: box.x, y: box.y, w, h }
		if (placed.every((o) => Math.max(Math.abs(b.x - o.x) - (b.w + o.w) / 2, Math.abs(b.y - o.y) - (b.h + o.h) / 2) >= gapMm) && keepouts.every((o) => !overlaps(b, o))) return true
	}
	return false
}

// A chip package's land pattern from its profile, plus 0.5 mm of courtyard around the pads.
function packageSize(footprint: string): [number, number] | null {
	const e = loadProfiles().find((p) => p.package.footprint === footprint)?.package.extentMm
	return e ? [e.w + 0.5, e.h + 0.5] : quadSize(footprint)
}

// A quad package whose footprint string states its size (qfn28_w5.8mm_h5.8mm_…: w and h toe to toe, as tscircuit draws
// it) plus 0.25 mm a side. Before (26 Nov 2026) an unlisted one got the 3 × 3 mm default: the CNC's four TMC2209s
// (pads 5.6 mm across) were placed on top of their capacitors and each other, and every board build failed on
// overlapping courtyards.
export function quadSize(footprint: string): [number, number] | null {
	const m = /^(?:lqfp|qfn)\d+_w([\d.]+)mm_h([\d.]+)mm/.exec(footprint)
	return m ? [Number(m[1]) + 0.5, Number(m[2]) + 0.5] : null
}

// A dual-row IC's extent at rotation 0 from its own land pattern (icPinOffset's pad rows, padGeometry's pads) plus a
// 0.25 mm courtyard each side (IPC-7351's nominal): the pads across x, the rows along y. The placement table keeps the
// DRV8833's TSSOP-16 at 7.9 mm across (the rover layouts are tuned to it and build clean), but its pads reach 9.3 mm: an
// unplated hole judged by the table box landed in its courtyard, 0.14 mm from pad 9 (the 60×21 rover: 2 DRC errors
// whichever router routed it, 17 Nov 2026). What a hole must clear is this extent.
// Small parts whose placement box is smaller than their pads + 0.25 mm a side, measured from the pads in circuit.json of
// the real runs' boards (17 Nov 2026 audit): the edge is judged by these (copperExtent), the parts' gaps stay on the box.
// The XT60PW-M battery plug: pads + 0.25 mm 9.6 mm across (its box 9.4), measured on a mock Eurobot's board, 20 Nov 2026.
// The SPM7054 inductor (the SY8368A's): pads 8.8 mm overall + 0.25 mm a side = 9.3, its box 8.8 (same audit).
// Over every component of the saved boards, generated support parts too (20 Nov 2026): 0805 capacitors (pads 3.35 mm
// along, the default box 3) and SOT-23 (as SOT-23-5).
const PAD_EXTENT: Record<string, [number, number]> = { "0805": [3.35, 1.9], sot23: [4.1, 3.0], spm7054: [9.3, 7.6], xt60pw_m: [9.6, 17.0], sot23_5: [4.1, 3.0], sot23_6: [4.1, 3.0], sot363: [3.2, 2.6], sod123: [4.7, 1.7], "0402": [2.1, 1.1] }
// A part's copper and courtyard extent at rotation 0, where it is more than its placement box: a dual-row IC's from its own
// pin geometry, a small part's from the audit table. Null: the box already covers it.
export const copperExtent = (footprint: string): [number, number] | null => dualRowExtent(footprint) ?? PAD_EXTENT[footprint] ?? null

export function dualRowExtent(footprint: string): [number, number] | null {
	const m = /^(?:tssop|soic)(\d+)(?:_w([\d.]+)mm)?(?:_p([\d.]+)mm)?/.exec(footprint)
	if (!m) return null
	const n = Number(m[1]), w = Number(m[2] ?? 6.4), p = Number(m[3] ?? 0.65)
	const pad = padGeometry(footprint)
	const x = w / 2 + pad.out + pad.l / 2, y = ((n / 2 - 1) / 2) * p + pad.w / 2
	return [+(2 * x + 0.5).toFixed(2), +(2 * y + 0.5).toFixed(2)]
}

// A footprint's placement box at rotation 0 (the table, a chip profile's package, or the default), for audits.
export const footprintBox = (footprint: string): [number, number] => FOOTPRINT_SIZE[footprint] ?? packageSize(footprint) ?? DEFAULT_SIZE

function sizeAt(footprint: string, rotation: number): [number, number] {
	const [w, h] = FOOTPRINT_SIZE[footprint] ?? packageSize(footprint) ?? DEFAULT_SIZE
	return Math.abs(rotation) % 180 === 90 ? [h, w] : [w, h]
}

// Distance from the USB-C connector centre to the LDO target; 8 mm routed cleanly at every tested width (45–70 mm).
export const LDO_FROM_USB_MM = 8

export interface PlacementOptions {
	// The gap kept between two parts' boxes, in mm (default GAP_MM, 1.5): the tight-first experiment places at 1.0 mm
	// and keeps the wider gap as the retry (backlog "Tighter part spacing, proven by the router").
	gapMm?: number
	// Place only, no autorouting: the board goes to Freerouting instead (src/tools/freerouting.ts).
	routingDisabled?: boolean
	// Place the pin parts of a SOT-23 and of the generator's own land patterns (the IMU, SO8E) beside their own pins
	// (sotPinOffset, ownPadOffset), not at the chip. Tried only after the layouts without it (board.ts): on by default it
	// moved a rover's LDO and charger parts 1-2 mm and its tscircuit layouts stopped routing (rover mock 26 Nov 2026:
	// board 43 → 106 s through Freerouting); the arm's AP63205 BST capacitor needs it (14.56 mm from its pin without).
	pinPads?: boolean
	// Distance from the USB-C connector centre to the LDO target.
	ldoFromUsbMm?: number
	// Routing keepouts at the USB-C locating holes. Off by default: on some layouts J1's own pad traces run too close
	// to them and tscircuit refuses the build (the 45 mm logger), so the board build tries them only after a layout
	// routes with DRC errors.
	usbKeepouts?: boolean
	// false: the board without the debug footprint (its spot stays reserved). The board build's last attempt, when the
	// board doesn't route with it.
	debugPort?: false
	// true: a part's pin capacitors may lie along its pads (alongPads), whichever orientation and order keeps their
	// traces shortest. Off by default: pointing out from the pads is what has routed on every scripted board, and along
	// the pads two capacitors' traces must pass each other's pads (the 43×28 rover: VCP's 7.2 mm against 5, 15 Nov
	// 2026). The board build tries it next when the default layout's trace runs past its bound (the 42×29 rover with U5
	// turned 180°, where pointing out GND's trace ran 14.7 mm).
	capsAlong?: boolean
	// true: the traces of a capacitor wired between two pins of one part are drawn by the generator (capPaths), not left
	// to the router. A retry, not the default: drawn first, they shift every other route, and boards that routed clean
	// lost their debug footprint to traces beside its holes (the 43×28 rover, 47 s → 201 s, 15 Nov 2026).
	drawCaps?: boolean
	// mm of routing room kept free of other parts around a part's pin-capacitor group (an experiment; 0 or absent: none).
	capChannelMm?: number
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

// A connector footprint's length along its edge as tscircuit judges a board, where that is longer than its box
// (FOOTPRINT_SIZE): the larger of its courtyard and its copper (pads and plated holes) plus the 0.2 mm copper-to-edge
// clearance on both ends, measured from tscircuit's circuit.json (16 Nov 2026). The JST SH 4-pin: courtyard 7.8 mm (its
// box is its 6.8 mm pads; real rover run 6's JT1 0.4 mm past the edge). The USB-C: copper 10.65 mm (its pads and shell
// tabs' plated holes) + 0.4 = 11.05 mm, courtyard 10.35, box 9.84 (real run 11: J1 at bottom@30 mm on a 35 mm edge,
// "extends outside board boundaries by 0.18mm", plated holes 0.075 mm from the edge, both board builds failed).
export const COPPER_EDGE_MM = 0.2
export const COURTYARD_ALONG_MM: Record<string, number> = { jst4_sh: 7.8, usbcmidmount: 10.65 + 2 * COPPER_EDGE_MM }
// Each connector's length along its edge as tscircuit judges it: its box's, or its courtyard's where that is longer.
export function connectorAlongMm(s: ContractSnapshot, ref: string, boxAlong: number): number {
	const c = (s.values.connectors ?? []).find((k) => k.ref === ref)
	const part = (s.values.parts ?? []).find((p) => p.ref === ref)
	const footprint = part ? footprintFor(part) : c ? CONNECTOR_FOOTPRINT[c.kind] : undefined
	return Math.max(boxAlong, (footprint && COURTYARD_ALONG_MM[footprint]) || 0)
}

// Each connector's box as tscircuit judges it: along its edge as long as connectorAlongMm (its courtyard, or its copper
// plus the edge clearance), across it as its box. Two connectors on adjacent edges at a corner overlap by these (real run
// 14, Eurobot: "Courtyard of J2 overlaps with courtyard of JT1" four times, "J1 overlaps JT1" once, while their boxes
// cleared each other, 16 Nov 2026).
export function connectorExtents(s: ContractSnapshot, W: number, H: number): Placed[] {
	const connectors = s.values.connectors ?? []
	return connectorBoxes(s, W, H).map((b) => {
		const c = connectors.find((k) => k.ref === b.ref)
		const alongX = c?.edge === "top" || c?.edge === "bottom"
		return alongX ? { ...b, w: connectorAlongMm(s, b.ref, b.w) } : { ...b, h: connectorAlongMm(s, b.ref, b.h) }
	})
}

export function connectorBoxes(s: ContractSnapshot, W: number, H: number): Placed[] {
	const { parts = [], connectors = [] } = s.values
	return connectors.map((c) => {
		const part = parts.find((p) => p.ref === c.ref)
		const footprint = part ? footprintFor(part) : CONNECTOR_FOOTPRINT[c.kind]
		const rotation = edgeRotation(c, footprint)
		const [w, h] = sizeAt(footprint, rotation)
		const { x, y } = connectorPosition(c, W, H, footprint)
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
	// A board that must match another's mounting pattern (a HAT on a bought module) drills that pattern, as given.
	// A diameter the pattern doesn't give (null) is the default hole; a zero or negative one is an error, not a hole.
	if (outline.holes?.length)
		return outline.holes.map((h, i) => {
			if (h.dia != null && !(h.dia > 0)) throw new Error(`outline.holes[${i}] at (${h.x}, ${h.y}) mm has diameter ${h.dia} mm: a mounting hole needs a positive diameter (or null for the default Ø${MOUNTING_HOLE.diameterMm} mm)`)
			return { ref: `H${i + 1}`, x: +(h.x - W / 2).toFixed(3), y: +(h.y - H / 2).toFixed(3), diameterMm: h.dia ?? MOUNTING_HOLE.diameterMm }
		})
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
	return layoutBoard(s, opts).parts
}

// The parts' placement and, after them, the debug footprint's spot (debugPort): it is reserved like a part, so no top
// part sits over its holes (they go through the board) and the smallest board has room for it. It is not a part and is
// not in parts. On the underside it must also stay clear of the USB-C connector (its routing, TEST_PAD.usbClearMm)
// and, on a board without mounting holes, of the fixture's corner supports.
export type Layout = { parts: Placed[]; debug: Placed | null; blocked: { ref: string; why: string }[] }

function permutations<T>(xs: T[]): T[][] {
	if (xs.length <= 1) return [xs]
	return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]))
}

// The same design is laid out again and again: by every check of each event, every agent turn's facts, the case, the
// pads and each probe of the smallest-board search (about 5 s per logger run, the isolation audit, 14 Nov 2026). The
// layout depends only on the design and the options, so it is kept for the last few, keyed on both. Callers get a
// copy: some adjust what they get back.
const LAYOUT_CACHE_SIZE = 256
const layoutCache = new Map<string, Layout>()
export function layoutBoard(s: ContractSnapshot, opts: PlacementOptions = {}): Layout {
	const key = JSON.stringify(s.values) + "\u0000" + JSON.stringify(opts)
	const hit = layoutCache.get(key)
	if (hit) {
		layoutCache.delete(key)
		layoutCache.set(key, hit)
		return structuredClone(hit)
	}
	const fresh = layoutUncached(s, opts)
	if (layoutCache.size >= LAYOUT_CACHE_SIZE) layoutCache.delete(layoutCache.keys().next().value!)
	layoutCache.set(key, structuredClone(fresh))
	return fresh
}

function layoutUncached(s: ContractSnapshot, opts: PlacementOptions): Layout {
	// The gap between two parts: GAP_MM, or a build's own (PlacementOptions.gapMm: the tight-first experiment).
	const gapMm = opts.gapMm ?? GAP_MM
	const { outline, parts = [], connectors = [] } = s.values
	if (!outline) throw new Error("placeParts: contract has no outline")
	const [W, H] = [outline.widthMm, outline.heightMm]
	const footprintOfRef = (ref: string) => { const p = parts.find((x) => x.ref === ref); return p ? footprintFor(p) : "" }
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

	// hug: a part allowed CHIP_GAP_MM from that part's box instead of the parts' gap (a bare chip's own pin parts, below).
	// The part that blocked the last spot is tried first: the next spot is usually blocked by it too (the same answer as
	// trying them in order; a crowded board's search spent most of its time on the parts that weren't in the way).
	let lastBlock = 0
	const blocks = (b: Placed, o: Placed, hug?: string) => Math.max(Math.abs(b.x - o.x) - (b.w + o.w) / 2, Math.abs(b.y - o.y) - (b.h + o.h) / 2) < (o.ref === hug ? CHIP_GAP_MM : gapMm)
	// Routing room kept around a part's pin-capacitor group (opts.capChannelMm): the experiment of 16 Nov 2026 after the
	// drawn-trace retry failed on crowded boards (real rover run 9 at 58×22 mm): other parts kept this far off the
	// capacitors' outer sides, so other nets pass around the group instead of through the gaps its traces need.
	const channels: (Placed & { owner: string; caps: Set<string> })[] = []
	// The board edge is judged by a part's copper and courtyard (dualRowExtent), not its placement box: run 20b's PCA9685
	// (TSSOP-28, box 7.9 mm along its pin rows, pads 9.25) had pads 0.125 mm from the edge, and tscircuit refused the board.
	// copperExtent per ref, once: offEdge asks it for every candidate spot (pure in the footprint).
	const extentOf = new Map<string, ReturnType<typeof copperExtent>>()
	const edgeBox = (b: Placed): Placed => {
		let d = extentOf.get(b.ref)
		if (d === undefined && !extentOf.has(b.ref)) extentOf.set(b.ref, (d = copperExtent(footprintOfRef(b.ref))))
		if (!d) return b
		const [dw, dh] = Math.abs(b.rotation) % 180 === 90 ? [d[1], d[0]] : d
		return { ...b, w: Math.max(b.w, dw), h: Math.max(b.h, dh) }
	}
	const offEdge = (b: Placed) => {
		const e = edgeBox(b)
		return Math.abs(e.x) + e.w / 2 > W / 2 - EDGE_MARGIN_MM || Math.abs(e.y) + e.h / 2 > H / 2 - EDGE_MARGIN_MM
	}
	// The placed boxes in a bucket grid (BUCKET_MM cells), so a candidate is judged against the boxes near it, not every
	// one: the same answer (a box sits in every cell its gap-widened bounds touch, so any box that can block a candidate
	// shares a cell with it), ~2/3 of a layout's time before (the 70-part CNC board, 26 Nov 2026). It follows placed by
	// its length: grown, the new boxes are added; cut back (the capacitor-combination trials), it is rebuilt.
	const BUCKET_MM = 4
	const blockReach = Math.max(gapMm, CHIP_GAP_MM)
	const cols = Math.max(1, Math.ceil((W + 2 * BUCKET_MM) / BUCKET_MM)), rows = Math.max(1, Math.ceil((H + 2 * BUCKET_MM) / BUCKET_MM))
	const cellX = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x + W / 2 + BUCKET_MM) / BUCKET_MM)))
	const cellY = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y + H / 2 + BUCKET_MM) / BUCKET_MM)))
	let buckets: number[][] = []
	let indexed = 0
	const syncIndex = () => {
		if (placed.length < indexed) {
			buckets = []
			indexed = 0
		}
		for (; indexed < placed.length; indexed++) {
			const o = placed[indexed]
			for (let i = cellX(o.x - o.w / 2 - blockReach); i <= cellX(o.x + o.w / 2 + blockReach); i++)
				for (let j = cellY(o.y - o.h / 2 - blockReach); j <= cellY(o.y + o.h / 2 + blockReach); j++) (buckets[i * rows + j] ??= []).push(indexed)
		}
	}
	let stamp = 0
	const seen: number[] = []
	const fits = (b: Placed, hug?: string) => {
		if (offEdge(b)) return false
		syncIndex()
		if (lastBlock < placed.length && blocks(b, placed[lastBlock], hug)) return false
		stamp++
		for (let i = cellX(b.x - b.w / 2); i <= cellX(b.x + b.w / 2); i++)
			for (let j = cellY(b.y - b.h / 2); j <= cellY(b.y + b.h / 2); j++)
				for (const k of buckets[i * rows + j] ?? []) {
					if (seen[k] === stamp) continue
					seen[k] = stamp
					if (blocks(b, placed[k], hug)) {
						lastBlock = k
						return false
					}
				}
		// The routing channel around a part's pin-capacitor group (capChannel): only that part and its capacitors may sit in it.
		if (channels.some((c) => b.ref !== c.owner && !c.caps.has(b.ref) && overlaps(b, c))) return false
		// A pin capacitor's reserved spot (capBoxes) is kept for it until it is placed: parts placed after its owner took
		// them (the CNC board's drivers on the MCU's decoupling spots, the MCU's capacitors on the drivers'), and the
		// capacitors went to the next free spot, 6-8 mm from their pads (CNC mock 8, 26 Nov 2026).
		for (const r of reservedCaps.values()) if (r.ref !== b.ref && r.owner !== b.ref && blocks(b, r)) return false
		return keepouts.every((o) => !overlaps(b, o))
	}

	// The capacitors wired straight to a part's pins (the DRV8833's VINT and VCP, a bare chip's decoupling), each in the
	// box it takes just past its pad, as far off the part's box as it will be placed (CHIP_GAP_MM for a bare chip's own,
	// the parts' gap otherwise: 0.5 mm from the DRV8833 overlapped its courtyard, 14 Nov 2026): a part goes only where these fit
	// too. On a 33 mm
	// wide rover the driver went hard against the module and VINT's capacitor landed across it, 7.98 mm of trace against
	// tscircuit's 5 mm, and every build failed (14 Nov 2026).
	// A capacitor between pads on two different sides of one part (a quad package's corner: the TMC2209's VCP and VS2).
	// Pads on one side (the DRV8833's VCP and VM) keep the spot beside the first pad, as before.
	const sideOf = (at: { x: number; y: number }) => (Math.abs(at.x) >= Math.abs(at.y) ? `x${Math.sign(at.x)}` : `y${Math.sign(at.y)}`)
	const acrossSides = (sp: Support): boolean => {
		if (!("ref" in sp.a) || !("ref" in sp.b) || sp.a.ref !== sp.b.ref) return false
		const part = parts.find((p) => p.ref === (sp.a as { ref: string }).ref)
		if (!part) return false
		const fp = footprintFor(part)
		const pa = padOffset(fp, part.pins.indexOf(sp.a.pin) + 1, 0, !!opts.pinPads), pb = padOffset(fp, part.pins.indexOf(sp.b.pin) + 1, 0, !!opts.pinPads)
		return !!pa && !!pb && sideOf(pa) !== sideOf(pb)
	}
	const pinCaps = supportParts(s).filter((sp) => sp.added && sp.spec.kind === "capacitor" && "ref" in sp.a && sp.near !== boardCrystal(s)?.ref)
	// A turned part (the board page) turns its pads, and these boxes with them.
	const capBoxes = (b: Placed, footprint: string): Placed[] => {
		if (b.rotation % 90 !== 0) return []
		const part = parts.find((p) => p.ref === b.ref)
		if (!part) return []
		return pinCaps.flatMap((sp) => {
			const end = sp.a as { ref: string; pin: string }
			if (end.ref !== b.ref) return []
			const a = padOffset(footprint, part.pins.indexOf(end.pin) + 1, b.rotation, !!opts.pinPads)
			if (!a) return []
			// A capacitor across two pins of the same part (the TMC2209's VCP to VS2, CPO to CPI) sits beside the middle of
			// its two pads: beside its first pad alone, VS2's end was 7-8 mm away on a corner (CNC mock 8, 26 Nov 2026).
			const other = acrossSides(sp) ? padOffset(footprint, part.pins.indexOf((sp.b as { pin: string }).pin) + 1, b.rotation, !!opts.pinPads) : null
			const at = other ? { x: (a.x + other.x) / 2, y: (a.y + other.y) / 2 } : a
			const [cw, ch] = sizeAt(sp.spec.footprint, 0)
			const gap = bareChip(part) ? CHIP_GAP_MM : gapMm
			return [Math.abs(at.x) >= Math.abs(at.y)
				? { ref: sp.ref, x: b.x + Math.sign(at.x) * (b.w / 2 + gap + cw / 2), y: b.y + at.y, w: cw, h: ch, rotation: 0 }
				: { ref: sp.ref, x: b.x + at.x, y: b.y + Math.sign(at.y) * (b.h / 2 + gap + ch / 2), w: cw, h: ch, rotation: 0 }]
		}).reduce<Placed[]>((kept, c) => {
			// Where the capacitor will really go: on the placement grid (out from the part, never closer), and clear of the
			// part's other capacitors by the gap placement keeps. Reserved off the grid, or overlapping a sibling's box, the
			// spot was one placement could never take: on the real rover run 6's 44×29 board VCP's box at x −9.12 had the
			// grid's −9.0 too near the radio module and VINT's box 1.0 mm from it, so C4 went 4 mm from its pin (16 Nov 2026).
			const snap = (v: number, half: number, dir: number) => {
				const k = (v + half) / GRID_MM
				return -half + (dir > 0 ? Math.ceil(k - 1e-9) : dir < 0 ? Math.floor(k + 1e-9) : Math.round(k)) * GRID_MM
			}
			const across = Math.abs(c.x - b.x) > b.w / 2
			let box = across ? { ...c, x: snap(c.x, W / 2, Math.sign(c.x - b.x)), y: snap(c.y, H / 2, 0) } : { ...c, x: snap(c.x, W / 2, 0), y: snap(c.y, H / 2, Math.sign(c.y - b.y)) }
			const clash = (x: Placed) => kept.find((o) => Math.max(Math.abs(x.x - o.x) - (x.w + o.w) / 2, Math.abs(x.y - o.y) - (x.h + o.h) / 2) < gapMm - 1e-9)
			for (let step = 0, o = clash(box); o && step < 8; step++, o = clash(box)) {
				const away = across ? Math.sign(box.y - o.y) || 1 : Math.sign(box.x - o.x) || 1
				box = across ? { ...box, y: box.y + away * GRID_MM } : { ...box, x: box.x + away * GRID_MM }
			}
			return [...kept, box]
		}, [])
	}

	// The boxes a placed part reserved for its pin capacitors (capBoxes), by capacitor: their exact spots, off the grid.
	const reservedCaps = new Map<string, Placed & { owner: string }>()
	// exact: a spot off the grid to take instead of the grid's best when that is clearly farther from want (a pin
	// capacitor's reserved box). The grid alone missed it: on the real rover run 6's 44×29 board U5's VCP box sat at
	// x −9.12, and the grid's −9.0 was 0.03 mm too near the radio module and −9.5 too near U5, so C4 went 4 mm away from
	// its pin and its traces ran 8.2 mm against 5 (16 Nov 2026).
	// The channel box around a part's capacitor boxes, grown by opts.capChannelMm on every side; null without one.
	const channelOf = (ref: string, boxes: Placed[]): (Placed & { owner: string; caps: Set<string> }) | null => {
		const ch = opts.capChannelMm ?? Number(process.env.BRINGUP_CAP_CHANNEL_MM ?? 0) // the env: the experiment's switch
		if (!(ch > 0) || !boxes.length) return null
		const [x0, x1] = [Math.min(...boxes.map((c) => c.x - c.w / 2)) - ch, Math.max(...boxes.map((c) => c.x + c.w / 2)) + ch]
		const [y0, y1] = [Math.min(...boxes.map((c) => c.y - c.h / 2)) - ch, Math.max(...boxes.map((c) => c.y + c.h / 2)) + ch]
		return { ref: `${ref}-channel`, x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, rotation: 0, owner: ref, caps: new Set(boxes.map((c) => c.ref)) }
	}
	const place = (ref: string, footprint: string, rotation: number, want: { x: number; y: number }, hug?: string, exact?: Placed & { owner: string }): Placed | undefined => {
		const [w, h] = sizeAt(footprint, rotation)
		// A footprint whose extent isn't centred on its origin (FOOTPRINT_OFFSET): the box is placed, the part sits off it.
		const { dx, dy } = offsetAt(footprint, rotation)
		// The nearest grid spot to want where it fits (ties: the first by x, then y). Searched in rings outward from the spot
		// nearest want, stopping once no ring can hold a nearer one: the full grid, scanned row by row, ran the fit check
		// on nearly every spot of a crowded board (9 million checks for one logger run's revisions, 14 Nov 2026).
		let best: Placed | undefined
		let bestD = Infinity
		let bestIJ = [0, 0]
		const [ni, nj] = [Math.floor(W / GRID_MM + 1e-9), Math.floor(H / GRID_MM + 1e-9)]
		const ci = Math.min(ni, Math.max(0, Math.round((want.x + W / 2) / GRID_MM)))
		const cj = Math.min(nj, Math.max(0, Math.round((want.y + H / 2) / GRID_MM)))
		const off = Math.max(Math.abs(-W / 2 + ci * GRID_MM - want.x), Math.abs(-H / 2 + cj * GRID_MM - want.y))
		const tryAt = (i: number, j: number) => {
			const b = { ref, x: -W / 2 + i * GRID_MM, y: -H / 2 + j * GRID_MM, w, h, rotation }
			const d = Math.hypot(b.x - want.x, b.y - want.y)
			const better = d < bestD - 1e-9 || (d <= bestD + 1e-9 && (i < bestIJ[0] || (i === bestIJ[0] && j < bestIJ[1])))
			if (better && fits(b, hug)) {
				const boxes = capBoxes(b, footprint)
				const chan = channelOf(ref, boxes)
				// The channel must be free of the parts already placed (and stay on the board).
				const chanFree = !chan || (placed.every((o) => o.ref === ref || !overlaps(chan, o)) && Math.abs(chan.x) + chan.w / 2 <= W / 2 && Math.abs(chan.y) + chan.h / 2 <= H / 2)
				if (chanFree && boxes.every((c) => fits(c, ref))) [best, bestD, bestIJ] = [b, d, [i, j]]
			}
		}
		const rMax = Math.max(ci, ni - ci, cj, nj - cj)
		for (let r = 0; r <= rMax && r * GRID_MM - off <= bestD + 1e-9; r++) {
			for (let i = ci - r; i <= ci + r; i++) {
				if (i < 0 || i > ni) continue
				if (r === 0) tryAt(i, cj)
				else if (i === ci - r || i === ci + r) for (let j = Math.max(0, cj - r); j <= Math.min(nj, cj + r); j++) tryAt(i, j)
				else {
					if (cj - r >= 0) tryAt(i, cj - r)
					if (cj + r <= nj) tryAt(i, cj + r)
				}
			}
		}
		// Judged as it was reserved: beside its owner part (capBoxes checks it with the owner as hug).
		if (exact && fits(exact, exact.owner) && (!best || Math.hypot(exact.x - want.x, exact.y - want.y) < bestD - GRID_MM * Math.SQRT2)) best = { ref, x: exact.x, y: exact.y, w: exact.w, h: exact.h, rotation }
		if (best && (dx !== 0 || dy !== 0)) best = { ...best, ox: +(best.x - dx).toFixed(3), oy: +(best.y - dy).toFixed(3) }
		if (best) {
			placed.push(best)
			reservedCaps.delete(ref)
			const boxes = capBoxes(best, footprint)
			for (const c of boxes) reservedCaps.set(c.ref, { ...c, owner: ref })
			const chan = channelOf(ref, boxes)
			if (chan) channels.push(chan)
		}
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
	const placeModule = (p: Part, m: RadioModule): Placed | undefined => {
		done.add(p.ref)
		const rotation = MODULE_ROTATION[edge]
		const onBoard = m.body.h / 2 + m.padAreaTop + MODULE_EDGE_MM
		const [w, h] = edge === "left" || edge === "right" ? [onBoard, m.body.w] : [m.body.w, onBoard]
		const half = m.body.w / 2 + EDGE_MARGIN_MM
		for (let k = 0; k <= span / GRID_MM; k++) {
			const v = span / 2 + (k % 2 === 0 ? k / 2 : -(k + 1) / 2) * GRID_MM
			if (v < half || v > span - half) continue
			const c = frame(depth - m.padAreaTop - MODULE_EDGE_MM, v)
			const box = frame(depth - onBoard / 2, v)
			const b: Placed = { ref: p.ref, x: box.x, y: box.y, w, h, rotation, ox: c.x, oy: c.y }
			const clear = placed.every((o) => Math.max(Math.abs(b.x - o.x) - (b.w + o.w) / 2, Math.abs(b.y - o.y) - (b.h + o.h) / 2) >= gapMm) && keepouts.every((o) => !overlaps(b, o))
			if (!clear) continue
			placed.push(b)
			return b
		}
		return undefined
	}
	// Parts the engineer placed (Part.at, the board page): exactly there, before anything the layout chooses, so the rest
	// places around them. One that doesn't fit there stays unplaced with the reason (blocked), never moved elsewhere: the
	// engineer chose that spot. The radio module isn't placeable this way (its antenna goes past the far edge).
	const blocked: { ref: string; why: string }[] = []
	for (const p of free) {
		if (!p.at || moduleOf(p)) continue
		done.add(p.ref)
		const rotation = p.at.rotationDeg ?? (p.role === "mcu" && !chipProfile(p) ? MODULE_ROTATION[edge] : 0)
		const [w, h] = sizeAt(footprintFor(p), rotation)
		const { dx, dy } = offsetAt(footprintFor(p), rotation)
		let b: Placed = { ref: p.ref, x: +(p.at.xMm - W / 2).toFixed(3), y: +(p.at.yMm - H / 2).toFixed(3), w, h, rotation }
		if (dx !== 0 || dy !== 0) b = { ...b, ox: +(b.x - dx).toFixed(3), oy: +(b.y - dy).toFixed(3) }
		// Its pin capacitors must fit beside their pads too, as for a part the layout places.
		const caps = capBoxes(b, footprintFor(p))
		const capsBlocked = caps.filter((c) => !fits(c, p.ref))
		if (fits(b) && !capsBlocked.length) {
			placed.push(b)
			continue
		}
		const gap = (o: { x: number; y: number; w: number; h: number }) => Math.max(Math.abs(b.x - o.x) - (b.w + o.w) / 2, Math.abs(b.y - o.y) - (b.h + o.h) / 2)
		const why = [
			...(offEdge(b) ? [`closer than ${EDGE_MARGIN_MM} mm to the board's edge, or off it`] : []),
			...placed.filter((o) => gap(o) < gapMm).map((o) => `${gap(o) < 0 ? "on top of" : `${Math.max(0, gap(o)).toFixed(1)} mm from`} ${o.ref} (parts keep ${gapMm} mm apart)`),
			...(keepouts.some((o) => overlaps(b, o)) ? ["over a mounting hole's keep-out"] : []),
			...(fits(b) ? capsBlocked.map((c) => `no room for ${c.ref} beside the pin it serves (its trace is held short)`) : []),
		]
		blocked.push({ ref: p.ref, why: why.join("; ") || "no room there" })
	}
	const mcuPart = byRole("mcu")
	// A bare chip stays at rotation 0, so its decoupling lands beside the right pads (besidePin).
	const mcuModule = moduleOf(mcuPart)
	const mcu = mcuPart && mcuModule ? placeModule(mcuPart, mcuModule) : put(mcuPart, { x: 0, y: 0 }, chipProfile(mcuPart) ? 0 : MODULE_ROTATION[edge])
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
	// The motor driver mid-board, between the module and the USB-C side, before its capacitors (they sit beside it).
	// Every motor driver, not only the first: a second DRV8833 (the Eurobot's spare motor, run 21) was left to the last
	// pass, after the capacitors: its VINT and VCP capacitors found no driver to sit beside and went mid-board, the driver
	// then took a spot 13-30 mm away and every build of the run failed on their 5 mm bound (25 Nov 2026).
	for (const d of motorDrivers(free)) put(d, frame(depth / 2, span / 2))
	// Each support passive sits next to the part it serves; one that ends on a pin of a TSSOP/SOIC part sits just past
	// that pin (a 7.9 mm TSSOP's far side is too far: tscircuit caps a decoupling trace at 1 mm).
	const boxOf = (ref: string) => placed.find((b) => b.ref === ref)
	const besidePin = (end: End) => {
		if (!("ref" in end)) return null
		const part = parts.find((p) => p.ref === end.ref)
		const box = boxOf(end.ref)
		const fp = part ? footprintFor(part) : ""
		const pad = part ? part.pins.indexOf(end.pin) + 1 : 0
		const at = part && box && box.rotation % 90 === 0 ? padOffset(fp, pad, box.rotation, !!opts.pinPads) : null
		if (!at || !box) return null
		// Out past the pad, away from the body: along x for a side pad, along y for a top or bottom one.
		// A quad package's pads end 0.7 mm past their centre; 1.2 mm out leaves the 0402 clear and its trace short.
		const out = icPinOffset(fp, pad) ? 1.5 : 1.2
		return Math.abs(at.x) >= Math.abs(at.y) ? { x: box.x + at.x + Math.sign(at.x) * out, y: box.y + at.y } : { x: box.x + at.x, y: box.y + at.y + Math.sign(at.y) * out }
	}
	// The crystal beside the chip's OSC_IN pad, a little further out than a decoupling capacitor (it is bigger); its load
	// capacitors then sit beside the crystal pin each one serves.
	const xtal = boardCrystal(s)
	if (xtal) {
		const pad = besidePin({ ref: xtal.mcuRef, pin: xtal.inPin })
		const mcuBox = boxOf(xtal.mcuRef)
		const [dx, dy] = pad && mcuBox ? [pad.x - mcuBox.x, pad.y - mcuBox.y] : [0, 0]
		const want = !pad ? centre : Math.abs(dx) >= Math.abs(dy) ? { x: pad.x + Math.sign(dx) * 1.5, y: pad.y } : { x: pad.x, y: pad.y + Math.sign(dy) * 1.5 }
		place(xtal.ref, CRYSTAL_FOOTPRINT, 0, want, xtal.mcuRef)
	}
	const besideCrystal = (end: End) => {
		const box = xtal && "ref" in end && end.ref === xtal.ref ? boxOf(xtal.ref) : undefined
		const off = box && "ref" in end ? CRYSTAL_PADS[end.pin] : undefined
		// Above or below the pin it serves (pin 1 below, pin 3 above at rotation 0), clear of the crystal's own pads.
		return box && off ? { x: box.x + off[0], y: box.y + Math.sign(off[1]) * 3.5 } : null
	}
	// A bare chip's own pin parts (its decoupling, held to 7 mm of trace) and its crystal's load capacitors go first, so
	// the bus pull-ups and the like don't take the spots beside its pads (the STM32F103's VDD3 capacitor pushed past the
	// I2C pull-ups routed 24.5 mm, 11 Nov 2026).
	// Then every other capacitor wired to a pin (the DRV8833's VINT and VCP, held to 5 mm of trace): one that ends on a
	// net aims at its part's centre and, placed first, took the spots beside those pins (the rover at 33×42 mm: VINT's
	// capacitor 7.98 mm from the pad, tscircuit refused every build, 14 Nov 2026).
	const first = (sp: Support) =>
		chipProfile(mcuPart) && "ref" in sp.a && (sp.a.ref === mcuPart?.ref || sp.a.ref === xtal?.ref) ? 0 : sp.spec.kind === "capacitor" && besidePin(sp.a) ? 1 : 2
	// A capacitor on a part's pad faces it the right way round. One between two pads of the same part (the DRV8833's VCP to
	// VM) faces its pins in the pads' order: else its two
	// traces cross and tscircuit routes one the long way round, past its 5 mm bound (U5 turned 90° on the board page:
	// VCP's trace 10 mm, 14 Nov 2026). Turned 180°, its box stays where it is. Pin 1 is the a end (the trace code below).
	const padAt = (end: End): { x: number; y: number } | null => {
		if (!("ref" in end)) return null
		const part = parts.find((p) => p.ref === end.ref)
		const box = boxOf(end.ref)
		const at = part && box && box.rotation % 90 === 0 ? padOffset(footprintFor(part), part.pins.indexOf(end.pin) + 1, box.rotation, !!opts.pinPads) : null
		return at && box ? { x: (box.ox ?? box.x) + at.x, y: (box.oy ?? box.y) + at.y } : null
	}
	const crosses = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }) => {
		const o = (p: typeof a, q: typeof a, r: typeof a) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
		return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
	}
	// One on a single pad has that end toward it: with the driver turned 180°, VINT's capacitor sat left of it with the
	// VINT end outside, and VINT's trace went round the capacitor's own GND pin (10.2 mm, a real build, 14 Nov 2026).
	const facesAway = (b: Placed, sp: Support): boolean => {
		const [pa, pb] = [padAt(sp.a), padAt(sp.b)]
		const half = b.w / 4
		const [p1, p2] = [{ x: b.x - half, y: b.y }, { x: b.x + half, y: b.y }]
		if (pa && pb && "ref" in sp.a && "ref" in sp.b && sp.a.ref === sp.b.ref) return crosses(p1, pa, p2, pb)
		// Only one that points away (its far end is the pad's end by about its pin spacing); one lying alongside the pad row
		// is a near tie either way, and turning it only moved the router's trouble (U5 turned 90°, 14 Nov 2026).
		return !!pa && Math.hypot(p2.x - pa.x, p2.y - pa.y) < Math.hypot(p1.x - pa.x, p1.y - pa.y) - half
	}
	// A capacitor between two pads of the same part (the DRV8833's VCP to VM, and VINT to its GND since a pin capacitor's
	// ground goes to its part's own GND pin) lies along the line between them, pin 1 toward the a end, beside both pads.
	// Lying out from the pin row, one end was always the far one, whichever way round: GND's trace ran 14.7 mm against
	// its 5 mm bound on the 42×29 mm rover with U5 turned 180° and no layout built (15 Nov 2026).
	const alongPads = (sp: Support): { rotation: number; want: { x: number; y: number } } | null => {
		if (!("ref" in sp.a) || !("ref" in sp.b) || sp.a.ref !== sp.b.ref) return null
		const [pa, pb] = [padAt(sp.a), padAt(sp.b)]
		const [wa, wb] = [besidePin(sp.a), besidePin(sp.b)]
		if (!pa || !pb || !wa || !wb) return null
		const [dx, dy] = [pb.x - pa.x, pb.y - pa.y]
		// Pin 1 is at -x at rotation 0, at -y at 90, at +x at 180 and at +y at 270 (counter-clockwise).
		const rotation = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 180) : dy >= 0 ? 90 : 270
		return { rotation, want: { x: (wa.x + wb.x) / 2, y: (wa.y + wb.y) / 2 } }
	}
	// How far a placed capacitor's farther end is from the pad it's wired to (0402 pads 0.5 mm either side of its centre;
	// pin 1 at -x before the turn).
	const reach = (b: Placed, sp: Support): number => {
		const r = (b.rotation * Math.PI) / 180
		const end = (k: number) => ({ x: (b.ox ?? b.x) + k * 0.5 * Math.cos(r), y: (b.oy ?? b.y) + k * 0.5 * Math.sin(r) })
		const [pa, pb] = [padAt(sp.a), padAt(sp.b)]
		const d = (e: { x: number; y: number }, p: { x: number; y: number } | null) => (p ? Math.hypot(e.x - p.x, e.y - p.y) : 0)
		// An end with its own capacitor between it and its pad (the other end is nearer that pad) routes round the body:
		// about one capacitor length more (VINT's capacitor pointing out from the 42×29 rover's turned U5: GND's trace
		// 14.7 mm against 5, 15 Nov 2026).
		const via = (e: number, p: { x: number; y: number } | null) => d(end(e), p) + (p && d(end(-e), p) < d(end(e), p) - 0.25 ? 1 : 0)
		return Math.max(via(-1, pa), via(1, pb))
	}
	// Any other part with its own pin parts (wired to its pins) is placed before them, for the same reason: a support
	// placed before its part has no pin to sit beside.
	const owners = new Set(supportParts(s).flatMap((sp) => (sp.added && "ref" in sp.a ? [sp.a.ref] : [])))
	for (const p of free) if (owners.has(p.ref)) put(p, centre)
	const supports = [...supportParts(s)].sort((a, b) => first(a) - first(b))
	for (const sp of supports) {
		const want = besidePin(sp.a) ?? besideCrystal(sp.a) ?? boxOf(sp.near) ?? centre
		if (sp.added) {
			if (done.has(sp.ref)) continue
			// A part's own pin capacitors, together when one of them is between two of its pads (alongPads): each can lie
			// out from its pad or along its pads, and the next one's room depends on where the first went (the 42×29 rover
			// with U5 turned 180°: VINT's capacitor along its pads took the column VCP's needed). Every combination is tried
			// (at most 2^4) and the one whose farthest capacitor end is nearest its pad is kept.
			const owner = "ref" in sp.a ? sp.a.ref : null
			const group = owner && sp.spec.kind === "capacitor" ? supports.filter((o) => o.added && o.spec.kind === "capacitor" && "ref" in o.a && o.a.ref === owner && !done.has(o.ref)) : []
			if (opts.capsAlong && group.length && group.length <= 4 && group.some((o) => alongPads(o))) {
				const mark = placed.length
				const lay = (order: Support[], mask: number): number => {
					placed.length = mark
					let worst = 0
					order.forEach((o, i) => {
						const hug = first(o) === 0 ? mcuPart?.ref : undefined
						const along = mask & (1 << i) ? alongPads(o) : null
						const ow = besidePin(o.a) ?? boxOf(o.near) ?? centre
						const b = along ? place(o.ref, o.spec.footprint, along.rotation, along.want, hug) : place(o.ref, o.spec.footprint, 0, ow, hug)
						if (b && !along && facesAway(b, o)) b.rotation = 180
						worst = Math.max(worst, b ? reach(b, o) : Infinity)
					})
					return worst
				}
				// The order matters too: the first placed takes the spot it wants. Every order for up to three capacitors.
				const orders = group.length <= 3 ? permutations(group) : [group]
				let best = { order: group, mask: 0 }
				let bestWorst = Infinity
				for (const order of orders)
					for (let mask = 0; mask < 1 << order.length; mask++) {
						if (order.some((o, i) => mask & (1 << i) && !alongPads(o))) continue
						const w = lay(order, mask)
						if (w < bestWorst - 1e-9) [best, bestWorst] = [{ order, mask }, w]
					}
				lay(best.order, best.mask)
				for (const o of group) done.add(o.ref)
				continue
			}
			done.add(sp.ref)
			// Across two pins of one part (VCP to VS2): its reserved spot, between the pads, is the target; beside the first
			// pad alone the grid spot there won and the second end was 7 mm off (CNC mock 8, 26 Nov 2026).
			const exact = reservedCaps.get(sp.ref)
			const both = exact && acrossSides(sp)
			const b = place(sp.ref, sp.spec.footprint, 0, both ? { x: exact.x, y: exact.y } : want, first(sp) === 0 ? mcuPart?.ref : undefined, exact)
			if (b && facesAway(b, sp)) b.rotation = 180
		} else put(free.find((p) => p.ref === sp.ref), want)
	}
	for (const p of free) put(p, centre)
	let debug: Placed | null = null
	if (debugEnabled(s) && debugPinout(s)) {
		const underside = (ref: string) => connectorRefs.has(ref) || ["mcu", "usb-c", "connector", "button", "battery"].includes(parts.find((p) => p.ref === ref)?.role ?? "")
		const usbBoxes = placed.filter((b) => connectorRefs.has(b.ref) || parts.find((p) => p.ref === b.ref)?.role === "usb-c")
		const supports = mountingHoles(s).length ? [] : [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => ({ x: sx * (W / 2 - 3), y: sy * (H / 2 - 3), w: 5, h: 5 }))
		const gap = (a: { x: number; y: number; w: number; h: number }, o: { x: number; y: number; w: number; h: number }) => Math.max(Math.abs(a.x - o.x) - (a.w + o.w) / 2, Math.abs(a.y - o.y) - (a.h + o.h) / 2)
		// Each part as far as its copper and courtyard reach (a dual-row IC's pads past its placement box): the holes clear that.
		const copperBoxes = placed.map((o) => {
			const d = dualRowExtent(parts.find((p) => p.ref === o.ref)?.footprint ?? "")
			if (!d) return o
			const [dw, dh] = Math.abs(o.rotation) % 180 === 90 ? [d[1], d[0]] : d
			return { ...o, w: Math.max(o.w, dw), h: Math.max(o.h, dh) }
		})
		let bestD = Infinity
		for (const rotation of [0, 90] as const) {
			const [w, h] = rotation === 0 ? [TC2030_ENVELOPE.w, TC2030_ENVELOPE.h] : [TC2030_ENVELOPE.h, TC2030_ENVELOPE.w]
			for (let i = 0; i <= W / GRID_MM; i++)
				for (let j = 0; j <= H / GRID_MM; j++) {
					const b: Placed = { ref: "JD1", x: -W / 2 + i * GRID_MM, y: -H / 2 + j * GRID_MM, w, h, rotation }
					const d = Math.hypot(b.x - centre.x, b.y - centre.y)
					if (d >= bestD - 1e-9) continue
					if (Math.abs(b.x) + w / 2 > W / 2 - EDGE_MARGIN_MM || Math.abs(b.y) + h / 2 > H / 2 - EDGE_MARGIN_MM) continue
					// The pads are on the underside: only a part that reaches it (a connector, the module, a battery, a
					// button) keeps clear of the whole footprint. Every top part keeps clear of the three holes.
					if (placed.some((o) => underside(o.ref) && gap(b, o) < TC2030.clearMm)) continue
					const holes = TC2030.holes.map(([hx, hy]) => ({ ...debugAt(hx, hy, b.x, b.y, rotation), w: TC2030.holeDiameterMm, h: TC2030.holeDiameterMm }))
					if (holes.some((hb) => copperBoxes.some((o) => gap(hb, o) < DEBUG_HOLE_CLEAR_MM) || keepouts.some((o) => overlaps(hb, o)))) continue
					if (keepouts.some((o) => overlaps(b, o)) || usbBoxes.some((o) => gap(b, o) < TEST_PAD.usbClearMm) || supports.some((o) => overlaps(b, o))) continue
					;[debug, bestD] = [b, d]
				}
		}
	}
	return { parts: placed, debug, blocked }
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

export function testPoints(s: ContractSnapshot, opts: PadOpts = {}): { placed: TestPoint[]; unplaced: string[] } {
	if (!s.values.outline || !s.values.test) return { placed: [], unplaced: [] }
	return padsOf(s, "test", opts)
}

// Bring-up pads (engineer, 13 Nov 2026: test points on every design, on by default): bare pads on the underside for
// the first bench session, on ground, the board's rails, a debug UART and each signal of a cable link to another board.
// Only without a production test (which probes every net it lists) and unless requirements.testPads is false. They come
// after every other pad and take only the room left: a pad with no room is dropped, never a reason to grow the board
// (the smallest board is found from the parts' placement alone). A net another bottom pad already carries (the recovery
// pads' GND) gets no second pad. VBUS has none: it is probed at the USB-C connector.
// TODO(learned parts): the nets a learned part adds (an amplifier's input and outputs) join this set once learned parts
// are wired into the board.
const UART_SIGNAL = /(^|_)(UART\d*|DEBUG|DBG|CONSOLE)_?(TX|RX)$|^U\d_(TX|RX)$|^L\d+_(TX|RX)$/i
export function bringupNets(s: ContractSnapshot): string[] {
	const { outline, test, requirements, pins = [], parts = [] } = s.values
	if (!outline || test || requirements?.testPads === false) return []
	const gen = generatedNets(s)
	const has = (net: string) => (gen.get(net)?.length ?? 0) >= 2
	const rails = [netName(SUPPLY_RAIL), ...(s.values.rails ?? []).map((r) => netName(r.name)), ...(parts.some((p) => p.role === "battery") ? ["VBAT"] : [])]
	const signals = pins.map((p) => p.signal)
	const links = linkBusTraces(s).map((t) => t.net)
	const nets = ["GND", ...rails.filter(has), ...signals.filter((n) => UART_SIGNAL.test(n)), ...links]
	return [...new Set(nets)]
}
export function bringupPads(s: ContractSnapshot, opts: PadOpts = {}): { placed: TestPoint[]; unplaced: string[] } {
	return padsOf(s, "bringup", opts)
}

// The layout the pads go round: the same placement options the board is built with (capsAlong, pinPads), else the
// debug footprint's spot was found on another layout (the arm board, 26 Nov 2026: C2 over JD1's holes on a pinPads layout).
type PadOpts = { capsAlong?: boolean; pinPads?: boolean }
function padsOf(s: ContractSnapshot, kind: PadKind, opts: PadOpts = {}): { placed: TestPoint[]; unplaced: string[] } {
	if (!s.values.outline) return { placed: [], unplaced: [] }
	const { placed, unplaced } = bottomPads(s, opts)
	return { placed: placed.filter((p) => p.kind === kind).map(({ kind: _k, ...p }) => p), unplaced: unplaced.filter((u) => u.kind === kind).map((u) => u.net) }
}

// The recovery pads (engineer, 8 Nov 2026, over a 7×9 mm button that made the logger's smallest board 27% bigger): BOOT
// on the MCU's boot pin and GND, bare copper on the bottom beside the production test pads. Shorted while the board
// powers up, they start the ROM downloader. BOOT joins the net of the signal that shares the pin (I2C_SCL on the
// logger), else its own net, BOOT.
export const RECOVERY_BOOT_NET = "BOOT"
export function recoveryPads(s: ContractSnapshot, opts: PadOpts = {}): { placed: TestPoint[]; unplaced: string[] } {
	if (!recoveryBootNet(s)) return { placed: [], unplaced: [] }
	return padsOf(s, "recovery", opts)
}

export function recoveryBootNet(s: ContractSnapshot): string | null {
	const boot = recoveryBootPin(s)
	if (!boot) return null
	const on = (s.values.pins ?? []).filter((p) => p.gpio === boot.gpio)
	if (on.some((p) => !sharesBootPin(p.signal))) return null
	return on[0]?.signal ?? RECOVERY_BOOT_NET
}

// Placing the parts is the slow step, and every consistency check and designer turn asks for the pads: the last few
// results are kept, keyed on the whole contract (placement reads most of it).
type PadKind = "test" | "recovery" | "bringup"
type BottomPads = { placed: (TestPoint & { kind: PadKind })[]; unplaced: { net: string; kind: PadKind }[]; debug: DebugPlacement | null; debugUnplaced: boolean }
const bottomPadsCache = new Map<string, BottomPads>()
// capsAlong: the pads around the layout with the pin capacitors along their pads (PlacementOptions.capsAlong), whose
// debug footprint can sit elsewhere; the default layout's otherwise.
function bottomPads(s: ContractSnapshot, opts: PadOpts = {}): BottomPads {
	const capsAlong = !!opts.capsAlong, pinPads = !!opts.pinPads
	const key = `${capsAlong ? "A" : "D"}${pinPads ? "S" : "P"}${JSON.stringify(s.values)}`
	const hit = bottomPadsCache.get(key)
	if (hit) return structuredClone(hit)
	const result = bottomPadsUncached(s, capsAlong, pinPads)
	if (bottomPadsCache.size >= 16) bottomPadsCache.delete(bottomPadsCache.keys().next().value!)
	bottomPadsCache.set(key, result)
	return structuredClone(result)
}

function bottomPadsUncached(s: ContractSnapshot, capsAlong = false, pinPads = false): BottomPads {
	const { outline, test, parts = [], pins = [] } = s.values
	const bootNet = recoveryBootNet(s)
	const bringup = bringupNets(s)
	const pinout = debugEnabled(s) ? debugPinout(s) : null
	if (!outline || (!test && !bootNet && !bringup.length && !pinout)) return { placed: [], unplaced: [], debug: null, debugUnplaced: false }
	const [W, H] = [outline.widthMm, outline.heightMm]
	const layout = layoutBoard(s, { ...(capsAlong ? { capsAlong } : {}), ...(pinPads ? { pinPads } : {}) })
	const boxes = layout.parts
	const byRef = new Map(boxes.map((b) => [b.ref, b]))
	const connectorRefs = new Set((s.values.connectors ?? []).map((c) => c.ref))
	const roleBox = (...roles: string[]) => roles.map((r) => parts.find((p) => p.role === r)).map((p) => p && byRef.get(p.ref)).find(Boolean)
	const blocked: { x: number; y: number; w: number; h: number }[] = [
		// Parts with a body or holes below the board's bottom face, or (the module) an antenna over it: by role, and any
		// through-hole footprint whatever its role (a power terminal has plated holes on both faces).
		...boxes.filter((b) => { const p = parts.find((x) => x.ref === b.ref); return connectorRefs.has(b.ref) || ["mcu", "usb-c", "connector", "button", "battery"].includes(p?.role ?? "") || (p ? THROUGH_HOLE_FOOTPRINT.test(footprintFor(p)) : false) }).map((b) =>
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
	const placed: BottomPads["placed"] = []
	const unplaced: BottomPads["unplaced"] = []
	const used = new Set<number>()
	const mcuBox = roleBox("mcu")
	const wanted = [
		...(test?.points ?? []).map((net, i) => ({ net, ref: `TP${i + 1}`, kind: "test" as const, want: anchor(net) })),
		// BOOT beside the part whose signal shares the pin (its trace stays short), else beside the module; GND next to it.
		...(bootNet ? [bootNet, "GND"].map((net, i) => ({ net, ref: `TPR${i + 1}`, kind: "recovery" as const, want: (i === 0 && bootNet !== RECOVERY_BOOT_NET ? anchor(net) : mcuBox) ?? { x: 0, y: 0 } })) : []),
		// Last: bring-up pads take what room is left, none on a net that already has a pad.
		...bringup.filter((net) => !(bootNet && (net === bootNet || net === "GND"))).map((net, i) => ({ net, ref: `TP${i + 1}`, kind: "bringup" as const, want: anchor(net) })),
	]
	let debug: DebugPlacement | null = null
	const placeOne = ({ net, ref, kind, want: wantedAt }: { net: string; ref: string; kind: PadKind; want: { x: number; y: number } }) => {
		const recovery = kind === "recovery"
		const prior = placed.find((p) => p.kind === "recovery")
		const want = recovery && prior ? prior : wantedAt
		let best = -1
		for (let k = 0; k < cells.length; k++) if (!used.has(k) && (best < 0 || Math.hypot(cells[k].x - want.x, cells[k].y - want.y) < Math.hypot(cells[best].x - want.x, cells[best].y - want.y) - 1e-9)) best = k
		if (best < 0) return void unplaced.push({ net, kind })
		used.add(best)
		const c = cells[best]
		placed.push({ ref, net, kind, x: c.x, y: c.y, xMm: +(c.x + W / 2).toFixed(3), yMm: +(c.y + H / 2).toFixed(3) })
	}
	// The debug footprint first, on the spot placement reserved for it; the pads' cells over it are taken.
	if (pinout && layout.debug) {
		debug = debugFrom(layout.debug, pinout, W, H)
		const e = debugEnvelope(debug.rotation)
		cells.forEach((c, k) => { if (Math.abs(c.x - debug!.x) < e.w / 2 + half && Math.abs(c.y - debug!.y) < e.h / 2 + half) used.add(k) })
	}
	wanted.forEach(placeOne)
	return { placed, unplaced, debug, debugUnplaced: !!pinout && !debug }
}

// The debug footprint (engineer, 13 Nov 2026, "A"): Tag-Connect TC2030-IDC-NL, the no-legs plug-of-nails cable, so any
// stock TC2030 cable, or a pogo head of our own, reaches the chip with nothing fitted. Drawing TC2030-IDC-NL-FP rev A
// (2011), top view: six contact pads ø0.787 mm in two rows at ±0.635 mm, columns 1.27 mm apart, pin 1 beside the single
// alignment hole; three non-plated holes ø0.991 mm at (-2.54, 0) and (+2.54, ±1.016); no solder paste on the pads; no
// tracks or vias between the pads; no other track within 0.020" of a pad (not enforced: tscircuit has no per-pad
// clearance rule); "DNL" in the BOM, so nothing is listed. The coordinates are the drawing's: tscircuit mirrors a
// bottom-side footprint itself (checked on a build, 13 Nov 2026), and this file mirrors them the same way.
export const TC2030 = {
	footprint: "Tag-Connect TC2030-IDC-NL",
	padDiameterMm: 0.787,
	holeDiameterMm: 0.991,
	clearMm: 0.508,
	pads: [[1, -1.27, -0.635], [2, -1.27, 0.635], [3, 0, -0.635], [4, 0, 0.635], [5, 1.27, -0.635], [6, 1.27, 0.635]] as const,
	holes: [[-2.54, 0], [2.54, 1.016], [2.54, -1.016]] as const,
}
// Pads and holes, unrotated: x ±(2.54 + 0.4955), y ±(1.016 + 0.4955).
// A hole's edge from a top part's body (an assumption: clear of its pads and courtyard, as a via would be).
const DEBUG_HOLE_CLEAR_MM = 0.3
const TC2030_ENVELOPE = { w: 2 * (2.54 + 0.991 / 2), h: 2 * (1.016 + 0.991 / 2) }
const debugEnvelope = (rotation: 0 | 90) => {
	const w = TC2030_ENVELOPE.w + 2 * TC2030.clearMm, h = TC2030_ENVELOPE.h + 2 * TC2030.clearMm
	return rotation === 0 ? { w, h } : { w: h, h: w }
}
// The drawing's (x, y) on the underside at (cx, cy), rotated counter-clockwise: mirrored in x first, as tscircuit does.
function debugAt(x: number, y: number, cx: number, cy: number, rotation: 0 | 90): { x: number; y: number } {
	const [mx, my] = [-x, y]
	const [rx, ry] = rotation === 0 ? [mx, my] : [-my, mx]
	return { x: +(cx + rx).toFixed(3), y: +(cy + ry).toFixed(3) }
}

export type DebugEnd = { net: string } | { ref: string; pin: string } | null
export interface DebugPinout {
	standard: "tc2030-swd" | "tc2030-esp-uart"
	pins: { pin: number; name: string; end: DebugEnd }[]
}
export interface DebugPlacement {
	ref: "JD1"
	// Board-centred, and in the contract frame (origin bottom-left), top view.
	x: number
	y: number
	xMm: number
	yMm: number
	rotation: 0 | 90
	pinout: DebugPinout
	pads: { pin: number; name: string; end: DebugEnd; x: number; y: number }[]
	holes: { x: number; y: number }[]
}

function debugEnabled(s: ContractSnapshot): boolean {
	return !!s.values.outline && s.values.requirements?.debugPort !== false
}

// What each of the six pins carries, from the MCU's profile. An STM32 (any SWD chip) gets ARM's standard TC2030 pinout:
// 1 VCC, 2 SWDIO, 3 NRST, 4 SWCLK, 5 GND, 6 SWO (only on a Cortex-M3/M4/M7: a Cortex-M0+ has no SWO). An ESP32 gets the
// UART-download one Espressif's programmers use: 1 3V3, 2 TXD0, 3 EN, 4 RXD0, 5 GND, 6 the boot pin. A pin the contract
// gives to another job is left unconnected (null): the cable never shares a line with something else. None when the
// chip has no profile, the board no 3V3 rail, or neither data line is free.
export function debugPinout(s: ContractSnapshot): DebugPinout | null {
	const { parts = [], pins = [], rails = [] } = s.values
	const mcu = parts.find((p) => p.role === "mcu")
	const prof = mcu ? profileForPart(mcu) : null
	if (!mcu || !prof || !rails.some((r) => r.name === SUPPLY_RAIL)) return null
	const supply = { net: netName(SUPPLY_RAIL) }
	const GND = { net: "GND" }
	const chip = chipProfile(mcu)
	const labels = chip ? new Set(chipPadLabels(chip).values()) : null
	// The pad's name in traces: a chip's label, a module pin the contract lists, else the module's pad number.
	const pad = (name: string): DebugEnd => {
		if (labels) return labels.has(name) ? { ref: mcu.ref, pin: name } : null
		if (mcu.pins.includes(name)) return { ref: mcu.ref, pin: name }
		const n = prof.pins.find((p) => p.name === name)?.pads[0]
		return n ? { ref: mcu.ref, pin: `pin${n}` } : null
	}
	// A design pin: its contract net when the contract uses it for the same job (fits), the bare pad when it is free.
	const designPin = (name: string | undefined, fits: (signal: string) => boolean): DebugEnd => {
		if (!name) return null
		const pin = prof.pins.find((p) => p.name === name)
		const used = pin ? pins.filter((p) => p.gpio === pin.index) : []
		if (used.length) return used.every((u) => fits(u.signal)) ? { net: used[0].signal } : null
		return pad(name)
	}
	const never = () => false
	let out: DebugPinout
	if (prof.programming.method === "swd") {
		const [dio, clk] = prof.programming.pins
		const resetJob = prof.support.find((j) => /NRST|reset/i.test(j.job) && j.a.startsWith("pin:"))
		const resetName = resetJob?.a.slice(4) ?? prof.power.find((x) => x.net === "reset")?.name
		const swo = /Cortex-M(3|4|7)/i.test(prof.core) && prof.pins.some((p) => p.name === "PB3" && p.signals.some((x) => /SWO/.test(x))) ? "PB3" : undefined
		out = { standard: "tc2030-swd", pins: [
			{ pin: 1, name: "VCC", end: supply },
			{ pin: 2, name: "SWDIO", end: designPin(dio, never) },
			{ pin: 3, name: "NRST", end: resetName ? pad(resetName) : null },
			{ pin: 4, name: "SWCLK", end: designPin(clk, never) },
			{ pin: 5, name: "GND", end: GND },
			{ pin: 6, name: "SWO", end: designPin(swo, never) },
		] }
	} else if (prof.console && mcu.pins.includes("EN")) {
		const boot = recoveryBootPin(s)
		const bootNet = recoveryBootNet(s)
		const uart = (dir: "TX" | "RX") => (signal: string) => UART_SIGNAL.test(signal) && signal.toUpperCase().endsWith(dir)
		out = { standard: "tc2030-esp-uart", pins: [
			{ pin: 1, name: "3V3", end: supply },
			{ pin: 2, name: "TXD0", end: designPin(prof.console.tx, uart("TX")) },
			{ pin: 3, name: "EN", end: { net: MCU_EN_NET } },
			{ pin: 4, name: "RXD0", end: designPin(prof.console.rx, uart("RX")) },
			{ pin: 5, name: "GND", end: GND },
			{ pin: 6, name: "BOOT", end: !boot || !bootNet ? null : bootNet === RECOVERY_BOOT_NET ? { ref: boot.mcu.ref, pin: boot.pin } : { net: bootNet } },
		] }
	} else return null
	return out.pins[1].end || out.pins[3].end ? out : null
}

// The footprint on the spot placement reserved for it (layoutBoard), its pads and holes in board coordinates.
function debugFrom(box: Placed, pinout: DebugPinout, W: number, H: number): DebugPlacement {
	const { x, y } = box
	const rotation = box.rotation === 90 ? 90 : 0
	return {
		ref: "JD1", x, y, rotation, xMm: +(x + W / 2).toFixed(3), yMm: +(y + H / 2).toFixed(3), pinout,
		pads: TC2030.pads.map(([pin, px, py]) => ({ pin, name: pinout.pins[pin - 1].name, end: pinout.pins[pin - 1].end, ...debugAt(px, py, x, y, rotation) })),
		holes: TC2030.holes.map(([hx, hy]) => debugAt(hx, hy, x, y, rotation)),
	}
}

// The debug footprint as placed on this board, or why not: off (requirements.debugPort false, no pinout) or no room.
export function debugPort(s: ContractSnapshot, opts: PadOpts = {}): { placed: DebugPlacement | null; unplaced: boolean } {
	if (!debugEnabled(s) || !debugPinout(s)) return { placed: null, unplaced: false }
	const b = bottomPads(s, opts)
	return { placed: b.debug, unplaced: b.debugUnplaced }
}

function at(placement: Map<string, Placed>, ref: string): string {
	const b = placement.get(ref)
	return b ? ` pcbX={${+(b.ox ?? b.x).toFixed(2)}} pcbY={${+(b.oy ?? b.y).toFixed(2)}} pcbRotation={${b.rotation}}` : ""
}

// The power and USB nets the generator wires on top of the contract's own signals: GND, the 3V3 rail, VBUS, VBAT (when
// there is a charger) and USB D±, with the support passives' ends. Ends are "REF.pin". Only nets that reach at least
// two components are kept; a one-component net can't be routed.
// An ESP32 module's EN, between its RC delay (supportParts) and the chip.
export const MCU_EN_NET = "MCU_EN"
const POWER_NETS = ["GND", netName(SUPPLY_RAIL), "VBUS", "VBAT", "USB_DP", "USB_DN", USB_SENSE_NET, MCU_EN_NET, "MOTOR_A1", "MOTOR_A2", "MOTOR_B1", "MOTOR_B2", "MOTOR_C1", "MOTOR_C2", "MOTOR_D1", "MOTOR_D2", "SERVO1", "SERVO2"]

// A rover's motor connectors: two-pin connectors, in ref order (JM1 motor A, JM2 motor B).
// A motor's plug: a 2-pin one (pins 1 and 2), or an encoder gearmotor's 6-pin one (M1, M2 for the motor, VCC, GND and
// ENCA/ENCB for its encoder; catalog SM06B-SRSS-TB).
// The motor drivers in ref order: one on a differential rover, two on a skid-steer one (front, then rear).
export const motorDrivers = (parts: Part[]) => parts.filter((p) => p.role === "motor-driver").sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }))
// The rear driver's inputs (a skid-steer rover): its AIN1/AIN2 on the nets of the front driver's AIN1/AIN2 (the left
// side), its BIN1/BIN2 on those of BIN1/BIN2 (the right): each side's two motors run on the same PWM.
export function skidDriverTraces(s: ContractSnapshot): { net: string; ref: string; pin: string }[] {
	const [front, rear] = motorDrivers(s.values.parts ?? [])
	if (!front || !rear || s.values.mechanics?.drive.kind !== "skid4") return []
	return (s.values.pins ?? []).filter((p) => p.partRef === front.ref && /^[AB]IN[12]$/.test(p.partPin) && rear.pins.includes(p.partPin)).map((p) => ({ net: p.signal, ref: rear.ref, pin: p.partPin }))
}
export const motorConnectors = (parts: Part[]) => parts.filter(isMotorPlug).sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }))

// The router's default track (tscircuit 0.0.3042: 0.15 mm), enough for the rails up to about 0.6 A (IPC-2221 below).
export const DEFAULT_TRACE_MM = 0.15
// IPC-2221's external-layer track width for a current: A = (I / (k·ΔT^0.44))^(1/0.725) mil², k = 0.048, over 1 oz
// copper (1.378 mil thick), for a 10 °C rise (IPC-2221 §6.2 / Fig. 6-4; the common chart's conservative choice). An
// ESTIMATE of the chart, not a thermal simulation; rounded up to 0.05 mm.
export function ipc2221WidthMm(amps: number, riseC = 10): number {
	const areaMil2 = (amps / (0.048 * riseC ** 0.44)) ** (1 / 0.725)
	return Math.round(Math.ceil(((areaMil2 / 1.378) * 0.0254) / 0.05 - 1e-9) * 5) / 100
}
// The widest track that still reaches a pin of a 2.54 mm header without touching its neighbours (pads about Ø1.7 mm,
// 0.2 mm clearance each side: 2.54 - 1.7 - 0.4 ≈ 0.45 mm beside a pad, about 1 mm onto one). Wider than this, a track
// cut across the next pins (a 2.8 mm GND track over a HAT's header pins 27-29, 15 Nov 2026): such a net is a pour.
export const MAX_TRACK_MM = 1
export const POUR = { clearanceMm: 0.3, edgeMm: 0.5 }
// The track width each supply net needs where the default is too thin: a rail by its peak load (loadMa), ground by the
// largest rail's (the return carries it). A board whose rails all fit the default gets none, so its routing is unchanged.
// An emergency stop button's plug (role estop, pins VBAT and VM): its NC contact opens the motors' supply
// (catalog/mechanics.json safety; Eurobot General Rules 1.2 F.4.c). With one, the driver's VM is fed from MOTOR_VM.
export const MOTOR_VM_NET = "MOTOR_VM"
export function estopPlug(parts: Part[]): Part | undefined {
	return parts.find((p) => p.role === "estop" && p.pins.includes("VBAT") && p.pins.includes("VM"))
}
// The net a motor driver's VM sits on: after the emergency stop when there is one, else the cell (or USB's VBUS with no
// cell on the board).
export function motorSupplyNet(parts: Part[]): string {
	if (estopPlug(parts)) return MOTOR_VM_NET
	return parts.some((p) => p.role === "charger" || p.role === "battery") ? "VBAT" : "VBUS"
}
// A robot's motor stall current at its pack's full voltage (catalog/mechanics.json, the mech-current check's model), or
// null without a motor driver and mechanics naming catalog parts.
const MECH = JSON.parse(readFileSync(new URL("../../catalog/mechanics.json", import.meta.url), "utf8")) as { motors: { mpn: string; stallA: number; ratedV: number }[]; batteries: { mpn: string; fullV: number }[] }
const mechByMpn = <T extends { mpn: string }>(list: T[], mpn: string) => list.find((p) => p.mpn === mpn) ?? list.find((p) => p.mpn.split(/\s+/)[0] === mpn.split(/\s+/)[0])
export function motorStallA(s: ContractSnapshot): number | null {
	const m = s.values.mechanics
	if (!m || !(s.values.parts ?? []).some((p) => p.role === "motor-driver")) return null
	const motor = mechByMpn(MECH.motors, m.drive.motor), pack = mechByMpn(MECH.batteries, m.battery.pack)
	return motor && pack ? (motor.stallA * pack.fullV) / motor.ratedV : null
}
export function supplyWidths(s: ContractSnapshot): Map<string, number> {
	const out = new Map<string, number>()
	// The rails the code generates (an arm's servo rails and brick input) count with the contract's.
	for (const r of withArmRails(s.values.rails ?? [], s)) {
		const w = Math.round(ipc2221WidthMm(r.loadMa / 1000) * 100) / 100
		if (w <= DEFAULT_TRACE_MM) continue
		out.set(netName(r.name), w)
		out.set("GND", Math.max(out.get("GND") ?? 0, w))
	}
	// The motor outputs (MOTOR_A1…B2) carry a motor's stall current at the pack's full voltage (stall scales with the
	// voltage): IPC-2221 width for it when that is over the default track (a high-power motor, or a 6 V one on 2S).
	const stall = motorStallA(s)
	if (stall !== null) {
		const w = Math.round(ipc2221WidthMm(stall) * 100) / 100
		if (w > DEFAULT_TRACE_MM) for (const side of ["A", "B"]) for (const n of ["1", "2"]) out.set(`MOTOR_${side}${n}`, w)
	}
	// The motors' supply after the emergency stop carries the cell's current, as VBAT does.
	if (estopPlug(s.values.parts ?? []) && out.has("VBAT")) out.set(MOTOR_VM_NET, out.get("VBAT")!)
	return out
}
// A net too wide for a track (MAX_TRACK_MM) becomes a copper pour: the one rail on top, ground on the bottom. A board
// with two such rails can't pour both on two layers: the second keeps its wide track, and the check says so
// (rail-current-copper).
// On a board Freerouting routes (freerouting), ground only: it routes over a plane as one conductor, so a top-layer rail
// pour came back cut into islands by the top tracks, each holding pads it never joined (the arm board, 26 Nov 2026:
// VIN_BRICK in 11 pieces after the refill); it routes each rail as a track at its width instead (routedWidths).
// tscircuit pours after routing, around its tracks, so its boards keep the rail pour (the rpi-5 HAT's 5 V).
export function supplyPours(s: ContractSnapshot, freerouting = false): { net: string; layer: "top" | "bottom" }[] {
	// A Freerouting board always pours ground on the bottom, whatever its width needs (lead-2, 26 Nov 2026: good practice
	// for return paths and EMI; lead-3's CNC mock 9: GND needed 0.35 mm, under MAX_TRACK_MM, got no pour and was routed
	// at 0.2 mm on 162 of 246 mm).
	if (freerouting) return [{ net: "GND", layer: "bottom" }]
	const wide = [...supplyWidths(s)].filter(([, w]) => w > MAX_TRACK_MM).map(([n]) => n)
	if (!wide.length) return []
	if (freerouting) return [{ net: "GND", layer: "bottom" }]
	const rail = wide.filter((n) => n !== "GND").sort((a, b) => supplyWidths(s).get(b)! - supplyWidths(s).get(a)!)[0]
	return [...(rail ? [{ net: rail, layer: "top" as const }] : []), { net: "GND", layer: "bottom" as const }]
}
// A wide rail's lane: the copper a rail wider than a track reaching a pin (MAX_TRACK_MM) needs between its parts, which
// placement alone doesn't count (the arm board, 26 Nov 2026: at its placement minimum 62×47 the rails reached their
// IPC-2221 width on only 10-21 % of their track). Its length is ESTIMATED as the Manhattan spanning tree over its parts'
// centres (88-116 mm on the arm against 94-155 mm routed), its width the rail's own plus the fab's clearance a side.
export interface RailCorridor {
	net: string
	widthMm: number
	lengthMm: number
	areaMm2: number
}
export function railCorridors(s: ContractSnapshot, placed: { ref: string; x: number; y: number }[] = placeParts(s)): RailCorridor[] {
	const freerouted = wideTracks(s).length > 0
	const wide = [...routedWidths(s, freerouted)].filter(([, w]) => w > MAX_TRACK_MM)
	if (!wide.length) return []
	const at = new Map(placed.map((b) => [b.ref, b]))
	const nets = generatedNets(s)
	return wide.map(([net, widthMm]) => {
		const pts = [...new Set((nets.get(net) ?? []).map((e) => e.split(".")[0]))].flatMap((r) => (at.has(r) ? [at.get(r)!] : []))
		let lengthMm = 0
		const tree = new Set(pts.length ? [0] : [])
		while (tree.size < pts.length) {
			let best = Infinity
			let next = -1
			for (const i of tree) for (let j = 0; j < pts.length; j++) if (!tree.has(j)) {
				const d = Math.abs(pts[i].x - pts[j].x) + Math.abs(pts[i].y - pts[j].y)
				if (d < best) [best, next] = [d, j]
			}
			tree.add(next)
			lengthMm += best
		}
		return { net, widthMm, lengthMm: Math.round(lengthMm), areaMm2: Math.round(lengthMm * (widthMm + 2 * ROUTE.clearanceMm)) }
	})
}

// The copper layers a board needs (lead-2, 26 Nov 2026): 4 when its wide rails' lanes (railCorridors) take more than
// LANES_4L_SHARE of its area, an estimate that was right about the arm; the board build adds 4 after a measured shortfall
// at 2 (track-width-narrow) and records it in outline.layers. On 4 layers the rails ride the power plane (In2).
export const LANES_4L_SHARE = 0.15
// The designs whose 2-layer build left a rail short (board.ts): they build at 4 from then on, as a measured reason.
const layerShortfalls = new Map<string, string>()
const layersKey = (s: ContractSnapshot) => JSON.stringify([(s.values.parts ?? []).map((p) => `${p.ref} ${p.mpn}`), s.values.rails, s.values.arm?.railV])
export function recordLayerShortfall(s: ContractSnapshot, detail: string): void {
	layerShortfalls.set(layersKey(s), detail)
}
// A 4-layer try that failed too: the design goes back to 2 layers (its size is then the architect's question).
export function forgetLayerShortfall(s: ContractSnapshot): void {
	layerShortfalls.delete(layersKey(s))
}
export function boardLayers(s: ContractSnapshot): { layers: 2 | 4; reason: { by: "estimate" | "measured"; detail: string } | null } {
	const o = s.values.outline
	if (o?.layers === 4) return { layers: 4, reason: o.layersReason ?? null }
	const measured = layerShortfalls.get(layersKey(s))
	if (measured) return { layers: 4, reason: { by: "measured", detail: measured } }
	if (!o) return { layers: 2, reason: null }
	const c = railCorridors(s)
	const lanes = c.reduce((a, x) => a + x.areaMm2, 0)
	const share = lanes / (o.widthMm * o.heightMm)
	if (share <= LANES_4L_SHARE) return { layers: 2, reason: null }
	return { layers: 4, reason: { by: "estimate", detail: `the wide rails' lanes (${c.map((x) => `${x.net} ${x.widthMm} mm x ${x.lengthMm} mm`).join(", ")}; IPC-2221 widths, lengths estimated) are ${Math.round(share * 100)} % of the ${o.widthMm}x${o.heightMm} mm board, over ${LANES_4L_SHARE * 100} %: they ride a power layer` } }
}

// The wide rails a 4-layer board carries on its power layer (In2): those over a track reaching a pin (MAX_TRACK_MM), each
// a region of In2 around its pads and its support parts (plane-regions.ts).
export const planeRails = (s: ContractSnapshot) => (boardLayers(s).layers === 4 ? [...routedWidths(s, true)].filter(([n, w]) => w > MAX_TRACK_MM && n !== "GND").map(([n]) => n) : [])
export function powerPlaneRegions(s: ContractSnapshot, placement: Map<string, Placed> = new Map(placeParts(s).map((b) => [b.ref, b]))): PlaneRegion[] {
	const o = s.values.outline
	const nets = planeRails(s)
	if (!o || !nets.length) return []
	const parts = s.values.parts ?? []
	const gen = generatedNets(s)
	const centre = (ref: string, pin?: string) => {
		const b = placement.get(ref)
		if (!b) return null
		const part = parts.find((p) => p.ref === ref)
		const at = part && pin && b.rotation % 90 === 0 ? padOffset(footprintFor(part), part.pins.indexOf(pin) + 1, b.rotation) : null
		return { x: (b.ox ?? b.x) + (at?.x ?? 0), y: (b.oy ?? b.y) + (at?.y ?? 0) }
	}
	const sup = supportParts(s)
	const rails = nets.map((net) => ({
		net,
		points: [
			...(gen.get(net) ?? []).map((e) => centre(e.split(".")[0], e.split(".")[1])),
			...sup.filter((x) => ("net" in x.a && x.a.net === net) || ("net" in x.b && x.b.net === net)).map((x) => centre(x.ref)),
		].filter((p): p is { x: number; y: number } => p !== null),
	}))
	return planeRegions(o.widthMm, o.heightMm, rails)
}
// The track widths each routed net needs: the supply widths, except the nets poured (their tracks stay the default).
// Full width: Freerouting takes it as the net's class and necks the track down only to enter a pin, so MAX_TRACK_MM
// bounds the track where it meets a pin, not the run between (lead-2, 26 Nov 2026: "MAX_TRACK_MM then caps only where a
// track must pass between pins, not on a short rail run from a chip to its own plug group").
export function routedWidths(s: ContractSnapshot, freerouting = false): Map<string, number> {
	const poured = new Set(supplyPours(s, freerouting).map((p) => p.net))
	return new Map([...supplyWidths(s)].filter(([n]) => !poured.has(n)))
}
// The nets wider than a track reaching a pin (MAX_TRACK_MM) that no pour carries: only Freerouting routes them at width
// (tscircuit's router has no neck-down), so a board with one goes to Freerouting first (board.ts).
export const wideTracks = (s: ContractSnapshot) => [...routedWidths(s)].filter(([, w]) => w > MAX_TRACK_MM)
// The track widths codegen asks tscircuit for: routedWidths capped at MAX_TRACK_MM (its router can't neck down at a pin).
export function netTraceWidths(s: ContractSnapshot): Map<string, number> {
	return new Map([...routedWidths(s)].map(([n, w]) => [n, Math.min(w, Math.max(MAX_TRACK_MM, DEFAULT_TRACE_MM))]))
}

// The net feeding the LDO's input: the one its nets name (VIN) when they do, else the charger's output (VBAT) when there
// is one, else USB: a pack charged off the board (often 2S, over a 5.5 V LDO) feeds only the motors unless the contract
// says otherwise. Before, the default was joined on top of the contract's choice: real run 15 put VIN on VBAT, the
// default added VBUS, and USB 5 V met the cell on one pad.
// A robot's power tree when its pack has no charger on the board (the pack charged off it): the cell feeds the LDO
// through a Schottky, OR'd with USB's VBUS through another, so the 3V3 rail runs on battery and on USB and neither
// back-feeds the other. A pack over the LDO's maximum input (a 2S LiPo on a 5.5 V LDO) feeds a 5 V step-down first,
// whose output takes the battery diode. Real run 16 (Eurobot, 16 Nov 2026): the LDO hung on VBUS alone, so on battery
// the 3V3 rail (MCU, encoders, sensor) was dead. Null when it doesn't apply or its diodes aren't in the parts yet
// (supplyWiring's rail-battery-source names them).
export const VIN_OR_NET = "VIN_OR"
export const BUCK_NET = "V5"
// The step-down chip's switch node (SW to its inductor).
export const BUCK_SW_NET = "BUCK_SW"
// The battery path: an ideal diode (role ideal-diode, LM66100: VIN, VOUT, CE on VOUT) on a 1S cell, whose voltage a
// Schottky's drop would take under the LDO's; behind a step-down, a Schottky (5 V has room for it). VBUS: a Schottky.
export function powerTree(s: ContractSnapshot): { battery: Part; usb: Part; buck?: Part } | null {
	const parts = s.values.parts ?? []
	if (!(parts.some((p) => p.role === "battery") || machineInput(s)) || parts.some((p) => p.role === "charger") || !parts.some((p) => p.role === "ldo")) return null
	const diodes = parts.filter((p) => p.role === "diode" && p.pins.includes("A") && p.pins.includes("K")).sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }))
	const ideal = parts.find((p) => p.role === "ideal-diode" && p.pins.includes("VIN") && p.pins.includes("VOUT"))
	const buck = parts.find((p) => p.role === "buck")
	const battery = ideal ?? (diodes.length >= 2 ? diodes[0] : undefined)
	const usb = ideal ? diodes[0] : diodes[1]
	if (!battery || !usb) return null
	return { battery, usb, ...(buck ? { buck } : {}) }
}
// The net the power tree's input sits on: the cell (VBAT), or a machine's brick (machineInput: an arm's armInputNet, a
// CNC's motor rail).
export const packNet = (s: ContractSnapshot) => machineInput(s)?.net ?? "VBAT"
// An arm's DC input jack (the catalog's DC-091-A250: VIN on its centre pin).
export const armJack = (s: ContractSnapshot) => (s.values.arm ? (s.values.parts ?? []).find((p) => p.mpn === "DC-091-A250") : undefined)
// A machine's brick input: its DC jack, the net the jack's VIN is on, and the brick's volts. An arm's is armInputNet at
// arm.input; a CNC's (cncTargets) is the net its jack names (the motor rail, VMOT) at that rail's voltage, so the
// logic's 5 V comes from the brick too: off USB only, the MCU was dead without the cable (CNC gap 6, 26 Nov 2026).
export function machineInput(s: ContractSnapshot): { jack: Part; net: string; volts: number } | null {
	const jack = (s.values.parts ?? []).find((p) => p.mpn === "DC-091-A250")
	if (!jack) return null
	if (s.values.arm) return { jack, net: armInputNet, volts: s.values.arm.input.volts }
	if (!s.values.cncTargets && !s.values.cnc) return null
	const net = jack.nets?.VIN
	const rail = net ? (s.values.rails ?? []).find((r) => r.name === net || netName(r.name) === net) : undefined
	return net && rail ? { jack, net, volts: rail.voltageV } : null
}
// A battery-path part's input and output pins: an ideal diode's VIN/VOUT, a Schottky's A/K.
const pathPins = (p: Part) => (p.role === "ideal-diode" ? { in: "VIN", out: "VOUT" } : { in: "A", out: "K" })

// A robot's servo outputs (parts with role servo), driven by a PCA9685 (role pwm-driver) on the I2C bus, powered by a
// servo supply (role servo-supply), and a spare motor on a second DRV8833 whose inputs come from the PCA9685 (on a
// differential rover; a skid-steer rover's second driver is its rear pair). Null without a PWM driver.
export const SERVO_5V_NET = "SERVO_5V"
// The SY8205 servo supply's switch node and feedback point.
export const SERVO_SW_NET = "SERVO_SW"
export const SERVO_FB_NET = "SERVO_FB"
export function servoOutputs(parts: Part[]): { pwm: Part; servos: Part[]; supply?: Part; spare?: Part } | null {
	const pwm = parts.find((p) => p.role === "pwm-driver")
	if (!pwm) return null
	const servos = parts.filter((p) => p.role === "servo").sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true })).slice(0, 2)
	const supply = parts.find((p) => p.role === "servo-supply")
	const spare = motorDrivers(parts)[1]
	return { pwm, servos, ...(supply ? { supply } : {}), ...(spare ? { spare } : {}) }
}
// The I2C pins of the bus devices the generator wires itself (the PCA9685, the IMU) on the board's bus: the contract's
// I2C_SDA and I2C_SCL nets, which come from its pins, not from generatedNets.
export const I2C_DEVICE_ROLES = ["pwm-driver", "imu"]
export function i2cDeviceTraces(s: ContractSnapshot): { net: string; ref: string; pin: string }[] {
	const signals = new Set((s.values.pins ?? []).map((p) => p.signal))
	return (s.values.parts ?? [])
		.filter((p) => I2C_DEVICE_ROLES.includes(p.role ?? ""))
		.flatMap((d) => ([["I2C_SDA", "SDA"], ["I2C_SCL", "SCL"]] as const).filter(([net, pin]) => signals.has(net) && d.pins.includes(pin)).map(([net, pin]) => ({ net, ref: d.ref, pin })))
}

export function ldoInputNet(s: ContractSnapshot): string {
	if (powerTree(s)) return VIN_OR_NET
	const parts = s.values.parts ?? []
	const own = parts.find((p) => p.role === "ldo")?.nets?.VIN
	if (own && own !== "GND") return netName(own)
	return parts.some((p) => p.role === "charger") ? "VBAT" : "VBUS"
}

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
	// A pin on two nets shorts them (real run 15: VIN on VBUS and VBAT, USB 5 V onto the cell): the net-short check
	// (consistency.ts) refuses it. The contract's assignment doesn't silently win: run 12's put the motor driver's VM on
	// VBAT, which would bypass the emergency stop's MOTOR_VM.
	// A pin listed once per net: a part's own nets (Part.nets, the arm's rail chips and jack, 25 Nov 2026) and the wiring
	// below may both name it.
	// A pin the contract puts on a net other than ground: by its part's nets, or as a signal's part pin.
	const wiredElsewhere = (p: Part, pin: string) => {
		const own = p.nets?.[pin]
		return (own !== undefined && own !== "GND") || pins.some((x) => x.partRef === p.ref && x.partPin === pin)
	}
	const join = (net: string, ref: string, pin: string) => {
		const list = nets.get(net)!
		if (!list.includes(`${ref}.${pin}`)) list.push(`${ref}.${pin}`)
	}

	for (const p of parts) {
		if (footprintFor(p) === USBC_FOOTPRINT || p.role === "button") continue
		for (const pin of p.pins) {
			// A pin named GND (or VSS) is ground unless the contract wires it elsewhere: its part's nets or the pins field
			// naming another net win over the name (lead-2, 26 Nov 2026). The catalog's KF301 terminal (pins VIN, GND) on a
			// spindle's minus lead would otherwise have shorted the spindle past its switch. Only the name rule yields: the
			// generator's deliberate grounds (a PWM driver's OE, an IMU's address strap) still meet net-short.
			if (GROUND_PINS.has(pin) && !wiredElsewhere(p, pin)) join("GND", p.ref, pin)
			// A link connector's VCC carries power only when its link says so (below): two boards' regulators never meet.
			if (hasSupply && p.role !== "ldo" && p.role !== "charger" && p.role !== "connector" && SUPPLY_PINS.has(pin)) join(supply, p.ref, pin)
		}
	}
	// Pins the contract names a rail for (Part.nets): a numbered header's 5 V and ground pins, a power input's VIN. A rail
	// the contract doesn't have is skipped here and reported by the check (part-net-unknown), never wired to a guess.
	const railNames = new Set(rails.map((r) => r.name))
	for (const p of parts)
		for (const [pin, rail] of Object.entries(p.nets ?? {})) {
			// "@<name>": a net a chip's catalog entry names too (chip-support.ts "@" ends): a CNC's motor plug on its
			// driver's outputs. The check (part-net-unknown) reports one nothing else is on.
			if (rail.startsWith("@") && p.pins.includes(pin)) {
				const net = rail.slice(1)
				if (!nets.has(net)) nets.set(net, [])
				if (!nets.get(net)!.includes(`${p.ref}.${pin}`)) join(net, p.ref, pin)
				continue
			}
			if (!p.pins.includes(pin) || (rail !== "GND" && !railNames.has(rail))) continue
			// The power tree owns the LDO's input (VIN_OR): a contract rail there would short the tree's sources.
			if (p.role === "ldo" && pin === "VIN" && powerTree(s)) continue
			const net = rail === "GND" ? "GND" : netName(rail)
			if (!nets.has(net)) nets.set(net, [])
			if (!nets.get(net)!.includes(`${p.ref}.${pin}`)) join(net, p.ref, pin)
		}
	// A bare chip's supply and ground pads (its profile), joined to the rails by label.
	const chip = chipProfile(mcu)
	if (chip && mcu) {
		const power = chipPowerPins(chip)
		for (const pin of power.ground) if (!GROUND_PINS.has(pin)) join("GND", mcu.ref, pin)
		if (hasSupply) for (const pin of power.supply) if (!GROUND_PINS.has(pin) && !SUPPLY_PINS.has(pin)) join(supply, mcu.ref, pin)
	}
	// The ESP32 module's EN must not float: its own net, pulled up through Espressif's RC delay (supportParts), so the chip
	// starts after its supply is up and a debug cable can pull EN low to reset it.
	if (hasSupply && mcu?.pins.includes("EN")) join(MCU_EN_NET, mcu.ref, "EN")

	// The IMU (role imu, the LSM6DS3TR-C) on the I2C bus in I2C mode, address 0x6A (ST DocID030071 Rev 3, Table 2 and
	// 6.1.1): CS and VDDIO to the supply (CS high selects I2C), SA0 low, the master pins SDx/SCx to GND (Mode 1), its
	// second GND pad to ground; INT1, INT2 and the NC pads stay open (NC soldered, unconnected). SCL/SDA join the bus in
	// circuitFromContract (i2cDeviceTraces).
	for (const imu of parts.filter((p) => p.role === "imu")) {
		for (const pin of ["GND_2", "SA0", "SDX", "SCX"]) if (imu.pins.includes(pin)) join("GND", imu.ref, pin)
		if (hasSupply) for (const pin of ["VDDIO", "CS"]) if (imu.pins.includes(pin)) join(supply, imu.ref, pin)
	}
	// Servos and a spare motor through a PCA9685 on the I2C bus (servoOutputs): channels 0 and 1 to the servo plugs'
	// signal pins, 2 and 3 to the spare driver's AIN1/AIN2 (its channel B off). Address 0x40: A0-A5, OE and EXTCLK low.
	// The servo supply (a 5 V step-down module) takes the cell before the emergency stop, and its EN the motors' supply
	// after it (with 10 kΩ to GND): the stop's NC contact switches the servos off without carrying their current (the
	// OMRON A22E breaks 1.5 A inductive; two servos at stall through it would pass that).
	// An arm (values.arm, arm task 6): one plug per servo on its joint's PCA9685 channel (LED<channel>), its +V on its
	// rail (armRails: VSERVO1.., each an SY8368A at the arm's rail voltage from the brick), and the DC jack's centre
	// pin on armInputNet. No emergency stop: each rail's EN on the input (the SY8368A's EN takes up to 30 V).
	const armRailList = armRails(s)
	const pwmArm = armRailList ? parts.find((p) => p.role === "pwm-driver") : undefined
	if (armRailList) {
		if (!nets.has(armInputNet)) nets.set(armInputNet, [])
		const jack = armJack(s)
		if (jack?.pins.includes("VIN")) join(armInputNet, jack.ref, "VIN")
		for (const pin of ["GND_2", "GND_3", "GND_4"]) if (jack?.pins.includes(pin)) join("GND", jack.ref, pin)
		if (pwmArm) for (const pin of ["A0", "A1", "A2", "A3", "A4", "A5", "OE", "EXTCLK"]) if (pwmArm.pins.includes(pin)) join("GND", pwmArm.ref, pin)
		for (const rail of armRailList) {
			for (const n of [rail.net, `${rail.net}_SW`, `${rail.net}_FB`]) if (!nets.has(n)) nets.set(n, [])
			const chip = parts.find((p) => p.ref === rail.supplyRef)
			// A chip with a catalog support list joins its own pins (chipInstances); this is the SY8368A's wiring.
			if (chip && !(chip.mpn && chipEntry(chip.mpn))) {
				for (const pin of ["IN", "IN_2", "IN_3", "EN"]) if (chip.pins.includes(pin)) join(armInputNet, chip.ref, pin)
				if (chip.pins.includes("LX")) join(`${rail.net}_SW`, chip.ref, "LX")
				if (chip.pins.includes("FB")) join(`${rail.net}_FB`, chip.ref, "FB")
				if (chip.pins.includes("GND_2")) join("GND", chip.ref, "GND_2")
			}
			for (const plug of rail.plugs) {
				const part = parts.find((p) => p.ref === plug.ref)
				if (!part) continue
				const sig = `SERVO_CH${plug.channel}`
				if (!nets.has(sig)) nets.set(sig, [])
				if (pwmArm) join(sig, pwmArm.ref, `LED${plug.channel}`)
				if (part.pins.includes("SIG")) join(sig, part.ref, "SIG")
				if (part.pins.includes("V5")) join(rail.net, part.ref, "V5")
			}
		}
	}
	// The chips with a catalog support list: their own pins on the nets their entry names (chip-support.ts).
	for (const c of chipInstances(s)) for (const j of c.joins) {
		if (!nets.has(j.net)) nets.set(j.net, [])
		join(j.net, j.ref, j.pin)
	}
	const so = armRailList ? null : servoOutputs(parts)
	if (so) {
		for (const n of [SERVO_5V_NET, "SPARE_IN1", "SPARE_IN2", "SERVO_EN", MOTOR_VM_NET, "VBAT", "VBUS"]) if (!nets.has(n)) nets.set(n, [])
		for (const pin of ["A0", "A1", "A2", "A3", "A4", "A5", "OE", "EXTCLK"]) if (so.pwm.pins.includes(pin)) join("GND", so.pwm.ref, pin)
		so.servos.forEach((sv, i) => {
			const net = `SERVO${i + 1}`
			if (!nets.has(net)) nets.set(net, [])
			join(net, so.pwm.ref, `LED${i}`)
			if (sv.pins.includes("SIG")) join(net, sv.ref, "SIG")
			if (sv.pins.includes("V5")) join(SERVO_5V_NET, sv.ref, "V5")
		})
		if (so.supply) {
			if (so.supply.pins.includes("VIN")) join(parts.some((p) => p.role === "battery") ? "VBAT" : "VBUS", so.supply.ref, "VIN")
			// The SY8205 (a chip): both PVIN pins from the cell, LX to its inductor, FB on its divider (supportParts).
			if (so.supply.pins.includes("LX")) {
				for (const n of [SERVO_SW_NET, SERVO_FB_NET]) if (!nets.has(n)) nets.set(n, [])
				for (const pin of ["PVIN", "PVIN_2", "IN", "IN_2", "IN_3"]) if (so.supply.pins.includes(pin)) join(parts.some((p) => p.role === "battery") ? "VBAT" : "VBUS", so.supply.ref, pin)
				join(SERVO_SW_NET, so.supply.ref, "LX")
				if (so.supply.pins.includes("GND_2")) join("GND", so.supply.ref, "GND_2")
				if (so.supply.pins.includes("FB")) join(SERVO_FB_NET, so.supply.ref, "FB")
			}
			if (so.supply.pins.includes("VOUT")) join(SERVO_5V_NET, so.supply.ref, "VOUT")
			if (so.supply.pins.includes("EN")) join(estopPlug(parts) ? MOTOR_VM_NET : "SERVO_EN", so.supply.ref, "EN")
		}
		if (so.spare) {
			join("SPARE_IN1", so.pwm.ref, "LED2")
			join("SPARE_IN2", so.pwm.ref, "LED3")
			if (so.spare.pins.includes("AIN1")) join("SPARE_IN1", so.spare.ref, "AIN1")
			if (so.spare.pins.includes("AIN2")) join("SPARE_IN2", so.spare.ref, "AIN2")
			for (const pin of ["BIN1", "BIN2"]) if (so.spare.pins.includes(pin)) join("GND", so.spare.ref, pin)
		}
	}
	// The power tree (powerTree): the cell, or its 5 V step-down, and VBUS each through a Schottky into VIN_OR.
	const tree = powerTree(s)
	if (tree) {
		for (const n of [VIN_OR_NET, BUCK_NET, packNet(s), "VBUS"]) if (!nets.has(n)) nets.set(n, [])
		if (tree.buck) {
			if (tree.buck.pins.includes("VIN")) join(packNet(s), tree.buck.ref, "VIN")
			if (tree.buck.pins.includes("VOUT")) join(BUCK_NET, tree.buck.ref, "VOUT")
			// The AP63205: EN to VIN (it starts with the pack), FB senses its fixed 5 V output, SW to the inductor
			// (Diodes AP63200/1/3/5 datasheet, Figure 21; its parts in supportParts).
			if (tree.buck.pins.includes("SW") && !(tree.buck.mpn && chipEntry(tree.buck.mpn))) {
				if (!nets.has(BUCK_SW_NET)) nets.set(BUCK_SW_NET, [])
				join(BUCK_SW_NET, tree.buck.ref, "SW")
				if (tree.buck.pins.includes("EN")) join(packNet(s), tree.buck.ref, "EN")
				if (tree.buck.pins.includes("FB")) join(BUCK_NET, tree.buck.ref, "FB")
			}
		}
		const bp = pathPins(tree.battery)
		join(tree.buck ? BUCK_NET : packNet(s), tree.battery.ref, bp.in)
		join(VIN_OR_NET, tree.battery.ref, bp.out)
		// The ideal diode: CE on VOUT blocks reverse current (TI LM66100 datasheet, Pin Functions); ST unused, to GND.
		if (tree.battery.role === "ideal-diode") {
			if (tree.battery.pins.includes("CE")) join(VIN_OR_NET, tree.battery.ref, "CE")
			if (tree.battery.pins.includes("ST")) join("GND", tree.battery.ref, "ST")
		}
		join("VBUS", tree.usb.ref, "A")
		join(VIN_OR_NET, tree.usb.ref, "K")
	}
	// USB-C VBUS feeds the charger when there is one, else the LDO directly. The charger's BAT output, the battery
	// and the LDO input share VBAT. A pack with no charger (charged by its own) feeds the LDO alone: USB and the cell
	// on one input with no power path would short 5 V onto the cell, so USB then carries data only.
	// The contract may choose the source itself (the LDO's nets.VIN: a 2S pack is over its 5.5 V, so USB feeds it).
	const ldoIn = ldoInputNet(s)
	if (ldo) {
		if (hasSupply && ldo.pins.includes("VOUT")) join(supply, ldo.ref, "VOUT")
		// VIN on the input net: the contract's own nets.VIN wires it in the nets loop above, except under a power tree, which
		// owns the LDO's input and which that loop skips (real run 18: U3's nets said VIN_OR, both skipped it, and U3.VIN
		// was left on no net at the revision cap).
		for (const pin of ["VIN", "EN"]) if (ldo.pins.includes(pin) && !(pin === "VIN" && ldo.nets?.VIN && !powerTree(s))) join(ldoIn, ldo.ref, pin)
	}
	if (charger) {
		const chargeLed = parts.find((p) => p.role === "charge-led" && p.pins.includes("A"))
		if (chargeLed && charger.pins.includes("CHRG")) join("VBUS", chargeLed.ref, "A")
		if (charger.pins.includes("VCC")) join("VBUS", charger.ref, "VCC")
		if (charger.pins.includes("BAT")) join("VBAT", charger.ref, "BAT")
	}
	// The battery joins VBAT with or without a charger on the board: a 2S pack charged off the board still feeds the
	// motor driver (before, a board without a charger left the pack's socket unwired and the driver's VM alone on VBAT).
	if (battery?.pins.includes("VBAT")) join("VBAT", battery.ref, "VBAT")
	if (usb) {
		for (const pad of USBC_PADS.GND) join("GND", usb, pad)
		for (const pad of USBC_PADS.VBUS) join("VBUS", usb, pad)
		// D+/D- to the MCU's native USB (its profile's pins: the ESP32-C3's GPIO19/GPIO18, an STM32F103's PA12/PA11),
		// unless the contract uses those pins for something else. A chip without USB gets power only from the port.
		const native = generatedUsb(s)
		if (mcu && native) {
			for (const pad of USBC_PADS.DP) join("USB_DP", usb, pad)
			for (const pad of USBC_PADS.DN) join("USB_DN", usb, pad)
			join("USB_DP", mcu.ref, native.dp)
			join("USB_DN", mcu.ref, native.dm)
		}
	}

	const wake = usbWake(s)
	if (wake?.gpio != null) join(USB_SENSE_NET, wake.mcu.ref, `GPIO${wake.gpio}`)
	// The crystal's lid pads.
	const xtal = boardCrystal(s)
	if (xtal) for (const pin of ["pin2", "pin4"]) join("GND", xtal.ref, pin)
	// A link that carries power: this board's 3V3 out to the peer, or in from it (docs/system.md).
	for (const l of s.values.links ?? []) {
		const k = parts.find((p) => p.ref === l.connector && p.role === "connector")
		if (hasSupply && k?.pins.includes("VCC") && l.supply !== "none") join(supply, k.ref, "VCC")
	}

	// A CAN link's transceiver (links.ts CAN_TRANSCEIVER): RS to GND for high-speed mode, CANH and CANL to the link
	// connector's IO1 and IO2 (its VCC and GND join the rails by label, above).
	const can = parts.find((p) => p.role === "can-transceiver")
	if (can) {
		if (can.pins.includes("RS")) join("GND", can.ref, "RS")
		for (const l of (s.values.links ?? []).filter((x) => x.kind === "can")) {
			const k = parts.find((p) => p.ref === l.connector && p.role === "connector")
			for (const [side, io] of [["CANH", "IO1"], ["CANL", "IO2"]] as const) {
				const net = side === "CANH" ? canSignals(l).h : canSignals(l).l
				if (!nets.has(net)) nets.set(net, [])
				// A bus's segments share the transceiver: its pin joins the net once.
				if (can.pins.includes(side) && !nets.get(net)!.includes(`${can.ref}.${side}`)) join(net, can.ref, side)
				if (k?.pins.includes(io)) join(net, k.ref, io)
			}
		}
	}

	// A motor driver (DRV8833, docs/mechanics.md): motor supply VM from the cell, no current sensing (xISEN to GND),
	// each output pair to its motor's connector.
	// A skid-steer rover (mechanics.drive.kind "skid4") has a second driver for the rear motors (motorDrivers): its
	// channel A follows the left side's inputs and B the right's (skidDriverTraces), its outputs to JM3 and JM4.
	const drivers = motorDrivers(parts)
	if (drivers.length) {
		const vm = motorSupplyNet(parts)
		if (!nets.has(vm)) nets.set(vm, [])
		// The emergency stop's NC contact (its connector, role estop) between the cell and the motors' supply.
		const estop = estopPlug(parts)
		if (estop) { join("VBAT", estop.ref, "VBAT"); join(MOTOR_VM_NET, estop.ref, "VM") }
		const plugs = motorConnectors(parts)
		drivers.forEach((driver, i) => {
			if (driver.pins.includes("VM")) join(vm, driver.ref, "VM")
			for (const pin of ["AISEN", "BISEN"]) if (driver.pins.includes(pin)) join("GND", driver.ref, pin)
			const [ma, mb] = plugs.slice(2 * i, 2 * i + 2)
			const names = i === 0 ? ["A", "B"] : ["C", "D"]
			for (const [k, side, net] of [[ma, "A", names[0]], [mb, "B", names[1]]] as const)
				if (k) for (const n of ["1", "2"] as const) if (driver.pins.includes(`${side}OUT${n}`)) { join(`MOTOR_${net}${n}`, driver.ref, `${side}OUT${n}`); join(`MOTOR_${net}${n}`, k.ref, isEncoderPlug(k) ? `M${n}` : n) }
			// An encoder gearmotor's encoder runs from 3V3 (its outputs then swing to 3.3 V, the MCU's level).
			for (const k of [ma, mb]) if (k && isEncoderPlug(k) && hasSupply) join(supply, k.ref, "VCC")
		})
	}
	// A robot's distance-sensor plug (mechanics.sensor.connector) powers the breakout from the 3V3 rail.
	const plug = parts.find((p) => p.ref === s.values.mechanics?.sensor?.connector && p.role === "connector")
	if (hasSupply && plug?.pins.includes("VCC")) join(supply, plug.ref, "VCC")

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

// The connector pins an I2C link puts on the board's bus, unless a contract pin already wires them there.
// Also a robot's distance-sensor plug (mechanics.sensor.connector): its IO1/IO2 join the bus the same way, in the
// STEMMA QT order. A signal has one contract pin; other parts reach its net through these traces.
export function linkBusTraces(s: ContractSnapshot): { ref: string; pin: string; net: string }[] {
	const { parts = [], pins = [] } = s.values
	const plug = s.values.mechanics?.sensor?.connector
	const buses = [...(s.values.links ?? []).filter((l) => l.kind === "i2c").map((l) => l.connector), ...(plug ? [plug] : [])]
	return buses.flatMap((ref) => {
		const k = parts.find((p) => p.ref === ref && p.role === "connector")
		if (!k) return []
		return ([["IO1", "I2C_SDA"], ["IO2", "I2C_SCL"]] as const)
			.filter(([pin, net]) => k.pins.includes(pin) && pins.some((p) => p.signal === net) && !pins.some((p) => p.signal === net && p.partRef === k.ref && p.partPin === pin))
			.map(([pin, net]) => ({ ref: k.ref, pin, net }))
	})
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

// The bound tscircuit holds a pin capacitor's traces to (maxDecouplingTraceLength), null for none: 5 mm for a part's
// own capacitor (the DRV8833's VINT and VCP), 20 mm for a bare chip's decoupling, none for a crystal's load capacitors.
function capBound(s: ContractSnapshot, sp: Support): number | null {
	if (sp.added && sp.bound !== undefined) return sp.bound
	if (!sp.added || sp.spec.kind !== "capacitor" || sp.near === boardCrystal(s)?.ref || !("ref" in sp.a || "ref" in sp.b)) return null
	return chipProfile((s.values.parts ?? []).find((p) => p.ref === sp.near)) !== null ? 20 : 5
}

// Half the distance between a chip capacitor's two pad centres (tscircuit's footprints).
// 1206: tscircuit's pad centre, measured 26 Nov 2026 (the TMC2209's VS ceramic; without it the check skipped it).
const CAP_TERMINAL_MM: Record<string, number> = { "0402": 0.5, "0603": 0.75, "0805": 0.95, "1206": 1.46 }

// The pin capacitors a placement leaves farther from their pad than tscircuit's bound (capBound), in tscircuit's own
// words: straight from the part's pad to the capacitor's pin 1, which no route can beat. tscircuit decides this before it
// routes and exits; run 21 built six such layouts and a Freerouting pass for it, 13-19 min a failed build, where this
// takes milliseconds (25 Nov 2026). One bound with tscircuit's: a layout this passes must never be refused for reach
// (lead-2, 26 Nov 2026). The margin is this estimate's measured error, on the strict side: on run 21 it gave 17.61/13.53/
// 30.19/15.48 mm where tscircuit said 17.32/13.20/30.04/15.50 (at most 0.02 mm under). Before it was +0.5, which let a
// rover's 5.09 mm through (its IMU's pads were unknown to the check too; ownPadOffset).
export const CAP_REACH_MARGIN_MM = -0.05
// The pin capacitors with a bound whose owner's pad the check can't find (an unknown land pattern): it skips them, so a
// layout it passes could still be refused for them. Empty on every fixture (test/second-driver-caps.test.ts).
export function capsUnchecked(s: ContractSnapshot): string[] {
	const parts = s.values.parts ?? []
	return supportParts(s).flatMap((sp) => {
		if (capBound(s, sp) === null) return []
		return [sp.a, sp.b].flatMap((end) => {
			if (!("ref" in end)) return []
			const part = parts.find((p) => p.ref === end.ref)
			if (!part) return []
			return padOffset(footprintFor(part), part.pins.indexOf(end.pin) + 1, 0) && CAP_TERMINAL_MM[sp.spec.footprint] !== undefined ? [] : [`${sp.ref} on ${part.ref}.${end.pin} (${footprintFor(part)}, ${sp.spec.footprint})`]
		})
	})
}
export function unreachableCaps(s: ContractSnapshot, opts: PlacementOptions = {}): string[] {
	if (opts.routingDisabled) return []
	const placed = layoutBoard(s, opts).parts
	const parts = s.values.parts ?? []
	const out: string[] = []
	for (const sp of supportParts(s)) {
		const bound = capBound(s, sp)
		if (bound === null) continue
		const cap = placed.find((b) => b.ref === sp.ref)
		const t = CAP_TERMINAL_MM[sp.spec.footprint]
		if (!cap || t === undefined) continue
		const r = (cap.rotation * Math.PI) / 180
		// Each end on a part's pin, tscircuit bounds both: pin 1 (the a end) and pin 2 (the b end, a chip's own GND):
		// a rover's IMU capacitor passed on pin 1 and tscircuit refused its pin 2 to U6.GND at 5.01 mm (26 Nov 2026).
		for (const [end, capPin, sign] of [[sp.a, "pin1", -1], [sp.b, "pin2", 1]] as const) {
			if (!("ref" in end)) continue
			const part = parts.find((p) => p.ref === end.ref)
			const box = placed.find((b) => b.ref === part?.ref)
			if (!part || !box || box.rotation % 90 !== 0) continue
			const at = padOffset(footprintFor(part), part.pins.indexOf(end.pin) + 1, box.rotation)
			if (!at) continue
			const pin = { x: (cap.ox ?? cap.x) + sign * t * Math.cos(r), y: (cap.oy ?? cap.y) + sign * t * Math.sin(r) }
			const d = Math.hypot((box.ox ?? box.x) + at.x - pin.x, (box.oy ?? box.y) + at.y - pin.y)
			if (d > bound + CAP_REACH_MARGIN_MM) out.push(`the ${bound}mm maximum length for .${part.ref} > .${end.pin} to .${sp.ref} > .${capPin} cannot be satisfied: its endpoints are ${d.toFixed(2)}mm apart`)
		}
	}
	return out
}
// tscircuit's trace width and copper clearance, and a little margin: drawn traces keep this far from other copper.
const DRAWN_CLEAR_MM = 0.075 + 0.1 + 0.05

export interface CapPath {
	cap: string
	part: string
	pin: string // the part's pin the trace starts from
	points: { x: number; y: number }[] // board frame (the placement's), pad first, the capacitor's terminal last
	local: { x: number; y: number }[] // the corners between, from the part's origin unturned: tscircuit's pcbPath
	lengthMm: number
	boundMm: number
}

// The traces of a capacitor wired between two pins on one side of one part (the DRV8833's VCP-to-VM, and VINT to its
// GND), drawn by the generator instead of left to the router. Each runs straight out along its own pad's row to the
// terminal's column, then to the terminal, so the far end's trace never crosses the near end's. Left to the router, the
// far end's trace took whatever room was left beside the capacitor: on the 60×21 mm rover, I2C and GND traces had taken
// the gap between C3 and C4, and VM's trace detoured through vias, 8.4-11.6 mm against its 5 mm bound, at every layout
// (15 Nov 2026). Drawn, they measured 2.1-4.3 mm in a real build and the router routed the rest around them.
// A part's capacitors are drawn all or none: none when a trace would run back into the part, past its bound, or within
// DRAWN_CLEAR_MM of other copper (another drawn trace, another pad of the part or of its capacitors).
export function capPaths(s: ContractSnapshot, opts: PlacementOptions = {}): CapPath[] {
	return drawnCapPaths(s, new Map(placeParts(s, opts).map((b) => [b.ref, b])))
}

function drawnCapPaths(s: ContractSnapshot, placement: Map<string, Placed>): CapPath[] {
	const parts = s.values.parts ?? []
	type Pt = { x: number; y: number }
	const origin = (b: Placed): Pt => ({ x: b.ox ?? b.x, y: b.oy ?? b.y })
	const both = supportParts(s).filter((sp) => capBound(s, sp) !== null && "ref" in sp.a && "ref" in sp.b && sp.a.ref === sp.b.ref)
	const out: CapPath[] = []
	for (const owner of new Set(both.map((sp) => (sp.a as { ref: string }).ref))) {
		const part = parts.find((p) => p.ref === owner)
		const box = placement.get(owner)
		if (!part || !box || box.rotation % 90 !== 0) continue
		const fp = footprintFor(part)
		const pad = padGeometry(fp)
		const normalOf = (pin: string): Pt | null => {
			const at = padOffset(fp, part.pins.indexOf(pin) + 1, box.rotation)
			return at ? (Math.abs(at.x) >= Math.abs(at.y) ? { x: Math.sign(at.x), y: 0 } : { x: 0, y: Math.sign(at.y) }) : null
		}
		// padOffset gives a dual-row package's lead span (where besidePin measures from); the pad's centre is half its
		// length further out (footprinter's legsoutside): the DRV8833's at 3.93 mm from the middle, not 3.2.
		const padOf = (pin: string): Pt | null => {
			const at = padOffset(fp, part.pins.indexOf(pin) + 1, box.rotation)
			const n = normalOf(pin)
			return at && n ? { x: origin(box).x + at.x + n.x * pad.out, y: origin(box).y + at.y + n.y * pad.out } : null
		}
		const group = both.filter((sp) => (sp.a as { ref: string }).ref === owner)
		const paths: CapPath[] = []
		// Every pad nearby, with the pin or terminal it belongs to: the part's own and its capacitors'.
		const pads: { key: string; at: Pt; hx: number; hy: number }[] = []
		for (const pin of part.pins) {
			const at = padOf(pin)
			const n = normalOf(pin)
			if (at && n) pads.push({ key: `${owner}.${pin}`, at, hx: n.x ? pad.l / 2 : pad.w / 2, hy: n.x ? pad.w / 2 : pad.l / 2 })
		}
		let ok = true
		for (const sp of group) {
			const cap = placement.get(sp.ref)
			const half = CAP_TERMINAL_MM[sp.spec.footprint]
			if (!cap || half === undefined || cap.rotation % 90 !== 0) { ok = false; break }
			const r = (cap.rotation * Math.PI) / 180
			// Pin 1 at -x at rotation 0, turning counter-clockwise with the part.
			const term = (pin: string): Pt => {
				const k = pin === "pin1" ? -1 : 1
				return { x: +(origin(cap).x + k * half * Math.cos(r)).toFixed(3), y: +(origin(cap).y + k * half * Math.sin(r)).toFixed(3) }
			}
			for (const pin of ["pin1", "pin2"]) pads.push({ key: `${sp.ref}.${pin}`, at: term(pin), hx: 0.3, hy: 0.3 })
			const ends = [[sp.a, sp.pins[0]], [sp.b, sp.pins[1]]] as const
			const n0 = normalOf((sp.a as { pin: string }).pin)
			const n1 = normalOf((sp.b as { pin: string }).pin)
			// One side of the part only: a capacitor across it would need a trace round the part.
			if (!n0 || !n1 || n0.x !== n1.x || n0.y !== n1.y) { ok = false; break }
			for (const [end, capPin] of ends) {
				const pin = (end as { pin: string }).pin
				const p = padOf(pin)!
				const n = normalOf(pin)!
				const t = term(capPin)
				const corner = n.x ? { x: t.x, y: p.y } : { x: p.x, y: t.y }
				// Out from the pad, never back over the part.
				if ((corner.x - p.x) * n.x + (corner.y - p.y) * n.y < 0.3) { ok = false; break }
				const points = Math.hypot(corner.x - t.x, corner.y - t.y) < 0.01 ? [p, t] : [p, corner, t]
				const lengthMm = +points.slice(1).reduce((a, q, i) => a + Math.hypot(q.x - points[i].x, q.y - points[i].y), 0).toFixed(2)
				const boundMm = capBound(s, sp)!
				if (lengthMm > boundMm) { ok = false; break }
				// The corner in the part's own frame (origin, unturned): tscircuit reads pcbPath points that way.
				const c = Math.cos((-box.rotation * Math.PI) / 180)
				const sn = Math.sin((-box.rotation * Math.PI) / 180)
				const local = points.slice(1, -1).map((q) => {
					const [dx, dy] = [q.x - origin(box).x, q.y - origin(box).y]
					return { x: +(dx * c - dy * sn).toFixed(2), y: +(dx * sn + dy * c).toFixed(2) }
				})
				paths.push({ cap: sp.ref, part: owner, pin, points, local, lengthMm, boundMm })
			}
			if (!ok) break
		}
		if (!ok) continue
		// Clear of other copper: each trace from every pad but its own two, and from every other drawn trace.
		const segs = paths.flatMap((q) => q.points.slice(1).map((b, i) => ({ q, a: q.points[i], b })))
		const own = (q: CapPath) => [`${owner}.${q.pin}`, `${q.cap}.${group.find((sp) => sp.ref === q.cap)!.pins[(group.find((sp) => sp.ref === q.cap)!.a as { pin: string }).pin === q.pin ? 0 : 1]}`]
		const clash =
			segs.some((sg) => pads.some((pd) => !own(sg.q).includes(pd.key) && segRectGap(sg.a, sg.b, pd) < DRAWN_CLEAR_MM)) ||
			segs.some((s1, i) => segs.some((s2, j) => j > i && s1.q !== s2.q && s1.q.pin !== s2.q.pin && segGap(s1.a, s1.b, s2.a, s2.b) < 0.15 + DRAWN_CLEAR_MM - 0.075))
		if (!clash) out.push(...paths)
	}
	return out
}

// A package's pad: its length and width, and how far its centre is out from padOffset's point (footprinter's defaults:
// TSSOP 1.45 × 0.30 mm, SOIC 1.0 × 0.6 mm, legs outside; a quad package's padOffset is already the pad's centre).
function padGeometry(footprint: string): { l: number; w: number; out: number } {
	const num = (k: string) => {
		const m = new RegExp(`_${k}([\\d.]+)mm`).exec(footprint)
		return m ? Number(m[1]) : undefined
	}
	if (/^tssop/.test(footprint)) return { l: num("pl") ?? 1.45, w: num("pw") ?? 0.3, out: (num("pl") ?? 1.45) / 2 }
	if (/^soic/.test(footprint)) return { l: num("pl") ?? 1.0, w: num("pw") ?? 0.6, out: (num("pl") ?? 1.0) / 2 }
	return { l: 0.9, w: 0.3, out: 0 }
}

// The gap from a segment to a pad (a rectangle, half sizes hx, hy), sampled every 0.02 mm along the segment.
function segRectGap(a: { x: number; y: number }, b: { x: number; y: number }, r: { at: { x: number; y: number }; hx: number; hy: number }): number {
	const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.02))
	let best = Infinity
	for (let i = 0; i <= n; i++) {
		const x = a.x + ((b.x - a.x) * i) / n
		const y = a.y + ((b.y - a.y) * i) / n
		best = Math.min(best, Math.hypot(Math.max(0, Math.abs(x - r.at.x) - r.hx), Math.max(0, Math.abs(y - r.at.y) - r.hy)))
	}
	return best
}

// The gap between two segments' centre lines.
function segGap(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): number {
	const toSeg = (p: { x: number; y: number }, u: { x: number; y: number }, v: { x: number; y: number }) => {
		const L = (v.x - u.x) ** 2 + (v.y - u.y) ** 2
		const k = L === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - u.x) * (v.x - u.x) + (p.y - u.y) * (v.y - u.y)) / L))
		return Math.hypot(p.x - (u.x + k * (v.x - u.x)), p.y - (u.y + k * (v.y - u.y)))
	}
	const o = (p: typeof a, q: typeof a, r: typeof a) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
	if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0
	return Math.min(toSeg(a, c, d), toSeg(b, c, d), toSeg(c, a, b), toSeg(d, a, b))
}

function powerLines(s: ContractSnapshot, placement: Map<string, Placed>, draw = false, unbounded = false): string[] {
	const drawn = draw ? drawnCapPaths(s, placement) : []
	const lines: string[] = []
	const port = (ref: string, pin: string) => `.${ref} > .${pin}`
	for (const sp of supportParts(s)) {
		if (sp.added) {
			const attr = sp.spec.kind === "resistor" ? "resistance" : sp.spec.kind === "inductor" ? "inductance" : "capacitance"
			// A capacitor wired straight to a chip pin (the DRV8833's VINT and VCP): tscircuit would cap the trace at 1 mm,
			// which the placer's 1.5 mm part gap can never meet; 5 mm keeps it at the pin and reaches a ground.
			// A bare MCU's decoupling gets 20 mm: the placer puts each cap beside its own pad (besidePin), but tscircuit's
			// bound also counts the cap's ground return, which on a board without a ground pour routes the long way round
			// (STM32F103: 16.4 mm from the pad-48 cap's GND end, 11 Nov 2026). Without a bound tscircuit applies 1 mm, which
			// no placement meets. The DRV8833's caps keep 5 mm.
			// A crystal's load capacitors are not decoupling: no bound (their crystal pin is no supply pin). capBound.
			// A board placed for Freerouting (routingDisabled): tscircuit still checks the bound and exits 1 on a cap it can't
			// reach (a mock Eurobot, 19 Nov 2026: "5mm maximum length for .U5 > .VINT to .C5 … 56.25mm apart"), so Freerouting
			// was never reached. There the bound is the board's diagonal: the router, not tscircuit, makes the traces.
			const o = s.values.outline
			const bound = unbounded && o ? Math.ceil(Math.hypot(o.widthMm, o.heightMm)) : capBound(s, sp)
			const pinBound = bound !== null ? ` maxDecouplingTraceLength={${bound}}` : ""
			const fpAttr = INDUCTOR_FOOTPRINTS[sp.spec.footprint] ? inductorFootprint(sp.spec.footprint) : q(sp.spec.footprint)
			// A diode (the arm input's TVS) has no value attribute; its pads by number: pad 1 the cathode (the band).
			lines.push(sp.spec.kind === "diode" ? `<diode name=${q(sp.ref)}${at(placement, sp.ref)} footprint=${fpAttr} />` : `<${sp.spec.kind} name=${q(sp.ref)} ${attr}=${q(sp.spec.value)}${at(placement, sp.ref)} footprint=${fpAttr}${pinBound} />`)
		}
		for (const [end, pin] of [[sp.a, sp.pins[0]], [sp.b, sp.pins[1]]] as const) {
			const path = "ref" in end ? drawn.find((d) => d.cap === sp.ref && d.part === end.ref && d.pin === end.pin) : undefined
			const pcbPath = path?.local.length ? ` pcbPath={[${path.local.map((c) => `{ x: ${c.x}, y: ${c.y} }`).join(", ")}]}` : ""
			if ("ref" in end) lines.push(`<trace name=${q(`${end.ref}_${end.pin}_${sp.ref}`)} from=${q(port(end.ref, end.pin))} to=${q(port(sp.ref, pin))}${pcbPath} />`)
			else if (!POWER_NETS.includes(end.net)) lines.push(`<trace name=${q(`${end.net}_${sp.ref}_${pin}`)} from=${q(port(sp.ref, pin))} to=${q(`net.${end.net}`)} />`)
		}
	}
	const widths = netTraceWidths(s)
	for (const [net, ends] of generatedNets(s)) {
		const w = widths.get(net)
		lines.push(`<net name=${q(net)}${w ? ` nominalTraceWidth="${w}mm"` : ""} />`)
		for (const end of ends) {
			const [ref, pin] = end.split(".")
			lines.push(`<trace name=${q(`${net}_${ref}_${pin}`)} from=${q(port(ref, pin))} to=${q(`net.${net}`)} />`)
		}
	}
	// Margins over JLCPCB's 2-layer rules (0.2 mm hole clearance, 0.3 mm copper to edge): tscircuit's defaults left the
	// pours 0.19 mm from the mounting holes and on the edge clearance (the rpi-5 HAT, 15 Nov 2026: 10 KiCad DRC errors).
	// A 4-layer board (space.ts boardLayers): ground on In1, each wide rail on its own region of In2 (planeRegions).
	if (boardLayers(s).layers === 4) {
		lines.push(`<copperpour connectsTo="net.GND" layer="inner1" clearance="${POUR.clearanceMm}mm" padMargin="${POUR.clearanceMm}mm" cutoutMargin="${POUR.clearanceMm}mm" boardEdgeMargin="${POUR.edgeMm}mm" />`)
		for (const r of powerPlaneRegions(s, placement)) lines.push(`<copperpour connectsTo=${q(`net.${r.net}`)} layer="inner2" outline={[${r.outline.map((p) => `{ x: ${p.x}, y: ${p.y} }`).join(", ")}]} clearance="${POUR.clearanceMm}mm" padMargin="${POUR.clearanceMm}mm" cutoutMargin="${POUR.clearanceMm}mm" boardEdgeMargin="${POUR.edgeMm}mm" />`)
	}
	for (const pour of supplyPours(s, unbounded)) lines.push(`<copperpour connectsTo=${q(`net.${pour.net}`)} layer=${q(pour.layer)} clearance="${POUR.clearanceMm}mm" padMargin="${POUR.clearanceMm}mm" cutoutMargin="${POUR.clearanceMm}mm" boardEdgeMargin="${POUR.edgeMm}mm" />`)
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
		const fp = ownFootprint(footprint) ?? q(footprint)
		lines.push(`<chip name=${q(p.ref)}${labelsFor(p, footprint)}${mpnOf(p)}${at(placement, p.ref)} footprint=${fp} />`)
	}

	// The chip's crystal: pin 1 to OSC_IN, pin 3 to OSC_OUT, straight traces (short, no net of their own).
	const xtal = boardCrystal(s)
	if (xtal) {
		lines.push(`<chip name=${q(xtal.ref)} manufacturerPartNumber=${q(xtal.crystal.mpn)}${at(placement, xtal.ref)} footprint=${crystalFootprint()} />`)
		lines.push(`<trace name=${q(`${xtal.ref}_osc_in`)} from=${q(`.${xtal.ref} > .pin1`)} to=${q(`.${xtal.mcuRef} > .${xtal.inPin}`)} />`)
		lines.push(`<trace name=${q(`${xtal.ref}_osc_out`)} from=${q(`.${xtal.ref} > .pin3`)} to=${q(`.${xtal.mcuRef} > .${xtal.outPin}`)} />`)
	}

	for (const c of connectors) {
		const part = parts.find((p) => p.ref === c.ref)
		const footprint = part ? footprintFor(part) : CONNECTOR_FOOTPRINT[c.kind]
		const labels = part ? labelsFor(part, footprint) : ""
		const { x, y } = connectorPosition(c, outline.widthMm, outline.heightMm, footprint)
		lines.push(`<connector name=${q(c.ref)}${labels}${part ? mpnOf(part) : ""} footprint=${q(footprint)} pcbX={${x}} pcbY={${y}} pcbRotation={${edgeRotation(c, footprint)}} />`)
		if (footprint === USBC_FOOTPRINT && opts.usbKeepouts) lines.push(...usbKeepouts(x, y, EDGE_ROTATION[c.edge]))
	}

	for (const pin of pins) {
		if (!mcuRef) throw new Error("circuitFromContract: pin assignments need a part with role mcu")
		lines.push(`<net name=${q(pin.signal)} />`)
		lines.push(`<trace name=${q(`${pin.signal}_mcu`)} from=${q(`.${mcuRef} > .${mcuPinName(parts, pin.gpio)}`)} to=${q(`net.${pin.signal}`)} />`)
		// The USB-C footprint has numbered pads only: a contract pin on it (J1.DP) goes to each pad carrying that signal.
		const pads = partPads(parts.find((p) => p.ref === pin.partRef), pin.partPin)
		for (const pad of pads)
			lines.push(`<trace name=${q(`${pin.signal}_part${pads.length > 1 ? `_${pad}` : ""}`)} from=${q(`.${pin.partRef} > .${pad}`)} to=${q(`net.${pin.signal}`)} />`)
	}

	// A skid-steer rover's rear driver: each input on the signal net of the front driver's channel for its side.
	for (const t of i2cDeviceTraces(s)) lines.push(`<trace name=${q(`${t.net}_${t.ref}_${t.pin}`)} from=${q(`.${t.ref} > .${t.pin}`)} to=${q(`net.${t.net}`)} />`)
	for (const t of skidDriverTraces(s)) lines.push(`<trace name=${q(`${t.net}_${t.ref}_${t.pin}`)} from=${q(`.${t.ref} > .${t.pin}`)} to=${q(`net.${t.net}`)} />`)
	// An I2C link joins the board's own bus: the connector's IO1 and IO2 to I2C_SDA and I2C_SCL (docs/system.md).
	for (const t of linkBusTraces(s)) lines.push(`<trace name=${q(`${t.net}_${t.ref}_${t.pin}`)} from=${q(`.${t.ref} > .${t.pin}`)} to=${q(`net.${t.net}`)} />`)
	lines.push(...powerLines(s, placement, !!opts.drawCaps, !!opts.routingDisabled))
	// Test pads join their net by name: a contract signal's net, or a generated power net (one that reaches two parts).
	const nets = new Set([...pins.map((p) => p.signal), ...generatedNets(s).keys()])
	const bootNet = recoveryBootNet(s)
	const boot = recoveryBootPin(s)
	if (bootNet === RECOVERY_BOOT_NET && boot && recoveryPads(s).placed.length > 0) {
		lines.push(`<net name=${q(bootNet)} />`)
		lines.push(`<trace name=${q(`${bootNet}_mcu`)} from=${q(`.${boot.mcu.ref} > .${boot.pin}`)} to=${q(`net.${bootNet}`)} />`)
		nets.add(bootNet)
	}
	const padOpts = { ...(opts.capsAlong ? { capsAlong: true } : {}), ...(opts.pinPads ? { pinPads: true } : {}) }
	for (const tp of [...testPoints(s, padOpts).placed, ...recoveryPads(s, padOpts).placed, ...bringupPads(s, padOpts).placed].map((t) => ({ ...t, net: nets.has(t.net) ? t.net : netName(t.net) })).filter((t) => nets.has(t.net))) {
		lines.push(`<testpoint name=${q(tp.ref)} footprintVariant="pad" padShape="circle" padDiameter="${TEST_PAD.diameterMm}mm" layer="bottom" pcbX={${tp.x}} pcbY={${tp.y}} />`)
		lines.push(`<trace name=${q(`${tp.net}_${tp.ref}`)} from=${q(`.${tp.ref} > .pin1`)} to=${q(`net.${tp.net}`)} />`)
	}
	for (const h of mountingHoles(s)) lines.push(`<hole pcbX={${h.x}} pcbY={${h.y}} diameter="${h.diameterMm}mm" />`)
	const dp = opts.debugPort === false ? null : debugPort(s, padOpts).placed
	if (dp) {
		const padTags = TC2030.pads.map(([n, x, y]) => `<smtpad portHints={["pin${n}"]} shape="circle" radius="${TC2030.padDiameterMm / 2}mm" pcbX="${x}mm" pcbY="${y}mm" noSolderPaste />`).join("")
		const holeTags = TC2030.holes.map(([x, y]) => `<hole pcbX="${x}mm" pcbY="${y}mm" diameter="${TC2030.holeDiameterMm}mm" />`).join("")
		lines.push(`<chip name="JD1" layer="bottom" pcbX={${dp.x}} pcbY={${dp.y}} pcbRotation={${dp.rotation}} footprint={<footprint>${padTags}${holeTags}</footprint>} />`)
		// No tracks or vias between the pads (the drawing's keep-out): the inner gap, short of the pads' own copper.
		// 0.1 mm short of the copper: tscircuit rejects a keep-out that touches a pad.
		const [kw, kh] = [2 * 1.27 - TC2030.padDiameterMm - 0.2, 2 * 0.635 - TC2030.padDiameterMm - 0.2]
		lines.push(`<keepout shape="rect" pcbX={${dp.x}} pcbY={${dp.y}} width="${+(dp.rotation === 0 ? kw : kh).toFixed(3)}mm" height="${+(dp.rotation === 0 ? kh : kw).toFixed(3)}mm" layers={["bottom"]} />`)
		for (const p of dp.pads) {
			if (!p.end) continue
			if ("net" in p.end) { if (nets.has(p.end.net)) lines.push(`<trace name=${q(`${p.end.net}_JD1_${p.pin}`)} from=${q(`.JD1 > .pin${p.pin}`)} to=${q(`net.${p.end.net}`)} />`) }
			else lines.push(`<trace name=${q(`JD1_${p.pin}_${p.end.ref}`)} from=${q(`.JD1 > .pin${p.pin}`)} to=${q(`.${p.end.ref} > .${p.end.pin}`)} />`)
		}
	}

	return [
		"export default () => (",
		`  <board${boardLayers(s).layers === 4 ? " layers={4}" : ""} width="${outline.widthMm}mm" height="${outline.heightMm}mm" minViaHoleDiameter="0.25mm" minViaPadDiameter="0.45mm"${opts.routingDisabled ? " routingDisabled" : ""}>`,
		...lines.map((l) => `    ${l}`),
		"  </board>",
		")",
		"",
	].join("\n")
}
