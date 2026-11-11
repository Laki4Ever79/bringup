import type { McuProfile, SupportSpec } from "./profile.ts"

// A bare chip on a Bringup board (docs/mcu.md, Board): its pads labelled from the profile, its power pads joined to the
// rails, and the parts every board with it needs (decoupling per supply pad, bulk, the reset pin's capacitor, a boot pin
// pull-down) listed in the profile with their source, not in code. Modules (the ESP32-C3-MINI-1) carry their own.

// A power pad's label: the profile's name up to any slash (VDD/VDDA → VDD), numbered when a name repeats (VDD, VDD2…),
// so every pad has its own label for tscircuit.
export function chipPadLabels(p: McuProfile): Map<string, string> {
	const out = new Map<string, string>()
	for (const pin of p.pins) for (const pad of pin.pads) out.set(pad, pin.name)
	const seen = new Map<string, number>()
	for (const pw of p.power) {
		const base = pw.name.split("/")[0].replace(/[^A-Za-z0-9_]/g, "_") || pw.net.toUpperCase()
		for (const pad of pw.pads) {
			const n = (seen.get(base) ?? 0) + 1
			seen.set(base, n)
			out.set(pad, n === 1 ? base : `${base}${n}`)
		}
	}
	return out
}

// The part's pins as the catalog and the contract list them: one label per pad, in pad order.
export function chipPartPins(p: McuProfile): string[] {
	return [...chipPadLabels(p).entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, label]) => label)
}

// tscircuit's pinLabels for the footprint: pin<pad> → label.
export function chipPinLabels(p: McuProfile): Record<string, string> {
	return Object.fromEntries([...chipPadLabels(p).entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([pad, label]) => [`pin${pad}`, label]))
}

// Which labels go to the supply rail and which to ground (analog supply and VBAT ride the main rail on these boards).
export function chipPowerPins(p: McuProfile): { supply: string[]; ground: string[] } {
	const labels = chipPadLabels(p)
	const by = (nets: string[]) => p.power.filter((x) => nets.includes(x.net)).flatMap((x) => x.pads.map((pad) => labels.get(pad)!))
	return { supply: by(["supply", "analog", "vbat", "usb"]), ground: by(["ground"]) }
}

export type ChipEnd = { ref: string; pin: string } | { net: string }
export interface ChipSupportJob {
	job: string
	spec: SupportSpec
	a: ChipEnd
	b: ChipEnd
}

// The profile's support list resolved on a board: "pin:VDD" → the MCU's pad labelled VDD, "net:supply" → the rail,
// "net:GND" → ground. A job naming a pin this package lacks is dropped (one profile serves its package only).
export function chipSupport(p: McuProfile, mcuRef: string, supplyNet: string): ChipSupportJob[] {
	if (p.kind !== "chip") return []
	const labels = new Set(chipPadLabels(p).values())
	const end = (s: string): ChipEnd | null => {
		const [kind, name] = s.split(":")
		if (kind === "pin") return labels.has(name) ? { ref: mcuRef, pin: name } : null
		if (kind === "net") return { net: name === "supply" ? supplyNet : name }
		return null
	}
	return p.support.flatMap((j) => {
		const a = end(j.a), b = end(j.b)
		return a && b ? [{ job: j.job, spec: j.spec, a, b }] : []
	})
}

// The crystal a chip's clock needs (profile clock.crystal) and the pad labels it joins: pin 1 to OSC_IN (clock.pads[0])
// and pin 3 to OSC_OUT (clock.pads[1]). null for a chip on its internal oscillator, a module, or a profile whose
// crystal pads carry no label.
//
// Load capacitors: C = 2 × (CL − Cstray), with Cstray ≈ 3 pF (the pins and traces). The F103's 8 MHz crystal (CL 10 pF)
// asks for 2 × (10 − 3) = 14 pF; 15 pF C0G (C1548, a JLCPCB Basic part) is the nearest value stocked, pulling the
// frequency by a few ppm. The RP2040's 12 MHz crystal (CL 12 pF) asks for 2 × (12 − 3) = 18 pF; 15 pF loads it ~1.5 pF
// light, a small upward pull (tens of ppm at most), well inside what USB full speed tolerates (±2500 ppm).
export interface ChipCrystal {
	mhz: number
	inPin: string
	outPin: string
	inPad: string
	crystal: { mpn: string; lcsc: string; loadPf: number; footprint: "smd3225_4p" }
	loadCap: { value: string; mpn: string; lcsc: string }
}
export function chipCrystal(p: McuProfile): ChipCrystal | null {
	const c = p.clock
	if (p.kind !== "chip" || !c?.crystal || !c.loadCap) return null
	const labels = chipPadLabels(p)
	const inPin = labels.get(c.pads[0]), outPin = labels.get(c.pads[1])
	if (!inPin || !outPin) return null
	return { mhz: c.hseMhz, inPin, outPin, inPad: c.pads[0], crystal: c.crystal, loadCap: c.loadCap }
}
