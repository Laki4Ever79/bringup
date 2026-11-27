// A chip with no native USB that flashes over UART (its profile's programming.method "uart": the ESP32-WROOM-32E, CNC
// gap 14) needs a USB-UART bridge and an auto-reset pair on a board with a USB-C, or its port carries power only and the
// board can't be flashed from it. Added in code under free refs (U for the bridge, Q for the pair), the way a robot's IMU
// is (imu-auto.ts); dropped again when the MCU changes to one with native USB or the USB-C goes. The board generator
// wires them (circuit.ts usbBridge, their catalog nets). Pure: the contract tools apply it on every parts write.
import type { Part } from "./types.ts"
import { profileForPart } from "../mcu/profile.ts"

type CatalogPart = Part & { lcsc: string | null }

export const BRIDGE_ROLES = ["usb-uart", "auto-reset"] as const

export function needsUsbBridge(parts: Part[]): boolean {
	const mcu = parts.find((p) => p.role === "mcu")
	const prof = mcu ? profileForPart(mcu) : null
	return Boolean(prof && !prof.usb && prof.programming?.method === "uart" && prof.console && parts.some((p) => p.role === "usb-c"))
}

export function withUsbBridge(parts: Part[], catalog: CatalogPart[]): { parts: Part[]; note: string | null } {
	const need = needsUsbBridge(parts)
	const have = parts.filter((p) => (BRIDGE_ROLES as readonly string[]).includes(p.role ?? ""))
	if (!need) {
		if (!have.length) return { parts, note: null }
		return { parts: parts.filter((p) => !have.includes(p)), note: `dropped ${have.map((p) => `${p.ref} ${p.mpn}`).join(", ")} (the MCU has native USB or the board has no USB-C: no USB-UART bridge needed)` }
	}
	const taken = new Set(parts.map((p) => p.ref))
	const free = (prefix: string) => {
		let n = prefix === "U" ? 2 : 1
		while (taken.has(`${prefix}${n}`)) n++
		taken.add(`${prefix}${n}`)
		return `${prefix}${n}`
	}
	const added: Part[] = []
	for (const [role, prefix, why] of [
		["usb-uart", "U", "the MCU has no native USB and flashes over UART0: the USB-C's D+/D- reach it through this bridge"],
		["auto-reset", "Q", "the bridge's DTR/RTS reset the MCU into its download mode (EN and GPIO0), so it flashes without buttons"],
	] as const) {
		if (have.some((p) => p.role === role)) continue
		const entry = catalog.find((c) => c.role === role)
		if (!entry) continue
		// The catalog's nets for a chip stay in the catalog, where chip-support reads them.
		const { ref: _r, nets: _n, ...rest } = entry as CatalogPart & Record<string, unknown>
		added.push({ ...(rest as unknown as Part), ref: free(prefix), reason: why })
	}
	if (!added.length) return { parts, note: null }
	return { parts: [...parts, ...added], note: `added ${added.map((p) => `${p.ref} ${p.mpn}`).join(" and ")} (the MCU flashes over UART: the USB-UART bridge and its auto-reset pair)` }
}
