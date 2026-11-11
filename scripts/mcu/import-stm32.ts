// ST's STM32_open_pin_data (BSD-3-Clause, https://github.com/STMicroelectronics/STM32_open_pin_data) → an MCU profile.
// The XML gives package, pins with their pads and every signal they can carry, peripheral instances, flash, RAM and
// supply range; the overlay (catalog/mcu/overlays/<id>.json) adds what ST's data doesn't hold: currents, support parts,
// firmware and simulator targets, LCSC number, sources. Rerun after an overlay or ST data change:
//   npx tsx scripts/mcu/import-stm32.ts            (every overlay with an "st" block)
//   npx tsx scripts/mcu/import-stm32.ts <id>       (one)
// ST data lives in tools/vendor/STM32_open_pin_data (git clone --depth 1 --filter=blob:none --sparse, sparse set mcu).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { McuPin, McuProfile, PeriphKind } from "../../src/mcu/profile.ts"
import { PERIPH_KINDS } from "../../src/mcu/profile.ts"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const ST_DIR = process.env.ST_PIN_DATA ?? join(ROOT, "tools/vendor/STM32_open_pin_data/mcu")

// The tscircuit footprint for each ST package name (footprinter strings, checked to give the right pad count).
// The tscircuit footprint for each ST package, with the land pattern's extent (pads, at rotation 0) for placement.
// LQFP: footprinter's defaults put the pads past the leads (lqfp32 pad centres at ±5.45 mm, lead tips at 4.5 mm), so
// the dimensions are given to match KiCad's LQFP-32_7x7mm_P0.8mm and LQFP-48_7x7mm_P0.5mm (pads at ±4.1625 mm,
// 1.475 mm long), measured from footprinter's output on 11 Nov 2026.
export const PACKAGE_FOOTPRINT: Record<string, { footprint: string; bodyMm: { w: number; h: number }; extentMm: { w: number; h: number }; ringMm: number }> = {
	LQFP32: { footprint: "lqfp32_w7.05mm_h7.05mm_p0.8mm_pl1.475mm_pw0.55mm", bodyMm: { w: 7, h: 7 }, extentMm: { w: 9.8, h: 9.8 }, ringMm: 4.1625 },
	LQFP48: { footprint: "lqfp48_w7.05mm_h7.05mm_p0.5mm_pl1.475mm_pw0.3mm", bodyMm: { w: 7, h: 7 }, extentMm: { w: 9.8, h: 9.8 }, ringMm: 4.1625 },
	UFQFPN48: { footprint: "qfn48_p0.5mm", bodyMm: { w: 7, h: 7 }, extentMm: { w: 7.8, h: 7.8 }, ringMm: 3.4625 },
	VFQFPN48: { footprint: "qfn48_p0.5mm", bodyMm: { w: 7, h: 7 }, extentMm: { w: 7.8, h: 7.8 }, ringMm: 3.4625 },
}

// ST's IP names → our peripheral kinds. LPUART counts as a UART (the core drives it as one).
const IP_KIND: Record<string, PeriphKind> = {
	USART: "uart", UART: "uart", LPUART: "uart", I2C: "i2c", SPI: "spi", I2S: "i2s", SAI: "i2s", ADC: "adc",
	USB: "usb", USB_OTG_FS: "usb", USB_DRD_FS: "usb", CAN: "can", FDCAN: "can", BXCAN: "can", RF: "radio",
}

export const PORTS = "ABCDEFGHIJK"
// PA0 = 0, PB0 = 16, PC13 = 45: the index the contract stores for a pin (docs/mcu.md, Pin index).
export function stmIndex(name: string): number | null {
	const m = /^P([A-K])(\d{1,2})$/.exec(name)
	return m ? PORTS.indexOf(m[1]) * 16 + Number(m[2]) : null
}

interface StPin { name: string; position: string; type: string; variant: string | null; signals: string[] }

export function parseStXml(xml: string): { refName: string; family: string; packageName: string; core: string; mhz: number; ramKb: number; flashKb: number[]; voltage: { min: number; max: number }; ips: { instance: string; name: string }[]; pins: StPin[] } {
	const attr = (tag: string, a: string) => new RegExp(`(?:^|\\s)${a}="([^"]*)"`).exec(tag)?.[1] ?? ""
	const head = /<Mcu [^>]*>/.exec(xml)?.[0] ?? ""
	const num = (t: string) => Number(new RegExp(`<${t}>([^<]+)</${t}>`).exec(xml)?.[1] ?? 0)
	const flashKb = [...xml.matchAll(/<Flash>(\d+)<\/Flash>/g)].map((m) => Number(m[1]))
	const v = /<Voltage Max="([\d.]+)" Min="([\d.]+)"/.exec(xml)
	const ips = [...xml.matchAll(/<IP [^>]*>/g)].map((m) => ({ instance: attr(m[0], "InstanceName"), name: attr(m[0], "Name") }))
	const pins: StPin[] = []
	for (const m of xml.matchAll(/<Pin ([^>]*?)(\/>|>([\s\S]*?)<\/Pin>)/g)) {
		const tag = m[1]
		pins.push({
			name: attr(tag, "Name"),
			position: attr(tag, "Position"),
			type: attr(tag, "Type"),
			variant: attr(tag, "Variant") || null,
			signals: [...(m[3] ?? "").matchAll(/<Signal [^>]*Name="([^"]+)"/g)].map((s) => s[1]).filter((s) => s !== "GPIO"),
		})
	}
	return {
		refName: attr(head, "RefName"),
		family: attr(head, "Family"),
		packageName: attr(head, "Package"),
		core: /<Core>([^<]+)<\/Core>/.exec(xml)?.[1] ?? "",
		mhz: num("Frequency"),
		ramKb: num("Ram"),
		flashKb,
		voltage: { min: Number(v?.[2] ?? 0), max: Number(v?.[1] ?? 0) },
		ips,
		pins,
	}
}

// "PC14-OSC32_IN (PC14)", "PF2 - NRST", "PA11 [PA9]", "PD0-OSC_IN" → the port pin, and what the rest says about it.
export function basePin(raw: string): { name: string | null; tags: string[] } {
	const name = /^P[A-K]\d{1,2}/.exec(raw)?.[0] ?? null
	const tags = raw.replace(/\[.*?\]|\(.*?\)/g, "").split(/[-\s]+/).slice(1).filter(Boolean)
	return { name, tags }
}

const powerNet = (name: string, type: string): McuProfile["power"][number]["net"] => {
	if (type === "Reset" || name === "NRST") return "reset"
	if (type === "Boot" || name === "BOOT0") return "boot"
	if (/^VBAT/.test(name)) return "vbat"
	if (/^VSS/.test(name)) return "ground"
	if (/^VDDA|^VREF/.test(name)) return "analog"
	if (/^VDDUSB/.test(name)) return "usb"
	if (/^VDD(\/|$)/.test(name) || name === "VDD") return "supply"
	if (type === "NC") return "nc"
	return "other"
}

export type Overlay = Partial<McuProfile> & { id: string; st: { xml: string; flashKb?: number }; reserve?: Record<string, string> }

export function profileFromSt(xml: string, ov: Overlay): McuProfile {
	const st = parseStXml(xml)
	const pkg = PACKAGE_FOOTPRINT[st.packageName]
	if (!pkg) throw new Error(`${ov.id}: no footprint for ST package ${st.packageName}`)
	const pins: McuPin[] = []
	const power: McuProfile["power"] = []
	for (const p of st.pins) {
		if (p.variant) continue // a remap alternative of a pad already listed
		const { name, tags } = basePin(p.name)
		if (p.type === "I/O" && name) {
			const index = stmIndex(name)!
			const reserved =
				ov.reserve?.[name] ??
				(name === "PA13" || name === "PA14" ? "swd" : tags.includes("NRST") ? "reset" : undefined)
			const wake = p.signals.some((s) => /WKUP/.test(s)) || undefined
			pins.push({ name, index, pads: [p.position], signals: p.signals, ...(wake ? { wake } : {}), ...(reserved ? { reserved } : {}) })
		} else {
			const net = name && tags.includes("BOOT0") ? "boot" : powerNet(p.name, p.type)
			const label = p.name.replace(/\s+/g, "")
			const same = power.find((x) => x.name === label)
			if (same) same.pads.push(p.position)
			else power.push({ name: label, net, pads: [p.position] })
		}
	}
	// A pad named after two pins (PA14-BOOT0) stays a pin; its BOOT0 role shows in boot below.
	const peripherals = Object.fromEntries(PERIPH_KINDS.map((k) => [k, [] as string[]])) as Record<PeriphKind, string[]>
	for (const ip of st.ips) {
		const kind = IP_KIND[ip.name]
		if (kind && !peripherals[kind].includes(ip.instance)) peripherals[kind].push(ip.instance)
	}
	const flashKb = ov.st.flashKb ?? Math.max(...st.flashKb)
	const { st: _st, reserve: _r, ...rest } = ov
	return {
		vendor: "st",
		family: st.family,
		kind: "chip",
		package: { name: st.packageName, ...pkg },
		board: { supported: true },
		core: st.core,
		mhz: st.mhz,
		flashKb,
		ramKb: st.ramKb,
		voltage: st.voltage,
		pins: pins.sort((a, b) => a.index - b.index),
		power,
		peripherals,
		usb: null,
		radio: [],
		...rest,
		sources: [`ST STM32_open_pin_data mcu/${ov.st.xml} (BSD-3-Clause)`, ...(ov.sources ?? [])],
	} as McuProfile
}

function main(only?: string) {
	const dir = join(ROOT, "catalog/mcu/overlays")
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		const ov = JSON.parse(readFileSync(join(dir, f), "utf8")) as Overlay
		if (!ov.st || (only && ov.id !== only)) continue
		const xmlPath = join(ST_DIR, ov.st.xml)
		if (!existsSync(xmlPath)) throw new Error(`${ov.id}: ${xmlPath} missing (see the header of this script)`)
		const profile = profileFromSt(readFileSync(xmlPath, "utf8"), ov)
		writeFileSync(join(ROOT, "catalog/mcu", `${ov.id}.json`), JSON.stringify(profile, null, "\t") + "\n")
		console.log(`${ov.id}: ${profile.pins.length} pins, ${Object.entries(profile.peripherals).map(([k, v]) => `${k} ${v.length}`).join(", ")}`)
	}
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv[2])
