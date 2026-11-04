// Regenerates src/adopt/boards.json: the pin names of common ESP32 dev boards (D0, TX, SDA, A0 …) and the GPIO each
// one is, read from arduino-esp32's variant headers at a pinned commit, which is what firmware compiles against.
// Run: npx tsx scripts/adopt-boards.ts [commit]
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const COMMIT = process.argv[2] ?? "5ccdc7b123f8baa5b717fe279c5f778cfb84a322"

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

const out: { source: string; boards: { variant: string; footprint: string; pins: Record<string, number> }[] } = {
	source: `https://github.com/espressif/arduino-esp32/tree/${COMMIT}/variants`,
	boards: [],
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
writeFileSync(join(import.meta.dirname, "..", "src", "adopt", "boards.json"), `${JSON.stringify(out, null, "\t")}\n`)
