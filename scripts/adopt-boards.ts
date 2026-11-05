// Regenerates src/adopt/boards.json: the pin names of common ESP32 dev boards (D0, TX, SDA, A0 …) and the GPIO each
// one is, read from arduino-esp32's variant headers at a pinned commit, which is what firmware compiles against.
// Run: npx tsx scripts/adopt-boards.ts [commit]
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const COMMIT = process.argv[2] ?? "5ccdc7b123f8baa5b717fe279c5f778cfb84a322"
// ArduinoCore-avr, for AVR chips and the Arduino boards built on them.
const AVR_COMMIT = process.argv[3] ?? "11b9130371e8447920edb65a75706a6c951e51fc"

// Variant → how a KiCad footprint names that board (value or library id). Only variants whose header maps a name
// straight to a GPIO; the Arduino Nano ESP32 renumbers pins in its core and is left out.
const BOARDS: { variant: string; footprint: string }[] = [
	{ variant: "XIAO_ESP32C3", footprint: "xiao.{0,12}esp32.?c3|113991054" },
	{ variant: "XIAO_ESP32C5", footprint: "xiao.{0,12}esp32.?c5" },
	{ variant: "XIAO_ESP32C6", footprint: "xiao.{0,12}esp32.?c6|113991254" },
	{ variant: "XIAO_ESP32S3", footprint: "xiao.{0,12}esp32.?s3|113991114" },
	{ variant: "adafruit_feather_esp32_v2", footprint: "feather.{0,12}esp32.?v2" },
	{ variant: "adafruit_qtpy_esp32s3_nopsram", footprint: "qt.?py.{0,12}esp32.?s3" },
	{ variant: "lolin_s2_mini", footprint: "s2.?mini" },
]

// AVR variant → the chips it is for (a footprint's value or library id), and the Arduino boards whose pads carry
// Arduino pin names (D13, A0). Each Arduino pin number is a port and bit, in the order the core's tables give.
const AVR: { variant: string; chip: string; board: string }[] = [
	{ variant: "standard", chip: "atmega(328|168|88|48|8)(p|pb|a)?\\b", board: "arduino.?(nano|uno|pro.?mini)(?!.?(every|esp32|33|rp2040|matter|r4))" },
	{ variant: "mega", chip: "atmega(2560|1280|640)", board: "arduino.?mega" },
	{ variant: "leonardo", chip: "atmega(32|16)u4", board: "arduino.?(leonardo|micro)|pro.?micro" },
]

const out: {
	source: string
	boards: { variant: string; footprint: string; pins: Record<string, number> }[]
	avrSource: string
	avr: { variant: string; chip: string; board: string; digital: string[]; a0: number; pins: Record<string, number> }[]
} = {
	source: `https://github.com/espressif/arduino-esp32/tree/${COMMIT}/variants`,
	boards: [],
	avrSource: `https://github.com/arduino/ArduinoCore-avr/tree/${AVR_COMMIT}/variants`,
	avr: [],
}
for (const b of BOARDS) {
	const url = `https://raw.githubusercontent.com/espressif/arduino-esp32/${COMMIT}/variants/${b.variant}/pins_arduino.h`
	const res = await fetch(url)
	if (!res.ok) throw new Error(`${url}: ${res.status}`)
	const pins: Record<string, number> = {}
	for (const m of (await res.text()).matchAll(/^\s*(?:static\s+const(?:expr)?\s+uint8_t\s+(\w+)\s*=\s*(\d+)\s*;|#define\s+(\w+)\s+(\d+)\s*(?:\/\/.*)?$)/gm)) {
		const name = m[1] ?? m[3]
		// Board pin names only: D0, A0, TX, SDA, LED_BUILTIN, BOOT_PIN …; not counts or flags.
		if (/^(D\d+|A\d+|TX|RX|SDA|SCL|SCK|MISO|MOSI|SS|LED_BUILTIN|BUILTIN_LED|BOOT_PIN|BUTTON|NEOPIXEL\w*|PIN_\w+)$/.test(name)) pins[name] = Number(m[2] ?? m[4])
	}
	out.boards.push({ ...b, pins })
	console.log(`${b.variant}: ${Object.keys(pins).length} pins`)
}
for (const a of AVR) {
	const url = `https://raw.githubusercontent.com/arduino/ArduinoCore-avr/${AVR_COMMIT}/variants/${a.variant}/pins_arduino.h`
	const res = await fetch(url)
	if (!res.ok) throw new Error(`${url}: ${res.status}`)
	const text = (await res.text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
	const array = (name: string) => new RegExp(`\\b${name}\\s*\\[\\]\\s*=\\s*\\{([^}]*)\\}`).exec(text)?.[1] ?? ""
	const ports = [...array("digital_pin_to_port_PGM").matchAll(/\bP([A-L])\b|NOT_A_PORT/g)].map((m) => m[1] ?? null)
	const bits = [...array("digital_pin_to_bit_mask_PGM").matchAll(/_BV\s*\(\s*(\d+)\s*\)|NOT_A_PIN/g)].map((m) => (m[1] === undefined ? null : Number(m[1])))
	if (!ports.length || ports.length !== bits.length) throw new Error(`${a.variant}: ${ports.length} ports, ${bits.length} bits`)
	const digital = ports.map((p, i) => (p && bits[i] !== null ? `P${p}${bits[i]}` : ""))
	const a0 = Number(/#define\s+PIN_A0\s+\(?(\d+)/.exec(text)?.[1])
	const pins: Record<string, number> = {}
	for (const m of text.matchAll(/^\s*(?:#define\s+(LED_BUILTIN\w*|PIN_SPI_\w+|PIN_WIRE_\w+)\s+\(?(\d+)\)?|static\s+const\s+uint8_t\s+(SS|MOSI|MISO|SCK|SDA|SCL)\s*=\s*(\d+)\s*;)/gm)) pins[m[1] ?? m[3]] = Number(m[2] ?? m[4])
	out.avr.push({ ...a, digital, a0, pins })
	console.log(`avr ${a.variant}: ${digital.length} digital pins, A0 = ${a0}`)
}
writeFileSync(join(import.meta.dirname, "..", "src", "adopt", "boards.json"), `${JSON.stringify(out, null, "\t")}\n`)
