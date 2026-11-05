import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { adopt } from "../src/adopt/cli.ts"
import { cmakeBuild, envSourceDirs, firmwareVariants, iocPins, platformioVariants, sourcePins } from "../src/adopt/firmware.ts"
import { checkVariant, chipPin, findMcus, gpioOfPad, namesAgree, padGpio } from "../src/adopt/match.ts"
import { ANALOG_BASE, pinLabel } from "../src/adopt/pins.ts"
import { checkAgainst, signalName, writeContracts } from "../src/adopt/contract.ts"
import { boardFits, stlBox } from "../src/adopt/mech.ts"
import { nameLegacyPads, readBoard } from "../src/adopt/pcb.ts"
import { active, CondTracker, evaluate } from "../src/adopt/preproc.ts"
import { ROOT } from "../src/run.ts"
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

test("KiCad 10 pin names lose the pad-number suffix it adds (PC13_2 on pad 2 is PC13)", () => {
	const b = readBoard(`(kicad_pcb (version 20260206) ${fp("U1", "STM32F103C8Tx", 0, 0, [pad("2", "/LED", "PC13_2"), pad("34", "/A", "GPIO28_ADC2")])})`)
	assert.deepEqual(b.footprints[0].pads.map((p) => p.fn), ["PC13", "GPIO28_ADC2"])
	assert.equal(pinLabel(padGpio("PC13", "")!), "PC13")
})

test("a dev board's pads (D6, TX/D6) map to GPIOs through arduino-esp32's variant table", () => {
	const xiao = fp("U1", "113991254", 0, 0, ["D0", "D1", "D2", "D3", "D4", "TX/D6"].map((n, i) => pad(`${i + 1}`, `/${n.split("/").pop()}`, n)))
	const b = readBoard(`(kicad_pcb (version 20221018) ${xiao})`)
	const u1 = b.footprints[0]
	assert.deepEqual(u1.pads.map((p) => gpioOfPad(u1, p)), [0, 1, 2, 21, 22, 16])
	// Its own LED (LED_BUILTIN, GPIO15) is on no pad but is on the board.
	const [c] = checkVariant(b, findMcus(b), { id: "x", pins: [pin("STATUS_LED", 15)] })
	assert.equal(c.verdict, "inside-module")
})

test("STM32: CubeMX .ioc labels and signals, and main.h's _Pin/_GPIO_Port pairs, are port pins", () => {
	const ioc = "PA5.Signal=SPI1_SCK\nPC13-TAMPER-RTC.GPIO_Label=MCU_STATE\nPC13-TAMPER-RTC.Signal=GPIO_Output\nPA8.Signal=GPXTI8\n"
	assert.deepEqual(iocPins(ioc, "x.ioc").map((p) => [p.name, pinLabel(p.gpio)]).sort(), [["MCU_STATE", "PC13"], ["SPI1_SCK", "PA5"]])
	const mainH = "#define LED_Pin GPIO_PIN_13\n#define LED_GPIO_Port GPIOC\n#define BTN PA0\n"
	assert.deepEqual(sourcePins(mainH, "main.h").map((p) => [p.name, pinLabel(p.gpio)]).sort(), [["BTN", "PA0"], ["LED", "PC13"]])
})

test("STM32 clock: crystal mode configured but OSC_IN driven by an oscillator is reported as needing HSE bypass", () => {
	const b = readBoard(`(kicad_pcb (version 20221018)
 ${fp("U1", "STM32F103C8Tx", 0, 0, [pad("5", "/XTAL0", "PD0"), pad("6", "unconnected-(U1-PD1-Pad6)", "PD1"), ...Array.from({ length: 6 }, (_, i) => pad(`${10 + i}`, "", `PA${i}`))])}
 ${fp("R1", "10", 0, 0, [pad("1", "/XTAL0", ""), pad("2", "Net-(Y1-OUT)", "")])}
 ${fp("Y1", "SG-8002CA", 0, 0, [pad("3", "Net-(Y1-OUT)", "OUT"), pad("2", "GND", "GND")]).replace("lib:SG-8002CA", "Oscillator:SG8002")}
)`)
	const checks = checkVariant(b, findMcus(b), { id: "ioc", pins: [pin("RCC_OSC_IN", padGpio("PD0", "")!), pin("RCC_OSC_OUT", padGpio("PD1", "")!)] })
	assert.equal(checks[1].verdict, "clock-mode")
	assert.match(checks[1].net, /RCC_HSE_BYPASS/)
})

test("UART lines cross: the MCU's TX on the peer's RXD agrees, on the peer's TXD it doesn't", () => {
	const board = (peerPin: string) =>
		readBoard(`(kicad_pcb (version 20221018) ${fp("U1", "ESP32", 0, 0, [pad("1", "/GNSS_LINK", "IO1"), ...Array.from({ length: 6 }, (_, i) => pad(`${10 + i}`, "", `IO${20 + i}`))])} ${fp("U2", "NEO-M8", 0, 0, [pad("1", "/GNSS_LINK", peerPin)])})`)
	const verdict = (peerPin: string) => checkVariant(board(peerPin), findMcus(board(peerPin)), { id: "x", pins: [pin("USART2_TX", 1)] })[0].verdict
	assert.equal(verdict("RXD/SPI_MOSI"), "agrees")
	assert.equal(verdict("TXD/SPI_MISO"), "name-differs")
})

test("#ifndef X / #define X 14 is a default, not an include guard; a pin whose uses are all compiled out is unused", () => {
	const src = `#ifndef CONFIG_H
#define CONFIG_H
#ifndef MIC_PIN
#define MIC_PIN 14
#endif
#endif`
	const [p] = sourcePins(src, "config.h")
	assert.equal(p.name, "MIC_PIN")
	assert.equal(p.conds, undefined)
	const repo = tempDir()
	mkdirSync(join(repo, "src"), { recursive: true })
	writeFileSync(join(repo, "src", "config.h"), `${src}\n#ifndef ENABLE_MIC\n#define ENABLE_MIC 0\n#endif\n`)
	writeFileSync(join(repo, "src", "main.cpp"), "#if ENABLE_MIC\nvoid mic() { pinMode(MIC_PIN, INPUT); }\n#endif\n")
	writeFileSync(join(repo, "platformio.ini"), "[env:off]\nplatform = espressif32\n\n[env:on]\nplatform = espressif32\nbuild_flags = -DENABLE_MIC=1\n")
	const b = readBoard(BOARD)
	const vs = firmwareVariants(repo)
	const unused = (id: string) => checkVariant(b, findMcus(b), vs.find((v) => v.id === id)!).find((c) => c.pin.name === "MIC_PIN")!.pin.unused
	assert.equal(unused("env:off"), true)
	assert.equal(unused("env:on"), false)
})

test("contract signal names are UPPER_SNAKE from net names", () => {
	assert.equal(signalName("/MCU Controller/MCU_SCLK"), "MCU_SCLK")
	assert.equal(signalName("TFT_~{RST}"), "TFT_RST")
	assert.equal(signalName("UART A TX"), "UART_A_TX")
	assert.equal(signalName("/AD+"), "AD_P")
	assert.equal(signalName("3V3_SENSE"), "N_3V3_SENSE")
})

test("adopt → contract: Bringup's own contract accepts it, and the repo checks clean against it until a domain moves", () => {
	const repo = tempDir()
	mkdirSync(join(repo, "hw"), { recursive: true })
	mkdirSync(join(repo, "src"), { recursive: true })
	writeFileSync(join(repo, "hw", "b.kicad_pcb"), BOARD)
	writeFileSync(join(repo, "platformio.ini"), "[env:x]\nplatform = espressif32\nbuild_flags = -DPIN_LCD_DC=1 -DPIN_LCD_RST=2 -DPIN_LED=4\n")
	writeFileSync(join(repo, "src", "main.cpp"), "int main() { return PIN_LCD_DC + PIN_LCD_RST + PIN_LED; }\n")
	const dir = join(tempDir(), "contract")
	const [w] = writeContracts(repo, [join(repo, "hw", "b.kicad_pcb")], dir)
	assert.deepEqual(w.inferred.refused, [])
	const v = w.inferred.snapshot.values
	assert.deepEqual(v.outline, { widthMm: 50, heightMm: 30, thicknessMm: 1.6 })
	assert.equal(v.parts?.find((p) => p.role === "mcu")?.ref, "U1")
	// The LED is behind R1: the contract names the LED, and the check joins the resistor's two nets.
	assert.deepEqual(v.pins?.find((p) => p.gpio === 4), { signal: "PIN_LED", gpio: 4, partRef: "D1", partPin: "A" })
	assert.deepEqual(v.pins?.find((p) => p.gpio === 1), { signal: "LCD_DC", gpio: 1, partRef: "J1", partPin: "Pin_1" })
	assert.equal(w.inferred.links.signals.LCD_DC.firmware?.name, "PIN_LCD_DC")
	assert.deepEqual(checkAgainst(repo, dir).map((r) => [r.violations, r.changes]), [[[], []]])

	// The board swaps DC and RST; the firmware is left as it was.
	writeFileSync(join(repo, "hw", "b.kicad_pcb"), BOARD.replace('(net 1 "/LCD_DC") (pinfunction "IO1")', '(net 1 "/LCD_RST") (pinfunction "IO1")').replace('(net 1 "/LCD_RST") (pinfunction "IO2")', '(net 1 "/LCD_DC") (pinfunction "IO2")'))
	const [r] = checkAgainst(repo, dir)
	assert.deepEqual(r.violations.map((x) => x.kind).sort(), ["net-missing", "net-missing"])
	assert.ok(r.changes.some((c) => c.what === "LCD_DC moved: GPIO1 → GPIO2"))
	assert.ok(r.changes.some((c) => /the board moved LCD_DC to GPIO2, but the firmware still drives it on GPIO1 \(PIN_LCD_DC, platformio.ini:3\)/.test(c.what)))

	// Then the firmware follows; only the (now agreed) board change remains, as a change, with nothing left behind.
	writeFileSync(join(repo, "platformio.ini"), "[env:x]\nplatform = espressif32\nbuild_flags = -DPIN_LCD_DC=2 -DPIN_LCD_RST=1 -DPIN_LED=4\n")
	const [r2] = checkAgainst(repo, dir)
	assert.ok(!r2.changes.some((c) => /still drives/.test(c.what)))
	assert.ok(r2.violations.some((x) => x.kind === "pin-mismatch" && /LCD_DC on GPIO2, contract says GPIO1/.test(x.message)))
})

test("the CI check (adopt/check.sh, as the Action runs it): passes with no contract, fails a change that breaks it, passes once it is re-agreed", () => {
	const repo = tempDir()
	mkdirSync(join(repo, "hw"), { recursive: true })
	mkdirSync(join(repo, "src"), { recursive: true })
	writeFileSync(join(repo, "hw", "b.kicad_pcb"), BOARD)
	writeFileSync(join(repo, "platformio.ini"), "[env:x]\nplatform = espressif32\nbuild_flags = -DPIN_LCD_DC=1\n")
	writeFileSync(join(repo, "src", "main.cpp"), "int main() { return PIN_LCD_DC; }\n")
	const summary = join(repo, "summary.md")
	const ci = () => {
		writeFileSync(summary, "")
		const r = spawnSync("bash", [join(ROOT, "adopt", "check.sh")], {
			env: { ...process.env, GITHUB_ACTION_PATH: join(ROOT, "adopt"), GITHUB_WORKSPACE: repo, GITHUB_STEP_SUMMARY: summary, INPUT_PATH: ".", INPUT_CONTRACT: ".bringup/adopt" },
			encoding: "utf8",
		})
		return { code: r.status, md: readFileSync(summary, "utf8") }
	}
	const first = ci()
	assert.equal(first.code, 0)
	assert.match(first.md, /No agreed contract in `\.bringup\/adopt` yet/)
	writeContracts(repo, [join(repo, "hw", "b.kicad_pcb")], join(repo, ".bringup", "adopt"))
	assert.match(ci().md, /✓ Every board matches the agreed contract/)
	writeFileSync(join(repo, "platformio.ini"), "[env:x]\nplatform = espressif32\nbuild_flags = -DPIN_LCD_DC=2\n")
	const broken = ci()
	assert.equal(broken.code, 1)
	assert.match(broken.md, /✗ \*\*pin-mismatch\*\*: firmware drives LCD_DC on GPIO2, contract says GPIO1/)
})

test("AVR: Arduino pin numbers and A0 resolve through ArduinoCore-avr's tables; PB5 is an AVR pin on an ATmega only", () => {
	const uno = { ref: "U1", value: "ATmega328P-AU", lib: "Package_QFP:TQFP-32", x: 0, y: 0, rot: 0, pads: [], size: { w: 0, h: 0 } }
	const leo = { ...uno, value: "ATmega32U4-AU" }
	assert.equal(pinLabel(chipPin(uno, 13)), "PB5")
	assert.equal(pinLabel(chipPin(uno, ANALOG_BASE)), "PC0")
	// The Leonardo's table is scrambled: Arduino D0 is PD2.
	assert.equal(pinLabel(chipPin(leo, 0)), "PD2")
	// A firmware PB5 (read as an STM32-style port) is the ATmega's PB5.
	assert.equal(pinLabel(chipPin(uno, padGpio("PB5", "")!)), "PB5")
	assert.equal(pinLabel(gpioOfPad(uno, { fn: "PB5", net: "/LED" })!), "PB5")
	// Elsewhere PB5 stays an STM32 port pin.
	assert.equal(padGpio("PB5", "")! < 2000, true)
})

test("AVR: an Arduino Nano footprint's D13/A0 pads, an Arduino sketch's pins, and the chip macro deciding #if", () => {
	const nano = fp("A1", "Arduino_Nano", 0, 0, ["D13", "A0", "D2", "D3", "D4", "D5", "D6"].map((n, i) => pad(`${i + 1}`, i === 0 ? "/LED" : i === 1 ? "/NTC" : "", n)))
	const b = readBoard(`(kicad_pcb (version 20221018) ${nano} ${fp("D1", "LED", 0, 0, [pad("1", "/LED", "A")])} ${fp("TH1", "NTC", 0, 0, [pad("1", "/NTC", "1")])})`)
	const src = `#if defined(__AVR_ATmega328P__)
const int LED_PIN = 13;
#define NTC_PIN A0
#elif defined(__AVR_ATmega2560__)
const int LED_PIN = 52;
#endif`
	const checks = checkVariant(b, findMcus(b), { id: "src", pins: sourcePins(src, "sketch.ino") })
	assert.deepEqual(checks.map((c) => [c.pin.name, c.pin.as, pinLabel(c.pin.gpio), c.verdict]), [
		["LED_PIN", "13", "PB5", "agrees"],
		["NTC_PIN", "A0", "PC0", "agrees"],
	])
})
