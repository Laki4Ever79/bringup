import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// MCU profiles (docs/mcu.md): every chip-specific fact the pipeline uses, one JSON file per orderable chip or module in
// catalog/mcu/. STM32 profiles are generated from ST's STM32_open_pin_data (BSD-3-Clause) by scripts/mcu/import-stm32.ts
// and merged with a curated overlay (currents, firmware, simulator, support parts, each with its source); the others
// are written by hand from their datasheets. Code reads chips through here, never through constants.

export type Vendor = "espressif" | "st" | "raspberrypi" | "nordic"
export type PeriphKind = "uart" | "i2c" | "spi" | "i2s" | "adc" | "usb" | "can" | "radio"
export const PERIPH_KINDS: readonly PeriphKind[] = ["uart", "i2c", "spi", "i2s", "adc", "usb", "can", "radio"]
export type Arch = "esp32" | "stm32" | "rp2040" | "nrf52"

// A pin a design can wire to: its name in the vendor's spelling, the index the contract stores (pins[].gpio), the
// package pads it sits on, and every signal it can carry (ST's names: I2C1_SDA, USART2_TX, ADC1_IN5…; "*" means any
// signal through a GPIO matrix, as on the ESP32). reserved names why a design may not take it (swd, reset, boot,
// strap, usb, console, osc, flash).
export interface McuPin {
	name: string
	index: number
	pads: string[]
	signals: string[]
	wake?: boolean
	reserved?: string
}

// The support part kinds (codegen/circuit.ts SUPPORT): decouple 100 nF, bypass 1 µF, bulk 10 µF, pulldown 100k, pullup
// 10k, bootPulldown 10k to GND.
export type SupportSpec = "decouple" | "bypass" | "bulk" | "pulldown" | "pullup" | "bootPulldown" | "usbPullup"

export interface McuProfile {
	id: string
	vendor: Vendor
	family: string
	mpn: string
	lcsc: string | null
	kind: "module" | "chip"
	package: { name: string; footprint: string; bodyMm: { w: number; h: number }; extentMm: { w: number; h: number }; ringMm?: number }
	board: { supported: boolean; reason?: string }
	core: string
	mhz: number
	flashKb: number
	ramKb: number
	voltage: { min: number; max: number }
	pins: McuPin[]
	// Pads that are not design pins, by net: supply, ground, reset, boot, and the pins reserved above are listed in pins.
	power: { name: string; net: "supply" | "ground" | "analog" | "reset" | "boot" | "vbat" | "usb" | "nc" | "other"; pads: string[] }[]
	peripherals: Record<PeriphKind, string[]>
	// The console the firmware logs on (and the simulator reads), on fixed pins.
	console: { instance: string; tx: string; rx: string } | null
	programming: { method: "swd" | "usb-serial-jtag" | "usb-dfu" | "uf2"; pins: string[] }
	// The pin that selects the ROM bootloader at reset, the level that selects it, and (ESP32-C3) the second strap
	// download boot needs. null on chips that boot from flash by an option bit (STM32G0 nBOOT0).
	boot: { pin: string | null; level: "low" | "high" | null; download?: { pin: string; level: "high" | "low" } }
	usb: { dp: string; dm: string; pullupOnDp?: boolean } | null
	// Parts every board with this chip needs, besides what the design asks for. a/b: "pad:<n>", "pin:<name>" or "net:<name>".
	support: { job: string; spec: SupportSpec; a: string; b: string }[]
	currents: { sleepUa: number; cpuMa: number; radioMa?: number; bleTxMa?: number; bleRxMa?: number; wifiTxMa?: number; supplyMinMa: number; source: string }
	firmware: {
		platform: string
		board: string
		framework: "arduino"
		arch: Arch
		// How pins.h spells a pin: "number" (#define PIN_X 4) or "name" (#define PIN_X PA5, the core's own macros).
		pinStyle: "number" | "name"
		flags?: string[]
		libs?: string[]
		budget?: { flashBytes: number; ramBytes: number; source: string }
		zephyrBoard?: string
		// The PlatformIO env name the product firmware builds under (purposes add _test, _collect…); default: the id.
		env?: string
		// Where the reading history lives and how big it may grow: a LittleFS partition (ESP32, RP2040, nRF52) or the
		// core's EEPROM emulation in the last flash pages (STM32).
		history?: { store: "littlefs" | "eeprom"; bytes: number; source: string }
	}
	sim: { backend: "qemu" | "renode" | null; machine?: string; consoleUart?: string; models: string[]; note?: string }
	radio: ("ble" | "wifi" | "802.15.4")[]
	// A crystal the board must carry (USB on the F103, the WB55's radio, the RP2040), or null to run on the internal oscillator.
	// crystal: the part the board carries, on pads[0] (OSC_IN) and pads[1] (OSC_OUT); loadPf its load capacitance.
	// loadCap: the two load capacitors, one from each crystal pin to GND. No crystal: the board places none.
	clock?: {
		hseMhz: number
		why: string
		pads: [string, string]
		crystal?: { mpn: string; lcsc: string; loadPf: number; footprint: "smd3225_4p" }
		loadCap?: { value: string; mpn: string; lcsc: string }
	} | null
	// Every GPIO wakes the chip from the sleep the firmware uses (STM32 Stop mode: any EXTI line), not only pins marked wake.
	wakeAny?: boolean
	// Pins tried first, in order (the ESP32-C3's link pins, docs/system.md); the rest follow by index.
	preferred?: number[]
	priceUsd?: { qty: number; usd: number; source: string }
	fccId?: string
	sources: string[]
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const cache = new Map<string, McuProfile[]>()

export function loadProfiles(root: string = ROOT): McuProfile[] {
	const hit = cache.get(root)
	if (hit) return hit
	const dir = join(root, "catalog/mcu")
	const out = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as McuProfile)
	cache.set(root, out)
	return out
}

export function profileById(id: string): McuProfile | null {
	return loadProfiles().find((p) => p.id === id) ?? null
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")

// A part's profile by its MPN. Exact match first, then a profile MPN the part's starts with (ESP32-C3-MINI-1-N4).
export function profileForPart(p: { mpn: string }): McuProfile | null {
	const m = norm(p.mpn ?? "")
	if (!m) return null
	const all = loadProfiles()
	return all.find((x) => norm(x.mpn) === m) ?? all.find((x) => m.startsWith(norm(x.mpn))) ?? null
}

// The design's MCU: the first part with role "mcu" (a board has one), and its profile.
export function mcuProfileOf(parts: readonly { role: string; mpn: string }[] | undefined): McuProfile | null {
	const mcu = (parts ?? []).find((p) => p.role === "mcu")
	return mcu ? profileForPart(mcu) : null
}

// The ESP32-C3-MINI-1: the profile every contract made before profiles existed was built on.
export const LEGACY_MCU_ID = "esp32-c3-mini-1"
