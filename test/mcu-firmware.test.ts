// The firmware side of MCU profiles (docs/mcu.md, Firmware): pins.h spelled for the chip's core, read back as indexes,
// and the PlatformIO envs a profile builds under.
import { test } from "node:test"
import assert from "node:assert/strict"
import { connectivityHeader, historyBytes, linkHeader, parsePinsHeader, pinsHeader } from "../src/codegen/firmware.ts"
import { chipPartPins } from "../src/mcu/board.ts"
import { envFor, platformioEnvs } from "../src/mcu/firmware.ts"
import { profileById } from "../src/mcu/profile.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const stm = profileById("stm32g031k8t6")!
const esp = profileById("esp32-c3-mini-1")!

// The fixture's logger on an STM32G031K8: SHT40 on I2C1 (PB7 SDA = 23, PB6 SCL = 22), LED on PA5.
function stmContract(): ContractSnapshot {
	const s = fixtureContract()
	s.values.parts = s.values.parts!.map((p) => (p.role === "mcu" ? { ...p, mpn: "STM32G031K8T6", lcsc: null, footprint: "", pins: chipPartPins(stm) } : p))
	s.values.pins = [
		{ signal: "I2C_SDA", gpio: 23, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 22, partRef: "U2", partPin: "SCL" },
		{ signal: "STATUS_LED", gpio: 5, partRef: "D1", partPin: "A" },
	]
	return s
}

test("an STM32 pins.h spells pins as STM32duino does and names the console UART", () => {
	const h = pinsHeader(stmContract())
	assert.match(h, /^#define PIN_I2C_SDA PB7$/m)
	assert.match(h, /^#define PIN_I2C_SCL PB6$/m)
	assert.match(h, /^#define PIN_STATUS_LED PA5$/m)
	assert.match(h, /^#define BRINGUP_CONSOLE_TX PA2$/m)
	assert.match(h, /^#define BRINGUP_CONSOLE_RX PA3$/m)
	assert.match(h, /^#define BRINGUP_CONSOLE_INSTANCE USART2$/m)
	assert.match(h, /^#define HISTORY_BYTES \d+/m)
})

test("parsePinsHeader reads named pins back as the contract's indexes", () => {
	const pins = parsePinsHeader(pinsHeader(stmContract()))
	assert.equal(pins.I2C_SDA, 23)
	assert.equal(pins.I2C_SCL, 22)
	assert.equal(pins.STATUS_LED, 5)
	assert.equal(pins.CONSOLE_TX, undefined)
})

test("the history is capped to what the chip's store holds, and the header says so", () => {
	const s = stmContract()
	s.values.requirements = { ...s.values.requirements!, historyDays: 30, dutyCycle: { periodS: 3600, activeMs: 300 } as never }
	const h = pinsHeader(s)
	// The profile's store (1024 B by default) less hal.h's 64 B of key slots, 4 B a reading, one an hour.
	const bytes = historyBytes(stm)
	assert.equal(bytes, (stm.firmware.history?.bytes ?? 1024) - 64)
	const readings = bytes / 4
	assert.match(h, new RegExp(`^#define HISTORY_BYTES ${bytes}\\b`, "m"))
	assert.match(h, new RegExp(`holds ${readings} readings \\(${readings} h at one every 3600 s\\), not 30 days: capped`))
	assert.match(h, new RegExp(`^#define HISTORY_DAYS ${Math.floor(readings / 24)}$`, "m"))
})

test("a chip without a radio gets RADIO_NONE, never the BLE default", () => {
	const h = connectivityHeader(stmContract())
	assert.match(h, /^#define RADIO_NONE 1$/m)
	assert.doesNotMatch(h, /RADIO_BLE|REPORT_/)
})

test("envs: the ESP32-C3 keeps its names, other chips are named by their id", () => {
	assert.equal(envFor(stm, "app"), "stm32g031k8t6")
	assert.equal(envFor(stm, "linktest"), "stm32g031k8t6_linktest")
	assert.equal(envFor(esp, "test"), "esp32c3_test")
	assert.equal(envFor(esp, "app"), "esp32c3")
	assert.equal(envFor(null, "collect"), "esp32c3_collect")
})

test("platformioEnvs writes the profile's board and platform, with hal.h's libraries pinned", () => {
	const ini = platformioEnvs(stm)
	assert.match(ini, /^\[env:stm32g031k8t6\]$/m)
	assert.match(ini, /^\[env:stm32g031k8t6_linktest\]$/m)
	assert.match(ini, /^board = nucleo_g031k8$/m)
	assert.match(ini, new RegExp(`^platform = ${stm.firmware.platform.replace(/[.@]/g, "\\$&")}$`, "m"))
	assert.match(ini, /^framework = arduino$/m)
	assert.match(ini, /STM32duino Low Power@\d+\.\d+\.\d+/)
	assert.match(ini, /-DLINK_TEST=1/)
	// Only exact versions.
	for (const m of ini.matchAll(/^ {4}(\S.*@.*)$/gm)) assert.match(m[1], /@\d+\.\d+\.\d+$/)
})

test("an ESP32 contract's pins.h is what it always was", () => {
	const h = pinsHeader(fixtureContract())
	assert.doesNotMatch(h, /BRINGUP_CONSOLE|HISTORY_BYTES|P[A-K]\d/)
	for (const p of fixtureContract().values.pins!) assert.match(h, new RegExp(`^#define PIN_${p.signal} ${p.gpio}$`, "m"))
})

test("link.h on an STM32 opens its UART on the link's pins and sets the I2C pins before begin()", () => {
	const s = stmContract()
	s.values.pins!.push({ signal: "L1_TX", gpio: 9, partRef: "J2", partPin: "1" }, { signal: "L1_RX", gpio: 10, partRef: "J2", partPin: "2" })
	s.values.links = [{ id: "L1", kind: "uart", peer: "b", connector: "J2", baud: 115200, messages: [{ name: "reading", dir: "send", hash: "0123456789abcdef", fields: [{ name: "tempCx100", type: "i16" }] }] }] as never
	const h = linkHeader(s)
	assert.match(h, /static HardwareSerial LinkSerial\(PIN_L1_RX, PIN_L1_TX\);/)
	assert.match(h, /LinkSerial\.begin\(LINK_L1_BAUD, SERIAL_8N1\);/)
	assert.match(h, /linkFrameWrite\(LinkSerial,/)
	assert.doesNotMatch(h, /Serial1/)

	const t = stmContract()
	t.values.links = [{ id: "L2", kind: "i2c", peer: "a", connector: "J3", i2c: { role: "target", khz: 100, address: 0x42 }, messages: [] }] as never
	const i2c = linkHeader(t)
	assert.match(i2c, /Wire\.setSDA\(PIN_I2C_SDA\);\n\tWire\.setSCL\(PIN_I2C_SCL\);\n\tWire\.begin\(\(uint8_t\)LINK_L2_I2C_ADDRESS\);/)
	// The ESP32 keeps its four-argument begin.
	assert.match(linkHeader({ ...t, values: { ...t.values, parts: fixtureContract().values.parts } }), /Wire\.begin\(\(uint8_t\)LINK_L2_I2C_ADDRESS, PIN_I2C_SDA, PIN_I2C_SCL,/)
})
