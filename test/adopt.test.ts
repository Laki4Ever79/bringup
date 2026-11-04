import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { adopt } from "../src/adopt/cli.ts"
import { cmakeBuild, envSourceDirs, platformioVariants, sourcePins } from "../src/adopt/firmware.ts"
import { checkVariant, findMcus, namesAgree, padGpio } from "../src/adopt/match.ts"
import { boardFits, stlBox } from "../src/adopt/mech.ts"
import { nameLegacyPads, readBoard } from "../src/adopt/pcb.ts"
import { active, CondTracker, evaluate } from "../src/adopt/preproc.ts"
import { tempDir } from "./helpers.ts"

// A KiCad 6 board: an ESP32 module (U1) with named GPIO pads, an LED behind a resistor, a button, a rail sense.
const pad = (n: string, net: string, fn: string) => `(pad "${n}" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "${net}") (pinfunction "${fn}"))`
const fp = (ref: string, value: string, x: number, y: number, pads: string[]) =>
	`(footprint "lib:${value}" (layer "F.Cu") (at ${x} ${y}) (fp_text reference "${ref}" (at 0 0) (layer "F.SilkS")) (fp_text value "${value}" (at 0 0) (layer "F.Fab")) ${pads.join(" ")})`
const BOARD = `(kicad_pcb (version 20221018) (generator pcbnew)
 (gr_rect (start 0 0) (end 50 30) (layer "Edge.Cuts"))
 ${fp("U1", "ESP32-C3-MINI-1", 20, 15, [
		pad("1", "/LCD_DC", "IO1"),
		pad("2", "/LCD_RST", "IO2"),
		pad("3", "unconnected-(U1-IO3-Pad3)", "IO3"),
		pad("4", "Net-(U1-IO4)", "IO4"),
		pad("5", "FACT_RESET", "IO5"),
		pad("6", "/3V3_FUSED", "IO6"),
		pad("7", "+3V3", "IO7"),
		pad("8", "/CHG_STAT", "IO8"),
	])}
 ${fp("R1", "330", 30, 10, [pad("1", "Net-(U1-IO4)", ""), pad("2", "Net-(D1-A)", "")])}
 ${fp("D1", "LED_0603", 35, 10, [pad("1", "GND", "K"), pad("2", "Net-(D1-A)", "A")])}
 ${fp("SW1", "SW_Push", 10, 25, [pad("1", "FACT_RESET", ""), pad("2", "GND", "")])}
 ${fp("J1", "Conn", 45, 15, [pad("1", "/LCD_DC", "Pin_1"), pad("2", "/LCD_RST", "Pin_2"), pad("3", "/3V3_FUSED", "Pin_3"), pad("4", "+3V3", "Pin_4"), pad("5", "/CHG_STAT", "Pin_5")])}
)`

const pin = (name: string, gpio: number) => ({ name, gpio, file: "config.h", line: 1 })

test("adopt reads any KiCad board: outline, footprints, pad nets and pin names", () => {
	const b = readBoard(BOARD)
	assert.deepEqual(b.outline && [b.outline.widthMm, b.outline.heightMm], [50, 30])
	const u1 = b.footprints.find((f) => f.ref === "U1")!
	assert.equal(u1.pads.length, 8)
	assert.deepEqual(u1.pads[0], { number: "1", net: "/LCD_DC", fn: "IO1" })
	assert.deepEqual(findMcus(b).map((f) => f.ref), ["U1"])
})

test("a pad's GPIO comes from its pin name or, failing that, from KiCad's unconnected-net name", () => {
	assert.equal(padGpio("IO26", ""), 26)
	assert.equal(padGpio("GPIO28_ADC2", ""), 28)
	assert.equal(padGpio("IO36/SVP", ""), 36)
	assert.equal(padGpio("SENSOR_VN", ""), 39)
	assert.equal(padGpio("", "unconnected-(U1-GPIO6-Pad9)"), 6)
	assert.equal(padGpio("VDD", "+3V3"), null)
})

test("names agree across synonyms, camelCase, D+ and abbreviations, but not across different signals", () => {
	assert.ok(namesAgree("TFT_DC", "/LCD_CMD"))
	assert.ok(namesAgree("PIN_MT_CSN", "/MAG_CSN"))
	assert.ok(namesAgree("PIO_USB_DP_PIN", "/AD+"))
	assert.ok(namesAgree("kRelayFanPin", "RELAY_FAN"))
	assert.ok(namesAgree("I2S_SD", "/MIC_DATA"))
	assert.ok(!namesAgree("PIN_LCD_DATACMD", "TFT_~{RST}"))
})

test("each firmware pin is checked on the board: agreement, swaps, unconnected pads, rails, and evidence beyond names", () => {
	const b = readBoard(BOARD)
	const checks = checkVariant(b, findMcus(b), {
		id: "env:x",
		pins: [pin("PIN_LCD_DC", 1), pin("PIN_LCD_RST", 1), pin("PIN_ROT_A", 3), pin("PIN_LED", 4), pin("PIN_BUTTON", 5), pin("PIN_3V3_FUSED", 6), pin("PIN_SPEAKER", 7), pin("PIN_LCD_BL", 30)],
	})
	const v = Object.fromEntries(checks.map((c) => [c.pin.name, c.verdict]))
	assert.equal(v.PIN_LCD_DC, "agrees")
	// GPIO1 is LCD_DC on the board: firmware calling it RST is a swap a person must look at.
	assert.equal(v.PIN_LCD_RST, "name-differs")
	assert.equal(v.PIN_ROT_A, "unconnected")
	// Behind R1 sits an LED: the part, not the unnamed net, says what the pin is.
	assert.equal(v.PIN_LED, "agrees")
	// FACT_RESET reaches SW1, a button.
	assert.equal(v.PIN_BUTTON, "agrees")
	// A GPIO on a rail is fine when the firmware says it senses that rail, wrong otherwise.
	assert.equal(v.PIN_3V3_FUSED, "agrees")
	assert.equal(v.PIN_SPEAKER, "power")
	assert.equal(v.PIN_LCD_BL, "not-on-pads")
})

test("a per-revision pin whose sibling fits this board is the other revision's, not a fault", () => {
	const b = readBoard(BOARD)
	const checks = checkVariant(b, findMcus(b), { id: "x", pins: [pin("CHG_STAT_REV20", 3), pin("CHG_STAT_REV21", 8)] })
	assert.deepEqual(checks.map((c) => c.verdict), ["other-revision", "agrees"])
})

test("one binary on two MCUs: each pin is checked on every MCU and keeps the best fit", () => {
	const two = `(kicad_pcb (version 20221018)
 ${fp("U1", "Pico", 0, 0, [pad("16", "/UART A TX", "GPIO12"), pad("21", "unconnected-(U1-GPIO16-Pad21)", "GPIO16"), ...Array.from({ length: 6 }, (_, i) => pad(`${30 + i}`, "", `GPIO${i}`))])}
 ${fp("U2", "Pico", 0, 0, [pad("16", "unconnected-(U2-GPIO12-Pad16)", "GPIO12"), pad("21", "/UART B TX", "GPIO16"), ...Array.from({ length: 6 }, (_, i) => pad(`${30 + i}`, "", `GPIO${i}`))])}
 ${fp("U4", "ADuM1201", 0, 0, [pad("7", "/UART A TX", "VIA"), pad("3", "/UART B TX", "VIB")])}
)`
	const b = readBoard(two)
	const checks = checkVariant(b, findMcus(b), { id: "src", pins: [pin("BOARD_A_TX", 12), pin("BOARD_B_TX", 16), pin("GPIO_LED_PIN", 25)] })
	assert.deepEqual(checks.map((c) => [c.mcu, c.verdict]), [["U1", "agrees"], ["U2", "agrees"], ["U1", "inside-module"]])
})

test("platformio.ini: one variant per env, extends and ${sec.key} resolved, later -D wins, source dirs from the filter", () => {
	const ini = `[platformio]
src_dir = firmware/src
include_dir = firmware/include

[base]
platform = espressif32
build_flags =
  -DPIN_LED=5
  -DTFT_CS=21
build_src_filter = +<*> +<../esp32/core>

[env:a]
extends = base
build_flags =
  \${base.build_flags}
  -DPIN_LED=7
  -DBOARD_A

[env:b]
extends = base
build_src_filter = \${base.build_src_filter} +<../esp32/b>
`
	const vs = platformioVariants(ini, "platformio.ini")
	assert.deepEqual(vs.map((v) => v.id), ["env:a", "env:b"])
	assert.deepEqual(vs[0].pins.map((p) => [p.name, p.gpio]), [["PIN_LED", 7], ["TFT_CS", 21]])
	assert.equal(vs[0].family, "esp32")
	assert.equal(vs[0].defines?.get("BOARD_A"), "1")
	assert.deepEqual(envSourceDirs(ini, "platformio.ini", "env:b").sort(), ["firmware/esp32/b", "firmware/esp32/core", "firmware/include", "firmware/src"])
})

test("source pins: defines and constants, GPIO_NUM proves a pin whatever its name, index runs and expander pins are not pins", () => {
	const src = `#define PIN_LED 5
#define NES_LATCH GPIO_NUM_25
static constexpr uint8_t BUTTON_A = 0;
static constexpr uint8_t BUTTON_B = 1;
static constexpr uint8_t BUTTON_SELECT = 2;
static constexpr uint8_t BUTTON_START = 3;
#define MCP_PIN_CLAMP 12
#define PIN_MCP_NRESET 26
#define SPI_FREQUENCY 40
const int kWaterPin = 10;`
	assert.deepEqual(sourcePins(src, "f.h").map((p) => [p.name, p.gpio]), [["PIN_LED", 5], ["NES_LATCH", 25], ["PIN_MCP_NRESET", 26], ["kWaterPin", 10]])
})

test("#if conditions are recorded per line and evaluated per build, three-valued", () => {
	const t = new CondTracker()
	const lines = ["#ifndef GUARD_H", "#define GUARD_H", "#if defined(__AVR__)", "#define A 1", "#elif defined(ESP32)", "#define B 2", "#else", "#define C 3", "#endif"]
	const conds: Record<string, ReturnType<CondTracker["conds"]>> = {}
	lines.forEach((l, i) => {
		if (!t.line(l, lines[i + 1] ?? "")) conds[l] = t.conds()
	})
	// The include guard adds nothing.
	assert.deepEqual(conds["#define GUARD_H"], [])
	const esp32 = { defines: new Map<string, string>(), family: "esp32" as const }
	assert.equal(active(conds["#define A 1"], esp32), false)
	assert.equal(active(conds["#define B 2"], esp32), true)
	assert.equal(active(conds["#define C 3"], esp32), false)
	// Without a family, nothing can be decided.
	assert.equal(active(conds["#define B 2"], { defines: new Map(), family: null }), undefined)
	assert.equal(evaluate("SPI_IO && !defined(X)", { defines: new Map([["SPI_IO", "true"]]), family: null }), undefined)
	// A build selector another env passes is undefined in this one.
	assert.equal(evaluate("defined(BOARD_REV4)", { defines: new Map([["BOARD_REV123", "1"]]), family: null, selectors: new Set(["BOARD_REV4", "BOARD_REV123"]) }), 0)
})

test("CMake compile definitions are build pins, with ${VAR} expanded and the right line", () => {
	const cm = `cmake_minimum_required(VERSION 3.13)
# a comment
set(DP_PIN_DEFAULT 14 CACHE STRING "D+")
set(PICO_BOARD "pico")
target_compile_definitions(app PRIVATE
    PIO_USB_DP_PIN_DEFAULT=\${DP_PIN_DEFAULT}
    PICO_DEFAULT_UART=0
)`
	const r = cmakeBuild(cm, "CMakeLists.txt")
	assert.deepEqual(r.pins.map((p) => [p.name, p.gpio, p.line]), [["PIO_USB_DP_PIN_DEFAULT", 14, 6]])
	assert.equal(r.family, "rp2040")
})

test("KiCad 5 boards get pin names from the project's schematic and symbol cache", () => {
	const b = readBoard(`(kicad_pcb (version 20171130) (module lib:TDisplay (at 0 0) (fp_text reference U1 (at 0 0) (layer F.SilkS)) (fp_text value TTGO_TDisplay (at 0 0) (layer F.Fab)) (pad 7 thru_hole circle (at 0 0) (size 1 1) (layers *.Cu) (net 3 /LATCH))))`)
	const named = nameLegacyPads(b, ["$Comp\nL ESP32Modules:TTGO_TDisplay U1\n$EndComp"], "DEF ESP32Modules_TTGO_TDisplay U 0 40 Y Y 1 F N\nDRAW\nX IO25 7 -400 0 100 R 50 50 1 1 B\nENDDRAW\nENDDEF")
	assert.equal(named, 1)
	assert.equal(b.footprints[0].pads[0].fn, "IO25")
	assert.equal(padGpio(b.footprints[0].pads[0].fn, ""), 25)
})

test("the case check reads an STL's bounding box and fits the board flat on any face", () => {
	const dir = tempDir()
	const tri = (z: number) => `facet normal 0 0 1\nouter loop\nvertex 0 0 ${z}\nvertex 60 0 ${z}\nvertex 0 40 ${z}\nendloop\nendfacet`
	writeFileSync(join(dir, "case.stl"), `solid c\n${tri(0)}\n${tri(12)}\nendsolid c`)
	const box = stlBox(join(dir, "case.stl"))!
	assert.deepEqual(box, { x: 60, y: 40, z: 12 })
	assert.deepEqual(boardFits(50, 30, box), { fits: true, marginMm: 10 })
	assert.equal(boardFits(70, 30, box).fits, false)
})

test("adopt on a repo: pairs each board with the firmware build that explains it, and never writes into the repo", () => {
	const repo = tempDir()
	mkdirSync(join(repo, "hw"), { recursive: true })
	mkdirSync(join(repo, "src"), { recursive: true })
	writeFileSync(join(repo, "hw", "b.kicad_pcb"), BOARD)
	writeFileSync(join(repo, "platformio.ini"), "[env:right]\nplatform = espressif32\nbuild_flags = -DPIN_LCD_DC=1 -DPIN_BUTTON=5\n\n[env:wrong]\nplatform = espressif32\nbuild_flags = -DPIN_LCD_DC=3 -DPIN_BUTTON=7\n")
	writeFileSync(join(repo, "src", "main.cpp"), "int main() { return PIN_LCD_DC + PIN_BUTTON; }\n")
	const listing = () => readdirSync(repo, { recursive: true }).map(String).sort()
	const before = listing()
	const r = adopt(repo)
	assert.deepEqual(listing(), before)
	assert.equal(r.boards.length, 1)
	assert.equal(r.boards[0].variant?.id, "env:right")
	assert.ok(r.boards[0].checks.every((c) => c.verdict === "agrees"))
	assert.ok(r.boards[0].inferred.pins.some((p) => p.signal === "LCD_DC" && p.gpio === 1 && p.partRef === "U1"))
})
