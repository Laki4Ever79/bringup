import { HARD_RESERVED } from "./pins.ts"
import type { McuPin, McuProfile, PeriphKind } from "./profile.ts"

// The pin solver (docs/mcu.md, Pins): what a design needs → which pins, on which peripheral instance, from the profile
// alone. A group (an I2C bus's SDA and SCL, a UART's TX and RX) must share one instance; each function must be a signal
// that pin can carry (ST's I2C1_SDA, USART2_TX…); "*" on a pin is a GPIO matrix (ESP32): any function of any instance.
// What CubeMX does for ST and SysConfig for TI, from data any vendor's profile can give.

export interface Need {
	signal: string
	kind: "gpio" | "adc" | "wake" | PeriphKind
	role?: string // the function within the peripheral: SDA, SCL, TX, RX, SCK, MISO, MOSI, CK, WS, SD, DP, DM
	group?: string // needs with the same group share one peripheral instance
}
export interface Assigned {
	signal: string
	index: number
	pin: string
	instance?: string
	fn?: string
}
export type Solved = { ok: true; pins: Assigned[] } | { ok: false; reason: string }

const KIND_LABEL: Record<string, string> = { uart: "UART", i2c: "I2C", spi: "SPI", i2s: "I2S", adc: "ADC", usb: "USB", can: "CAN", radio: "radio" }
// The signal a function goes by on an instance: ST names its I2S data line SD, its USB pins USB_DP/USB_DM.
const signalFor = (instance: string, fn: string) => `${instance}_${fn}`

const consolePins = (p: McuProfile) => new Set(p.console ? [p.console.tx, p.console.rx] : [])

// Pins a design may take, best first: the profile's preferred order, then by index; soft reservations (strap, usb, boot)
// last, so they are used only when nothing else fits.
function usable(p: McuProfile, taken: Set<number>): McuPin[] {
	const con = consolePins(p)
	const pref = p.preferred ?? []
	const rank = (x: McuPin) => (x.reserved ? 1000 : 0) + (pref.includes(x.index) ? pref.indexOf(x.index) : 100 + x.index)
	return p.pins
		.filter((x) => !taken.has(x.index) && !con.has(x.name) && !(x.reserved && HARD_RESERVED.has(x.reserved)))
		.sort((a, b) => rank(a) - rank(b))
}

const carries = (pin: McuPin, sig: string) => pin.signals.includes("*") || pin.signals.includes(sig)
const isAdc = (pin: McuPin) => pin.signals.some((s) => /^ADC\d*_(IN|CH)\d+$/.test(s))
const canWake = (p: McuProfile, pin: McuPin) => pin.wake === true || p.wakeAny === true

// The functions each peripheral kind needs pins for, to count an instance as usable.
const FNS: Partial<Record<PeriphKind, string[]>> = { uart: ["TX", "RX"], i2c: ["SDA", "SCL"], spi: ["SCK", "MISO", "MOSI"], i2s: ["CK", "WS", "SD"], can: ["TX", "RX"] }

// The instances of a kind a design may use: not the console's, and (for pinned kinds) only those whose functions reach
// free pins. On the STM32G031K8 in LQFP32, LPUART1 comes out only on PA2/PA3, the console's pins, so it doesn't count.
function instancesFor(p: McuProfile, kind: PeriphKind, taken: Set<number> = new Set()): string[] {
	const all = (p.peripherals[kind] ?? []).filter((i) => i !== p.console?.instance)
	const fns = FNS[kind]
	if (!fns) return all
	const free = usable(p, taken)
	return all.filter((i) => {
		const picked = new Set<McuPin>()
		return fns.every((fn) => {
			const pin = free.find((x) => !picked.has(x) && carries(x, signalFor(i, fn)))
			if (pin) picked.add(pin)
			return !!pin
		})
	})
}

export function solvePins(p: McuProfile, needs: Need[], takenIn: number[] = []): Solved {
	const taken = new Set(takenIn)
	const out: Assigned[] = []
	const name = p.mpn

	// Peripheral groups first: they are the tightly constrained ones.
	const groups = new Map<string, Need[]>()
	for (const n of needs) {
		if (n.kind === "gpio" || n.kind === "adc" || n.kind === "wake") continue
		const key = `${n.kind}:${n.group ?? n.signal}`
		groups.set(key, [...(groups.get(key) ?? []), n])
	}
	const byKind = new Map<PeriphKind, number>()
	for (const g of groups.values()) byKind.set(g[0].kind as PeriphKind, (byKind.get(g[0].kind as PeriphKind) ?? 0) + 1)
	for (const [kind, count] of byKind) {
		const have = instancesFor(p, kind, taken)
		if (count > have.length) {
			const lost = (p.peripherals[kind] ?? []).filter((i) => !have.includes(i))
			const why = lost.length ? `; ${lost.map((i) => (i === p.console?.instance ? `${i} is the console` : `${i} has no free pins`)).join(", ")}` : ""
			return { ok: false, reason: `needs ${count} ${KIND_LABEL[kind]}, the ${name} has ${have.length}${have.length ? ` (${have.join(", ")})` : ""}${why}` }
		}
	}

	const list = [...groups.values()]
	const options = (g: Need[], used: Set<string>, free: McuPin[]) =>
		instancesFor(p, g[0].kind as PeriphKind, taken)
			.filter((i) => !used.has(i))
			.map((instance) => {
				const picks: McuPin[] = []
				for (const n of g) {
					const sig = signalFor(instance, n.role ?? n.signal)
					const pin = free.find((x) => !picks.includes(x) && carries(x, sig))
					if (!pin) return null
					picks.push(pin)
				}
				return { instance, picks }
			})
			.filter((o): o is { instance: string; picks: McuPin[] } => o !== null)

	// Backtracking over groups, the one with the fewest options first.
	const solveGroups = (rest: Need[][], used: Set<string>, takenNow: Set<number>): Assigned[] | null => {
		if (rest.length === 0) return []
		const free = usable(p, takenNow)
		const scored = rest.map((g) => ({ g, opts: options(g, used, free) })).sort((a, b) => a.opts.length - b.opts.length)
		const [{ g, opts }, ...others] = scored
		for (const o of opts) {
			const nextTaken = new Set([...takenNow, ...o.picks.map((x) => x.index)])
			const tail = solveGroups(others.map((x) => x.g), new Set([...used, o.instance]), nextTaken)
			if (tail) return [...g.map((n, i) => ({ signal: n.signal, index: o.picks[i].index, pin: o.picks[i].name, instance: o.instance, fn: n.role ?? n.signal })), ...tail]
		}
		return null
	}
	const grouped = solveGroups(list, new Set(), taken)
	if (!grouped) {
		const g = list.find((x) => options(x, new Set(), usable(p, taken)).length === 0) ?? list[0]
		return { ok: false, reason: `no free pins on the ${name} carry ${g.map((n) => n.role ?? n.signal).join(" and ")} of one ${KIND_LABEL[g[0].kind]} instance${taken.size ? " (other pins already taken)" : ""}` }
	}
	out.push(...grouped)
	for (const a of grouped) taken.add(a.index)

	// Single pins: ADC and wake first (constrained), plain GPIO last; a plain GPIO avoids pins that carry ADC.
	const singles = needs.filter((n) => n.kind === "gpio" || n.kind === "adc" || n.kind === "wake")
	const order = { adc: 0, wake: 1, gpio: 2 } as const
	const totalFree = usable(p, taken).length
	if (singles.length > totalFree) return { ok: false, reason: `needs ${singles.length} GPIOs, the ${name} has ${totalFree} free` }
	for (const n of [...singles].sort((a, b) => order[a.kind as keyof typeof order] - order[b.kind as keyof typeof order])) {
		const free = usable(p, taken)
		const pin =
			n.kind === "adc" ? free.find(isAdc) : n.kind === "wake" ? free.find((x) => canWake(p, x)) : (free.find((x) => !isAdc(x)) ?? free[0])
		if (!pin) return { ok: false, reason: `${n.signal} needs ${n.kind === "adc" ? "an analog input" : "a pin that wakes the chip"}, and the ${name} has none free` }
		taken.add(pin.index)
		out.push({ signal: n.signal, index: pin.index, pin: pin.name })
	}
	// In the order asked.
	const at = (s: string) => needs.findIndex((n) => n.signal === s)
	return { ok: true, pins: out.sort((a, b) => at(a.signal) - at(b.signal)) }
}

// GPIOs a link or a design may take freely: the preferred list where the profile has one, else every unreserved pin.
export function freeGpios(p: McuProfile): number[] {
	if (p.preferred) return [...p.preferred]
	const con = consolePins(p)
	return p.pins.filter((x) => !x.reserved && !con.has(x.name)).map((x) => x.index)
}

export type LinkPeripheral = "uart" | "i2c" | "spi" | "i2s" | "radio"
// Peripheral instances a design may use, the console's excluded.
export function peripheralsFree(p: McuProfile): Record<LinkPeripheral, number> {
	const n = (k: PeriphKind) => instancesFor(p, k).length
	return { uart: n("uart"), i2c: n("i2c"), spi: n("spi"), i2s: n("i2s"), radio: n("radio") }
}
