// One number per MCU pin, across chip families: an ESP32/RP2040 GPIO is its own number; an STM32 port pin (PC13) is
// 1000 + port × 16 + pin, so it never collides with a GPIO number and still sorts and compares as one.
export const STM32_BASE = 1000

export function portPin(port: string, n: number): number {
	return STM32_BASE + (port.toUpperCase().charCodeAt(0) - 65) * 16 + n
}

// PA5, PC13 (also PC13-TAMPER-RTC's first part): an STM32-style port pin, or null.
export function parsePortPin(tok: string): number | null {
	const m = /^P([A-L])(\d{1,2})$/i.exec(tok)
	return m && Number(m[2]) < 16 ? portPin(m[1], Number(m[2])) : null
}

// An AVR port pin (PB5: port B, bit 5) is 2000 + port × 8 + bit; an Arduino analog name (A0) that hasn't been
// resolved to a chip pin yet is 3000 + n.
export const AVR_BASE = 2000
export const ANALOG_BASE = 3000

export function avrPin(port: string, bit: number): number {
	return AVR_BASE + (port.toUpperCase().charCodeAt(0) - 65) * 8 + bit
}

export function parseAvrPin(tok: string): number | null {
	const m = /^P([A-L])([0-7])$/i.exec(tok)
	return m ? avrPin(m[1], Number(m[2])) : null
}

// An nRF port pin (P1.04: port 1, pin 4) is 4000 + port × 32 + pin.
export const NRF_BASE = 4000

export function nrfPin(port: number, pin: number): number {
	return NRF_BASE + port * 32 + pin
}

// P0.13, P1.04, P0_13 (KiCad writes both): an nRF port pin, or null.
export function parseNrfPin(tok: string): number | null {
	const m = /^P([0-3])[._](\d{1,2})$/i.exec(tok)
	return m && Number(m[2]) < 32 ? nrfPin(Number(m[1]), Number(m[2])) : null
}

// How a person names the pin: GPIO5, PC13, PB5 (AVR), P0.13 (nRF), A0.
export function pinLabel(n: number): string {
	if (n >= NRF_BASE && n < NRF_BASE + 4 * 32) return `P${Math.floor((n - NRF_BASE) / 32)}.${String((n - NRF_BASE) % 32).padStart(2, "0")}`
	if (n >= AVR_BASE && n < AVR_BASE + 12 * 8) return `P${String.fromCharCode(65 + Math.floor((n - AVR_BASE) / 8))}${(n - AVR_BASE) % 8}`
	if (n >= ANALOG_BASE && n < ANALOG_BASE + 100) return `A${n - ANALOG_BASE}`
	if (n >= STM32_BASE && n < STM32_BASE + 11 * 16) return `P${String.fromCharCode(65 + Math.floor((n - STM32_BASE) / 16))}${(n - STM32_BASE) % 16}`
	return `GPIO${n}`
}
