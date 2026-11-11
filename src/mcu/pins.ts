import { mcuProfileOf, type McuProfile } from "./profile.ts"

// One pin identity across vendors (docs/mcu.md, Pin index). The contract stores pins[].gpio as an index whose meaning
// the chip's profile defines: GPIO n on ESP32 and RP2040, port×16+n on STM32 (PA5 = 5, PB3 = 19, PC13 = 45), port×32+n
// on nRF (P1.04 = 36). Everything that spells a pin asks here, so a board, a firmware header and a check agree.

const PORTS = "ABCDEFGHIJK"

// The chip's name for a pin index. Without a profile: GPIO<n>, what every contract before profiles meant.
export function pinName(profile: McuProfile | null | undefined, index: number): string {
	const pin = profile?.pins.find((p) => p.index === index)
	if (pin) return pin.name
	if (!profile) return `GPIO${index}`
	return fallbackName(profile, index)
}

// A pin the profile doesn't list (a contract asking for one the package lacks) still gets a readable name in errors.
function fallbackName(profile: McuProfile, index: number): string {
	if (profile.vendor === "st") return `P${PORTS[Math.floor(index / 16)] ?? "?"}${index % 16}`
	if (profile.vendor === "nordic") return `P${Math.floor(index / 32)}.${String(index % 32).padStart(2, "0")}`
	if (profile.vendor === "raspberrypi") return `GPIO${index}`
	return `GPIO${index}`
}

// Any vendor's spelling → the index: PA5, GPIO5, IO5, GP5, P0.13 / P1.04. With a profile, only pins it lists.
export function pinIndex(profile: McuProfile | null | undefined, name: string): number | null {
	const n = name.trim().toUpperCase()
	let index: number | null = null
	let m: RegExpExecArray | null
	if ((m = /^P([A-K])(\d{1,2})$/.exec(n))) index = PORTS.indexOf(m[1]) * 16 + Number(m[2])
	else if ((m = /^P(\d)\.(\d{1,2})$/.exec(n))) index = Number(m[1]) * 32 + Number(m[2])
	else if ((m = /^(?:GPIO|IO|GP|D)(\d{1,3})$/.exec(n))) index = Number(m[1])
	if (index === null) return null
	if (!profile) return index
	return profile.pins.some((p) => p.index === index) ? index : null
}

// Reservations a design can never take. strap and usb pins are usable with care (the ESP32-C3's I2C on its GPIO8/9
// straps, USB D+/D- wired to the USB-C connector); the checks and the solver handle those.
export const HARD_RESERVED = new Set(["swd", "reset", "console", "osc", "flash", "rf"])

// The design's MCU pin name for an index: the profile of its role "mcu" part spells it (GPIO4, PA5, P0.13).
export function mcuPinName(parts: readonly { role: string; mpn: string }[] | undefined, index: number): string {
	return pinName(mcuProfileOf(parts), index)
}

// Why a design can't use this pin index on this chip, or null if it can.
export function mcuPinError(profile: McuProfile | null | undefined, index: number): string | null {
	if (!profile) return null
	const pin = profile.pins.find((p) => p.index === index)
	if (!pin) return `${profile.mpn} has no pin with index ${index} (${fallbackName(profile, index)})`
	if (pin.reserved && HARD_RESERVED.has(pin.reserved)) return `${pin.name} is reserved (${pin.reserved}) on the ${profile.mpn}`
	return null
}
