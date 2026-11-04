// Checks a firmware variant's pins against a board's MCU: the cross-domain check, on someone else's files.
import type { Board, Footprint } from "./pcb.ts"
import { netMembers } from "./pcb.ts"
import type { FirmwarePin, FirmwareVariant } from "./firmware.ts"
import { active, familyOfPart } from "./preproc.ts"

const MCU = /ESP32|ESP8266|RP2040|RP2350|PICO|STM32|NRF5|ATMEGA|ATTINY|SAMD|SAM[DE]\d|CH32|GD32/i

// ESP32 pins whose names don't carry the GPIO number.
const ESP32_ALIASES: Record<string, number> = {
	SVP: 36, SENSOR_VP: 36, SENSOR_CAPP: 37, SENSOR_CAPN: 38, SVN: 39, SENSOR_VN: 39,
	TXD0: 1, U0TXD: 1, RXD0: 3, U0RXD: 3, MTDI: 12, MTCK: 13, MTMS: 14, MTDO: 15,
}

// The GPIO a pad is, from its pin name (IO26, GPIO28_ADC2, IO36/SVP) or, failing that, its unconnected-net name
// (KiCad writes unconnected-(U1-GPIO6-Pad9)).
export function padGpio(fn: string, net: string): number | null {
	const fromName = (s: string): number | null => {
		for (const tok of s.split(/[\/_\s,()-]+/)) {
			const m = /^(?:GPIO|IO|GP)(\d+)$/i.exec(tok)
			if (m) return Number(m[1])
		}
		for (const tok of s.split(/[\/\s,()-]+/)) if (tok.toUpperCase() in ESP32_ALIASES) return ESP32_ALIASES[tok.toUpperCase()]
		return null
	}
	const u = /^unconnected-\([^-]+-(.+)-Pad[^)]*\)$/.exec(net)
	return fromName(fn) ?? (u ? fromName(u[1]) : null)
}

// The parts that are MCUs: whatever has the most GPIO-named pads (modules are named anything, e.g. T-Micro32_Plus);
// a known chip name only breaks ties.
export function findMcus(b: Board): Footprint[] {
	const gpioPads = (f: Footprint) => f.pads.filter((p) => padGpio(p.fn, p.net) !== null).length
	return b.footprints
		.filter((f) => gpioPads(f) >= 6)
		.sort((a, b) => gpioPads(b) - gpioPads(a) || Number(MCU.test(`${b.value} ${b.lib}`)) - Number(MCU.test(`${a.value} ${a.lib}`)))
}

// Rails: GND, VCC, +3V3, 3V3_BUS2, 12V... A rail name with a control word after it (12V_EN, 3V3_SENSE) is a signal.
const POWER = /^(GND\w*|AGND|DGND|PGND|VCC|VDD|VSS|VBUS\d*|VSYS|VBAT|VIN|\+?\d+V\d*(_\w+)?)$/i
const CONTROL = /_(EN|ENABLE|SENSE|SNS|FEED|CTRL|CTL|DET|DETECT|MON|PG|PGOOD|OK|FB|ON|OFF|SW|SEL|FAULT|ALERT)$/i

export type Verdict =
	// The firmware drives a GPIO whose pad goes nowhere.
	| "unconnected"
	// The pad is on a power or ground net.
	| "power"
	// No pad on this part is that GPIO (maybe inside a module, like the Pico's LED on GPIO25).
	| "not-on-pads"
	// Both sides have names and they share nothing.
	| "name-differs"
	// The net has no name (Net-(R5-Pad1)); shown with what it connects to.
	| "unnamed"
	| "agrees"
	// Wired inside a module (the Pico's LED on GPIO25) for what the firmware's name says: nothing to check here.
	| "inside-module"
	// A per-revision pin whose sibling (X_REV21 for X_REV20) fits this board.
	| "other-revision"
	// The module already uses this GPIO for something else (T-Display's GPIO5 is its display's CS).
	| "module-conflict"

export interface PinCheck {
	pin: FirmwarePin
	// The MCU the pin was checked on.
	mcu: string
	verdict: Verdict
	net: string
	pad: string
	// For unnamed nets: the other parts on the net.
	reaches: string[]
	// Set when the name had several #if definitions in its file; this is the best-fitting one.
	branches?: number
}

// Words that mean the same signal.
const SYNONYMS: string[][] = [
	["sck", "sclk", "clk", "clock", "scl", "bclk", "sclk"],
	["ws", "lrclk", "lrck", "fs"],
	["mic", "microphone"],
	["bat", "batt", "battery", "vbat"],
	["chg", "charge", "chrg", "charging"],
	["buzzer", "buzz", "bz", "beeper", "piezo"],
	["cs", "csn", "ss", "nss", "sel"],
	["mosi", "sdo", "sdi", "copi", "dout", "din", "data", "dat", "do", "di", "sda", "dio", "sd"],
	["miso", "cipo"],
	["led", "leds", "neopixel", "ws2812", "rgb", "pixel"],
	["bl", "backlight", "blk", "lcd_bl"],
	["rst", "reset", "res", "nrst"],
	["dc", "rs", "cmd"],
	["tx", "txd"],
	["dp", "usbdp", "usb_dp"],
	["dm", "dn", "usbdm"],
	["rx", "rxd"],
	["btn", "button", "sw", "key"],
	["int", "irq", "intr"],
]
const CANON = new Map<string, string>()
for (const group of SYNONYMS) for (const w of group) CANON.set(w, group[0])

// Phase names of motor drivers and the like: they agree only with themselves, so they are kept whole.
const NOISE = new Set(["pin", "gpio", "io", "num", "net", "pad", "n", "p", "the"])

export function tokens(name: string): Set<string> {
	const last = name.split("/").filter(Boolean).pop() ?? name
	const out = new Set<string>()
	// camelCase and the k prefix of C++ constants: kRelayHeaterPin → relay, heater.
	const plain = last
		.replace(/~\{([^}]*)\}/g, "$1")
		.replace(/D\+/gi, "_DP")
		.replace(/D-(?=$|[_\s])/gi, "_DM")
		.replace(/^k(?=[A-Z])/, "")
		.replace(/([a-z])([A-Z])/g, "$1_$2")
	for (const raw of plain.split(/[_\-\s.{}()+]+/)) {
		const t = raw.toLowerCase().replace(/\d+$/, "")
		if (!t || NOISE.has(t)) continue
		out.add(CANON.get(t) ?? t)
	}
	return out
}

// Words that name a signal's function on its bus. When both names carry one, they must share it: LCD_RST on the
// LCD_DC net is a swap, however much else ("lcd") the names share.
const FUNCTION = new Set(["sck", "ws", "cs", "mosi", "miso", "rst", "dc", "tx", "rx", "dp", "dm", "int", "bl"])

export function namesAgree(firmwareName: string, net: string): boolean {
	const a = tokens(firmwareName)
	const b = tokens(net)
	const fa = [...a].filter((t) => FUNCTION.has(t))
	const fb = [...b].filter((t) => FUNCTION.has(t))
	if (fa.length && fb.length && !fa.some((t) => fb.includes(t))) return false
	for (const t of a) if (b.has(t)) return true
	// Abbreviations: "strain" vs "STRAIN_DOUT" share a word; "mt" vs "MAG" don't. Prefixes of 3+ letters count.
	for (const x of a) for (const y of b) if (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x))) return true
	return false
}

// A net with no name, or named only after the GPIO it is on (GPIO19, ESP_GPIO13, IO5): says nothing about its use.
const unnamedNet = (net: string) => /^Net-\(|^\/?N\$|^N-\d|^Net\d/.test(net) || /^(?:[A-Z0-9]+_)?(?:GPIO|IO|GP)\d+$/i.test(net.split("/").pop()!)

// What a part is, from its reference and value, as words a firmware name might use.
function partRole(f: Footprint | undefined): string[] {
	if (!f) return []
	const t = `${f.value} ${f.lib}`
	const out: string[] = []
	if (/^(SW|S|BTN|KEY)\d/i.test(f.ref) || /button|switch|tact/i.test(t)) out.push("button")
	if (/^(LED|D)\d/i.test(f.ref) && /led|ws2812|sk6812|apa102/i.test(t)) out.push("led")
	if (/^(BZ|BUZ|LS)\d/i.test(f.ref) || /buzzer|piezo/i.test(t)) out.push("buzzer")
	if (/^MK\d/i.test(f.ref) || /mic/i.test(t)) out.push("mic")
	return out
}

// GPIOs a module wires up inside itself, so no pad carries them.
const MODULE_INTERNAL: { part: RegExp; gpios: Record<number, string> }[] = [
	{ part: /t-?display/i, gpios: { 0: "the module's left button", 35: "the module's right button", 4: "the module's display backlight", 5: "the module's display (CS)", 16: "the module's display (DC)", 18: "the module's display (SCLK)", 19: "the module's display (MOSI)", 23: "the module's display (RST)", 14: "the module's battery-sense enable", 34: "the module's battery sense" } },
	{ part: /pico/i, gpios: { 23: "the module's SMPS mode pin", 24: "the module's VBUS sense", 25: "the module's on-board LED", 29: "the module's VSYS/3 divider" } },
]

const connected = (net: string) => !!net && !net.startsWith("unconnected-")
const RANK: Verdict[] = ["agrees", "inside-module", "other-revision", "unnamed", "name-differs", "not-on-pads", "module-conflict", "power", "unconnected"]

// Each firmware pin against every MCU on the board, keeping the best fit: one binary often serves several chips by
// role (DeskHop's two Picos). That can hide a pin that is wrong for its own chip but right for another; the report
// says which MCU each pin landed on so a person can see it.
export function checkVariant(b: Board, mcus: Footprint[], v: FirmwareVariant): PinCheck[] {
	const members = netMembers(b)
	const byRef = new Map(b.footprints.map((f) => [f.ref, f]))
	const one = (mcu: Footprint, pin: FirmwarePin): PinCheck => {
		let at: { pad: string; net: string } | undefined
		for (const p of mcu.pads)
			if (padGpio(p.fn, p.net) === pin.gpio && (!at || (!connected(at.net) && connected(p.net)))) at = { pad: p.number, net: p.net }
		if (!at) {
			const inside = MODULE_INTERNAL.find((m) => m.part.test(`${mcu.value} ${mcu.lib}`))?.gpios[pin.gpio]
			const verdict: Verdict = !inside ? "not-on-pads" : namesAgree(pin.name, inside) ? "inside-module" : "module-conflict"
			return { pin, mcu: mcu.ref, verdict, net: inside ?? "", pad: "", reaches: [] }
		}
		const { pad } = at
		let net = at.net
		const others = (n: string) => (members.get(n) ?? []).filter((m) => m.ref !== mcu.ref)
		let reaches = others(net).map((m) => `${m.ref}.${m.fn || m.pad}`)
		// A series resistor between the pin and the signal (cloudSmoker's R10 into DISP_DC, tRacket's R3 to its LED):
		// look one hop on. The far net names the signal if it has a name; its parts are evidence either way.
		let farParts: { ref: string; pad: string; fn: string }[] = []
		if (connected(net) && unnamedNet(net)) {
			const r = others(net).find((m) => /^R\d/.test(m.ref) && byRef.get(m.ref)?.pads.length === 2)
			const far = r && byRef.get(r.ref)!.pads.find((p) => p.number !== r.pad)?.net
			if (r && far && connected(far) && !POWER.test(far.split("/").pop()!)) {
				farParts = others(far).filter((m) => m.ref !== r.ref)
				if (!unnamedNet(far)) {
					net = `${at.net} → ${r.ref} → ${far}`
					reaches = farParts.map((m) => `${m.ref}.${m.fn || m.pad}`)
				}
			}
		}
		const named = net.split(" → ").pop()!
		const leaf = named.split("/").pop()!
		// A GPIO on a rail is wrong unless the firmware says it is that rail (PIN_3V3_FUSED senses /3V3_FUSED).
		const rail = POWER.test(leaf) && !CONTROL.test(leaf)
		// Evidence beyond the net's name: the far-end pins (MK1.BCLK) and what the parts are (SW1 is a button).
		const evidence = [named, ...reaches.map((x) => x.split(".").slice(1).join(".")), ...[...others(at.net), ...farParts].flatMap((m) => partRole(byRef.get(m.ref)))]
		const agrees = evidence.some((e) => e && !/^\d+$/.test(e) && namesAgree(pin.name, e))
		const verdict: Verdict = !connected(at.net) || reaches.length === 0 ? "unconnected" : agrees ? "agrees" : unnamedNet(named) ? "unnamed" : rail ? "power" : "name-differs"
		return { pin, mcu: mcu.ref, verdict, net, pad, reaches }
	}
	const best = (pin: FirmwarePin) => mcus.map((m) => one(m, pin)).sort((a, b) => RANK.indexOf(a.verdict) - RANK.indexOf(b.verdict))[0]
	// Only the definitions this build compiles: #if branches evaluated against the env's -D flags and chip family
	// (from the env's platform, or the board's MCU for a bare source tree). Unknown outcomes stay, marked conditional.
	const ctx = { defines: v.defines ?? new Map<string, string>(), selectors: v.selectors, family: v.family ?? familyOfPart(mcus.map((m) => `${m.value} ${m.lib}`).join(" ")) }
	const compiled: FirmwarePin[] = []
	for (const pin of v.pins) {
		const on = pin.conds ? active(pin.conds, ctx) : true
		if (on !== false) compiled.push(on === undefined ? { ...pin, conditional: true } : pin)
	}
	// One name defined several times in one file is #if branches adopt couldn't decide: keep the branch that fits.
	const groups = new Map<string, FirmwarePin[]>()
	for (const pin of compiled) {
		const k = `${pin.file}\0${pin.name}`
		groups.set(k, [...(groups.get(k) ?? []), pin])
	}
	const checks = [...groups.values()].map((pins) => {
		const c = pins.map(best).sort((a, b) => RANK.indexOf(a.verdict) - RANK.indexOf(b.verdict))[0]
		return pins.length > 1 ? { ...c, branches: pins.length } : c
	})
	// Pins kept per board revision (CHG_STAT_REV20 / CHG_STAT_REV21, picked at runtime): when a sibling fits this
	// board, a broken one is the other revision's, not a fault.
	const REV = /_(?:REV|R|V|VER)_?\d+[A-Z]?$/i
	const stem = (n: string) => n.replace(REV, "")
	return checks.map((c) => {
		if (!REV.test(c.pin.name) || RANK.indexOf(c.verdict) < RANK.indexOf("not-on-pads")) return c
		const sibling = checks.find((o) => o !== c && REV.test(o.pin.name) && stem(o.pin.name) === stem(c.pin.name) && o.verdict === "agrees")
		return sibling ? { ...c, verdict: "other-revision" as const, net: `${c.net} (${sibling.pin.name} fits this board)` } : c
	})
}

// How well a variant fits a board, summed so the firmware that explains the most of the board wins (an average let a
// six-pin display config beat the board's own program). Agreements count for it, broken wiring against it; unused
// pins don't count either way.
export function fitScore(checks: PinCheck[]): number {
	let s = 0
	for (const c of checks) {
		if (c.pin.unused) continue
		s += c.verdict === "agrees" ? 2 : c.verdict === "inside-module" || c.verdict === "other-revision" ? 1 : c.verdict === "unnamed" || c.verdict === "name-differs" ? 0.5 : c.verdict === "not-on-pads" ? -0.5 : -2
	}
	return s
}
