// The ESP32-WROOM-32E as a board MCU (CNC gap 14, FluidNC's chip): its land pattern from the datasheet, and, with no
// native USB, the USB-UART bridge (CH340C) and the auto-reset pair (UMH3N) between the USB-C and the module's UART0, EN
// and GPIO0.
import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { generatedNets, MODULES, usbBridge } from "../src/codegen/circuit.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { withUsbBridge } from "../src/contract/usb-bridge-auto.ts"
import type { ContractSnapshot, Part } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const catalog = loadCatalog(resolve(import.meta.dirname, ".."))
// A part as the parts agent writes it: the catalog's ref-less entry with a ref. A chip's catalog nets (the bridge's, the
// auto-reset pair's) stay in the catalog, where chip-support reads them; the module's own (its extra grounds) come along.
const entry = (mpn: string, ref: string): Part => {
	const c = catalog.find((x) => x.mpn === mpn) as unknown as Part | undefined
	assert.ok(c, mpn)
	const { nets, ...rest } = c
	return { ...rest, ref, ...(c.role === "mcu" && nets ? { nets } : {}) }
}
function wroomBoard(withBridge = true): ContractSnapshot {
	const b = fixtureContract()
	const parts = [entry("ESP32-WROOM-32E", "U1"), ...b.values.parts!.filter((p) => p.role !== "mcu"), entry("TYPE-C-31-M-12", "J1"), ...(withBridge ? [entry("CH340C", "U5"), entry("UMH3N", "Q1")] : [])]
	return { ...b, values: { ...b.values, parts, pins: [{ signal: "I2C_SDA", gpio: 21, partRef: "U2", partPin: "SDA" }, { signal: "I2C_SCL", gpio: 22, partRef: "U2", partPin: "SCL" }], connectors: [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 0 }] } } as ContractSnapshot
}

test("the WROOM-32E's land pattern: 38 pads of 1.5 × 0.9 mm at 1.27 mm and the ground pad, from Figure 13", () => {
	const m = MODULES.esp32_wroom_32e
	const pads = m.pads()
	assert.equal(pads.length, 39)
	const at = (n: number) => pads.find((p) => p.pin === n)!
	// Pad 1 is 7.49 mm below the antenna end; the side columns are 17.5 mm apart; each side spans 16.51 mm, the bottom 11.43.
	assert.equal(+(m.body.h / 2 - at(1).y).toFixed(2), 7.49)
	assert.equal(at(25).x - at(14).x, 17.5)
	assert.equal(+(at(1).y - at(14).y).toFixed(2), 16.51)
	assert.equal(at(14).y, at(25).y)
	assert.equal(at(1).y, at(38).y)
	assert.equal(+(at(24).x - at(15).x).toFixed(2), 11.43)
	// Every pad reaches 0.5 mm past the module's edge, and every signal pad stays below the 6.19 mm antenna area.
	assert.equal(+(Math.abs(at(1).x) + at(1).w / 2 - m.body.w / 2).toFixed(2), 0.5)
	assert.equal(+(m.body.h / 2 - (Math.abs(at(15).y) + at(15).h / 2)).toFixed(2), -0.5)
	assert.ok(pads.every((p) => p.y + p.h / 2 < m.padAreaTop))
	// Its pins by pad (Table 3): IO0 on 25, EN on 3, the four grounds.
	assert.equal(m.pins.GPIO0, 25)
	assert.equal(m.pins.EN, 3)
	assert.deepEqual([m.pins.GND, m.pins.GND_2, m.pins.GND_3, m.pins.GND_4], [1, 15, 38, 39])
})

test("no native USB: the USB-C's D+/D- reach the CH340C, its TXD/RXD the console (GPIO3/GPIO1), the UMH3N EN and GPIO0", () => {
	const s = wroomBoard()
	assert.deepEqual(usbBridge(s) && { tx: usbBridge(s)!.tx, rx: usbBridge(s)!.rx, boot: usbBridge(s)!.boot }, { tx: "GPIO1", rx: "GPIO3", boot: "GPIO0" })
	const nets = generatedNets(s)
	const on = (net: string) => (nets.get(net) ?? []).sort()
	assert.ok(on("USB_DP").includes("U5.UDP") && on("USB_DP").some((p) => p.startsWith("J1.")))
	assert.ok(on("USB_DN").includes("U5.UDM") && on("USB_DN").some((p) => p.startsWith("J1.")))
	assert.deepEqual(on("MCU_RXD"), ["U1.GPIO3", "U5.TXD"])
	assert.deepEqual(on("MCU_TXD"), ["U1.GPIO1", "U5.RXD"])
	// Tr1 (base DTR, emitter RTS) on EN; Tr2 (base RTS, emitter DTR) on GPIO0.
	assert.ok(on("MCU_EN").includes("U1.EN") && on("MCU_EN").includes("Q1.C1"))
	assert.deepEqual(on("MCU_BOOT"), ["Q1.C2", "U1.GPIO0"])
	assert.deepEqual(on("USB_DTR"), ["Q1.B1", "Q1.E2", "U5.DTR"])
	assert.deepEqual(on("USB_RTS"), ["Q1.B2", "Q1.E1", "U5.RTS"])
	// The bridge on 3.3 V (V3 joins VCC), its ground; the module's four ground pads.
	const supply = [...nets].find(([, p]) => p.includes("U1.3V3"))![0]
	assert.ok(nets.get(supply)!.includes("U5.VCC") && nets.get(supply)!.includes("U5.V3"))
	for (const g of ["U1.GND", "U1.GND_2", "U1.GND_3", "U1.GND_4", "U5.GND"]) assert.ok(on("GND").includes(g), g)
})

test("without the bridge, the USB-C carries power only: no data lines to a chip that can't use them", () => {
	const s = wroomBoard(false)
	assert.equal(usbBridge(s), null)
	const nets = generatedNets(s)
	assert.ok(!(nets.get("USB_DP") ?? []).length)
})

test("the bridge and its auto-reset pair are added in code for a UART-flashed MCU with a USB-C, and dropped when not needed", () => {
	const s = wroomBoard(false)
	const cat = catalog as never
	const a = withUsbBridge(s.values.parts!, cat)
	assert.deepEqual(a.parts.filter((p) => p.role === "usb-uart" || p.role === "auto-reset").map((p) => `${p.ref} ${p.mpn}`), ["U3 CH340C", "Q1 UMH3N"])
	assert.ok(a.parts.every((p) => p.role === "mcu" || !p.nets || Object.values(p.nets).every((n) => !n.startsWith("@"))), "the chips' catalog nets stay in the catalog")
	assert.equal(withUsbBridge(a.parts, cat).note, null, "idempotent")
	// A native-USB MCU (the C3) or no USB-C: the pair goes.
	const c3 = a.parts.map((p) => (p.role === "mcu" ? fixtureContract().values.parts!.find((q) => q.role === "mcu")! : p))
	assert.deepEqual(withUsbBridge(c3, cat).parts.filter((p) => p.role === "usb-uart" || p.role === "auto-reset"), [])
	assert.match(withUsbBridge(c3, cat).note ?? "", /dropped U3 CH340C, Q1 UMH3N/)
	assert.deepEqual(withUsbBridge(a.parts.filter((p) => p.role !== "usb-c"), cat).parts.filter((p) => p.role === "usb-uart"), [])
	// A C3 design never gets one.
	assert.equal(withUsbBridge(fixtureContract().values.parts!, cat).note, null)
})
