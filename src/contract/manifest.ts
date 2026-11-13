// The board manifest (engineer, 13 Nov 2026): bench.json, written with every design, so a person or a bench tool can
// bring the board up without asking anyone: the target chip and how to flash it, each rail's expected voltage and
// current, each bottom pad's net and place, each signal's pin, the I2C devices that should answer, and the bring-up
// steps in a safe order. Plain JSON in an open schema ("bringup-bench/1"): any tool may read it, ours included
// (/home/aleksa/Documents/hw_agent's board manifest has the same parts). bringup.md is the same, for a person.
import { resolve } from "node:path"
import { bringupPads, netName, recoveryPads, testPoints, type TestPoint } from "../codegen/circuit.ts"
import { mcuProfileOf } from "../mcu/profile.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import type { ContractSnapshot } from "./types.ts"

export interface BenchPad {
	ref: string
	net: string
	kind: "bringup" | "recovery" | "test"
	side: "bottom"
	// From the board's bottom-left corner, top view.
	xMm: number
	yMm: number
}

export interface BenchStep {
	id: string
	what: string
	pass: string
	pad?: string
}

export interface BenchManifest {
	schema: "bringup-bench/1"
	board: { summary: string; revision: number; widthMm: number; heightMm: number }
	target: { mcu: string; family: string | null; programming: string | null; flash: string; console: string; boot: { pin: string; level: "low" | "high" } | null }
	rails: { name: string; net: string; expectV: number; tolV: number; maxMa: number; averageMa: number | null; pad: string | null }[]
	pads: BenchPad[]
	signals: { net: string; gpio: number; part: string; role: string | null; pad: string | null }[]
	expect: { i2c: { ref: string; mpn: string; address: string }[] }
	bringup: BenchStep[]
}

// A linear regulator's output tolerance: the RT9080's is ±2 %, the usual LDO's ±1-3 %; ±3 % covers them (assumption,
// not one datasheet's number). A battery rail is judged by its range instead.
const RAIL_TOL = 0.03
const catalog = loadCatalog(resolve(import.meta.dirname, "../.."))
const hex = (a: number) => `0x${a.toString(16).padStart(2, "0")}`

export function benchPads(s: ContractSnapshot): BenchPad[] {
	const tag = (kind: BenchPad["kind"]) => (p: TestPoint): BenchPad => ({ ref: p.ref, net: p.net, kind, side: "bottom", xMm: p.xMm, yMm: p.yMm })
	return [...testPoints(s).placed.map(tag("test")), ...recoveryPads(s).placed.map(tag("recovery")), ...bringupPads(s).placed.map(tag("bringup"))]
}

export function benchManifest(s: ContractSnapshot): BenchManifest | null {
	const { outline, parts = [], pins = [], rails = [], requirements } = s.values
	if (!outline) return null
	const prof = mcuProfileOf(parts)
	const mcu = parts.find((p) => p.role === "mcu")
	const pads = benchPads(s)
	const padOn = (...nets: string[]) => pads.find((p) => nets.includes(p.net))?.ref ?? null
	const env = prof?.firmware.env ?? prof?.id
	const usbConsole = prof?.programming.method === "usb-serial-jtag" || prof?.programming.method === "uf2"
	const target: BenchManifest["target"] = {
		mcu: mcu?.mpn ?? "unknown",
		family: prof?.family ?? null,
		programming: prof?.programming.method ?? null,
		flash: `pio run -d firmware${env ? ` -e ${env}` : ""} -t upload`,
		console: usbConsole ? "USB serial (CDC) on the board's USB-C" : prof?.console ? `${prof.console.instance} on ${prof.console.tx} (TX), ${prof.console.rx} (RX)` : "none known",
		boot: prof?.boot.pin && prof.boot.level ? { pin: prof.boot.pin, level: prof.boot.level } : null,
	}
	const railRows: BenchManifest["rails"] = rails.map((r) => ({
		name: r.name,
		net: netName(r.name),
		expectV: r.voltageV,
		tolV: +(r.voltageV * RAIL_TOL).toFixed(3),
		maxMa: r.loadMa,
		averageMa: r.averageMa ?? null,
		pad: padOn(netName(r.name), r.name),
	}))
	const signals = pins.map((p) => ({ net: p.signal, gpio: p.gpio, part: `${p.partRef}.${p.partPin}`, role: parts.find((x) => x.ref === p.partRef)?.role ?? null, pad: padOn(p.signal) }))
	const i2c = parts.flatMap((p) => {
		const a = (catalog.find((c) => c.mpn.toUpperCase() === p.mpn.toUpperCase()) as { i2cAddress?: number } | undefined)?.i2cAddress
		return a === undefined ? [] : [{ ref: p.ref, mpn: p.mpn, address: hex(a) }]
	})
	const gnd = padOn("GND")
	const battery = parts.some((p) => p.role === "battery")
	const steps: BenchStep[] = [
		{ id: "look", what: "look the board over: every part placed, the right way round (pin 1, the LEDs, the USB-C shell soldered)", pass: "nothing missing, bridged or tombstoned" },
		...railRows.map((r) => ({ id: `short-${r.name}`, what: `unpowered: resistance from ${r.name} to GND`, pass: "more than 100 Ω (a short reads near 0)", pad: r.pad ?? undefined })),
	]
	// One "short" step id for the order: the first rail's, renamed, so tools can find it.
	if (steps[1]) steps[1] = { ...steps[1], id: "short" }
	else steps.push({ id: "short", what: "unpowered: resistance from the supply to GND", pass: "more than 100 Ω" })
	steps.push({ id: "power", what: `power from USB through a current-limited supply or a USB meter${battery ? ", battery unplugged" : ""}`, pass: `under ${Math.max(50, Math.round(railRows.reduce((a, r) => a + r.maxMa, 0) / 4))} mA before any firmware runs; nothing warm` })
	for (const r of railRows) steps.push({ id: `rail-${r.name}`, what: `${r.name} rail${gnd ? ` (ground on ${gnd})` : ""}`, pass: `${(r.expectV - r.tolV).toFixed(2)}–${(r.expectV + r.tolV).toFixed(2)} V`, pad: r.pad ?? undefined })
	steps.push({ id: "flash", what: `flash the product firmware: ${target.flash}`, pass: `the upload verifies${target.boot ? `; if the chip doesn't answer, hold ${target.boot.pin} ${target.boot.level} at reset${padOn(target.boot.pin, "BOOT") ? "" : pads.some((p) => p.kind === "recovery") ? " (short the recovery pads)" : ""}` : ""}` })
	steps.push({ id: "console", what: `open the console: ${target.console}`, pass: "the firmware prints its start-up lines" })
	if (i2c.length) steps.push({ id: "i2c-scan", what: "scan the I2C bus", pass: `answers at ${i2c.map((d) => `${d.address} (${d.ref} ${d.mpn})`).join(", ")} and nowhere else` })
	for (const sg of signals.filter((x) => x.role === "led")) steps.push({ id: `led-${sg.net}`, what: `${sg.net} lights ${sg.part.split(".")[0]}`, pass: "it blinks as the firmware says", pad: sg.pad ?? undefined })
	if (battery) steps.push({ id: "battery", what: "plug the battery in, USB still in", pass: "the charge light comes on; VBAT rises toward 4.2 V", pad: padOn("VBAT") ?? undefined })
	return {
		schema: "bringup-bench/1",
		board: { summary: requirements?.summary ?? "", revision: s.revision, widthMm: outline.widthMm, heightMm: outline.heightMm },
		target,
		rails: railRows,
		pads,
		signals,
		expect: { i2c },
		bringup: steps,
	}
}

export function bringupMarkdown(m: BenchManifest): string {
	return [
		`# Bring-up, design revision ${m.board.revision}`,
		"",
		`${m.board.summary} · ${m.board.widthMm}×${m.board.heightMm} mm · ${m.target.mcu}. Generated by Bringup from the design; bench.json has the same, for tools.`,
		"",
		"## Pads (bottom side, from the board's bottom-left corner, top view)",
		"",
		"| Pad | Net | Kind | x mm | y mm |",
		"| --- | --- | --- | --- | --- |",
		...m.pads.map((p) => `| ${p.ref} | ${p.net} | ${p.kind} | ${p.xMm} | ${p.yMm} |`),
		"",
		"## Steps",
		"",
		"| # | What | Pass | Pad |",
		"| --- | --- | --- | --- |",
		...m.bringup.map((x, i) => `| ${i + 1} | ${x.what} | ${x.pass} | ${x.pad ?? ""} |`),
		"",
		`Rail tolerance is ±${RAIL_TOL * 100} % (a typical regulator's, an assumption). Flash: \`${m.target.flash}\`. Console: ${m.target.console}.`,
		"",
	].join("\n")
}
