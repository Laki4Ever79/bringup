// A standard debug footprint on every board (engineer, 13 Nov 2026, "A"): Tag-Connect TC2030-IDC-NL, six bare pads and
// three alignment holes, so any stock TC2030 cable (or a pogo head of our own) reaches the chip without a connector.
// Drawing TC2030-IDC-NL-FP rev A: pads ø0.787 mm, 1.27 mm columns, rows ±0.635 mm; NPTH ø0.991 mm at (-2.54, 0) and
// (+2.54, ±1.016); no solder paste on the pads; DNL in the BOM (nothing to buy). On the underside, after the pads a
// production test or recovery needs, before the bring-up pads; dropped when there is no room, never a reason to grow.
import { test } from "node:test"
import assert from "node:assert/strict"
import { bringupPads, circuitFromContract, debugPinout, debugPort, placeParts, recoveryPads, boardParts, TC2030 } from "../src/codegen/circuit.ts"
import { addedForYou } from "../src/contract/added.ts"
import { benchManifest } from "../src/contract/manifest.ts"
import { connectorsAt, minimumBoard } from "../src/contract/space.ts"
import { LOGGER_DESIGN, STM32_LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const design = (d: typeof LOGGER_DESIGN) => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(d) }
	return s
}
const end = (p: ReturnType<typeof debugPinout> extends infer T ? T : never, pin: number) => p!.pins.find((x) => x.pin === pin)!.end

test("an ESP32 board's pinout: 3V3, UART0 TX and RX, EN, GND and the boot pin", () => {
	const p = debugPinout(design(LOGGER_DESIGN))!
	assert.equal(p.standard, "tc2030-esp-uart")
	assert.deepEqual(end(p, 1), { net: "V3V3" })
	assert.deepEqual(end(p, 2), { ref: "U1", pin: "pin31" }, "TXD0 (GPIO21), a module pad the contract doesn't use")
	assert.deepEqual(end(p, 3), { net: "MCU_EN" })
	assert.deepEqual(end(p, 4), { ref: "U1", pin: "pin30" }, "RXD0 (GPIO20)")
	assert.deepEqual(end(p, 5), { net: "GND" })
	assert.deepEqual(end(p, 6), { net: "I2C_SCL" }, "GPIO9, shared with I2C_SCL on the logger, as the recovery pad")
})

test("an STM32 board's pinout is ARM's standard TC2030 SWD one: VCC, SWDIO, NRST, SWCLK, GND, SWO", () => {
	const p = debugPinout(design(STM32_LOGGER_DESIGN))!
	assert.equal(p.standard, "tc2030-swd")
	assert.deepEqual(end(p, 1), { net: "V3V3" })
	assert.deepEqual(end(p, 2), { ref: "U1", pin: "PA13" })
	assert.deepEqual(end(p, 4), { ref: "U1", pin: "PA14" })
	assert.deepEqual(end(p, 5), { net: "GND" })
	assert.ok(end(p, 3) && "pin" in end(p, 3)!, "NRST on the chip's reset pad")
	assert.ok(p.pins.every((x) => x.name))
})

test("a pin the contract gives to something else is left unconnected, not shared", () => {
	const s = design(LOGGER_DESIGN)
	s.values.pins = [...s.values.pins!, { signal: "BUZZER", gpio: 21, partRef: "U1", partPin: "GPIO21" }]
	assert.equal(end(debugPinout(s), 2), null)
	const uart = design(LOGGER_DESIGN)
	uart.values.pins = [...uart.values.pins!, { signal: "UART_TX", gpio: 21, partRef: "U1", partPin: "GPIO21" }]
	assert.deepEqual(end(debugPinout(uart), 2), { net: "UART_TX" }, "a UART signal on the console pin is the console")
})

test("the footprint lands on the underside, clear of the other pads, its holes clear of every top part", () => {
	const s = design(LOGGER_DESIGN)
	s.values.outline = { ...s.values.outline!, ...minimumBoard(s) }
	const d = debugPort(s)
	assert.ok(d.placed, "the logger's smallest board has room for it")
	const { placed } = d
	assert.equal(placed.pads.length, 6)
	assert.equal(placed.holes.length, 3)
	// Pin 1 sits beside the single hole, as in the drawing: the nearest hole to pin 1 is the lone one.
	const p1 = placed.pads.find((p) => p.pin === 1)!
	const near = placed.holes.map((h) => Math.hypot(h.x - p1.x, h.y - p1.y)).sort((a, b) => a - b)[0]
	assert.ok(Math.abs(near - Math.hypot(2.54 - 1.27, 0.635)) < 1e-6)
	const others = [...recoveryPads(s).placed, ...bringupPads(s).placed]
	for (const o of others) for (const p of placed.pads) assert.ok(Math.hypot(o.x - p.x, o.y - p.y) > 1.5, `${o.ref} clear of pad ${p.pin}`)
	for (const b of placeParts(s)) for (const h of placed.holes) assert.ok(Math.abs(h.x - b.x) > b.w / 2 + TC2030.holeDiameterMm / 2 || Math.abs(h.y - b.y) > b.h / 2 + TC2030.holeDiameterMm / 2, `hole clear of ${b.ref}`)
	const W = s.values.outline!.widthMm, H = s.values.outline!.heightMm
	for (const p of [...placed.pads, ...placed.holes]) assert.ok(Math.abs(p.x) < W / 2 && Math.abs(p.y) < H / 2)
})

test("the board gets the pads (no paste) on the bottom, the three holes, and no part in the BOM", () => {
	const s = design(LOGGER_DESIGN)
	const tsx = circuitFromContract(s)
	assert.match(tsx, /<chip name="JD1" layer="bottom"/)
	assert.equal((tsx.match(/shape="circle" radius="0.3935mm"[^>]*noSolderPaste/g) ?? []).length, 6)
	assert.equal((tsx.match(/<hole [^>]*diameter="0.991mm"/g) ?? []).length, 3)
	assert.match(tsx, /from="\.JD1 > \.pin3" to="net\.MCU_EN"/)
	assert.match(tsx, /from="\.JD1 > \.pin2" to="\.U1 > \.pin31"/)
	assert.ok(!boardParts(s).some((p) => p.ref === "JD1"), "DNL: the cable is the part, nothing is fitted")
})

test("requirements.debugPort false turns it off and gives its room back", () => {
	const s = design(LOGGER_DESIGN)
	const off = design(LOGGER_DESIGN)
	off.values.requirements = { ...off.values.requirements!, debugPort: false }
	assert.equal(debugPort(off).placed, null)
	assert.doesNotMatch(circuitFromContract(off), /JD1/)
	assert.ok(minimumBoard(s)!.areaMm2 >= minimumBoard(off)!.areaMm2)
})

test("placement reserves its spot, so every compact board has one (the connectors moved to the new size too)", () => {
	for (const d of [LOGGER_DESIGN, STM32_LOGGER_DESIGN]) {
		const s = design(d)
		const m = minimumBoard(s)!
		const r = { ...s, values: { ...s.values, outline: { ...s.values.outline!, widthMm: m.widthMm, heightMm: m.heightMm }, connectors: connectorsAt(s, m.widthMm, m.heightMm) } }
		assert.ok(debugPort(r).placed, `${d.parts.find((p) => p.role === "mcu")!.mpn} at ${m.widthMm}×${m.heightMm}`)
		assert.ok(!placeParts(r).some((p) => p.ref === "JD1"), "a reservation, not a part")
	}
})

test("the report and the bench manifest say where it is and what each pin carries", () => {
	const s = design(LOGGER_DESIGN)
	const item = addedForYou(s).find((i) => i.id === "debug-port")!
	assert.match(item.what, /TC2030/)
	assert.match(item.change, /debugPort.*false/)
	const m = benchManifest(s)!
	assert.equal(m.debug?.footprint, "Tag-Connect TC2030-IDC-NL")
	assert.equal(m.debug?.pins.length, 6)
	assert.deepEqual(m.debug?.pins.find((p) => p.pin === 3)?.net, "MCU_EN")
	assert.ok(m.debug!.xMm > 0 && m.debug!.yMm > 0)
})

test("a board built without the port (it didn't route) has no debug section in its manifest", () => {
	const s = design(LOGGER_DESIGN)
	assert.ok(benchManifest(s)!.debug)
	assert.equal(benchManifest(s, { debugPortDropped: "the board didn't route with it" })!.debug, null)
	assert.doesNotMatch(circuitFromContract(s, { debugPort: false }), /JD1/)
})

// The 60×21 rover (17 Nov 2026): 2 DRC errors whichever router routed it: JD1's unplated hole inside U5's courtyard,
// 0.14 mm from its pad 9. The placement table keeps the DRV8833's TSSOP-16 at 7.9 mm across, but its pads reach
// 9.3 mm: the holes now clear each part's own copper and courtyard extent (dualRowExtent), not its placement box.
test("the debug footprint's unplated holes clear a dual-row IC's pads and courtyard, not only its placement box", async () => {
	const { readFileSync } = await import("node:fs")
	const { dualRowExtent } = await import("../src/codegen/circuit.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/cc-rover-60x21-rev17.json", import.meta.url), "utf8"))
	const d = debugPort(s).placed!
	const u5 = placeParts(s).find((b) => b.ref === "U5")!
	const [w, h] = dualRowExtent("tssop16_w6.4mm_p0.65mm_thermalpad2.31mmx2.46mm")!
	assert.deepEqual([w, h], [9.8, 5.35])
	const [ew, eh] = Math.abs(u5.rotation) % 180 === 90 ? [h, w] : [w, h]
	for (const hole of d.holes) {
		const gap = Math.max(Math.abs(hole.x - u5.x) - ew / 2, Math.abs(hole.y - u5.y) - eh / 2) - TC2030.holeDiameterMm / 2
		assert.ok(gap >= 0.3 - 1e-9, `hole at ${hole.x},${hole.y}: ${gap.toFixed(2)} mm from U5's pads and courtyard`)
	}
})

// Real run 20b (Eurobot, 17 Nov 2026), rev 20 at 40×41 mm: tscircuit refused the board, "SMT pad U6.LED8 violates
// copper-to-board-edge clearance (measured 0.125mm, required 0.200mm)": the PCA9685's TSSOP-28 box is 7.9 mm along its
// pin rows, its pads reach 9.25 mm. The placer now keeps a part's copper and courtyard (dualRowExtent), not its box,
// EDGE margin off the edge; before, U6's copper was the 0.125 mm the build measured.
test("a dual-row IC is kept off the board edge by its pads and courtyard, not its placement box", async () => {
	const { readFileSync } = await import("node:fs")
	const { dualRowExtent, footprintFor } = await import("../src/codegen/circuit.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/cc-eurobot20b-rev20.json", import.meta.url), "utf8"))
	const o = s.values.outline
	const u6 = placeParts(s).find((b) => b.ref === "U6")!
	const [w, h] = dualRowExtent(footprintFor(s.values.parts.find((p: { ref: string }) => p.ref === "U6")))!
	const [ew, eh] = Math.abs(u6.rotation) % 180 === 90 ? [h, w] : [w, h]
	const clear = Math.min(o.widthMm / 2 - (Math.abs(u6.x) + ew / 2), o.heightMm / 2 - (Math.abs(u6.y) + eh / 2))
	assert.ok(clear >= 0.5 - 1e-9, `U6's pads and courtyard ${clear.toFixed(3)} mm from the edge`)
})
