// One number per MCU pin, across chip families: an ESP32/RP2040 GPIO is its own number; an STM32 port pin (PC13) is
// 1000 + port × 16 + pin, so it never collides with a GPIO number and still sorts and compares as one.
export const STM32_BASE = 1000

export function portPin(port: string, n: number): number {
	return STM32_BASE + (port.toUpperCase().charCodeAt(0) - 65) * 16 + n
}

// PA5, PC13 (also PC13-TAMPER-RTC's first part): an STM32-style port pin, or null.
export function parsePortPin(tok: string): number | null {
	const m = /^P([A-K])(\d{1,2})$/i.exec(tok)
	return m && Number(m[2]) < 16 ? portPin(m[1], Number(m[2])) : null
}

// How a person names the pin: GPIO5, PC13.
export function pinLabel(n: number): string {
	if (n >= STM32_BASE && n < STM32_BASE + 11 * 16) return `P${String.fromCharCode(65 + Math.floor((n - STM32_BASE) / 16))}${(n - STM32_BASE) % 16}`
	return `GPIO${n}`
}
