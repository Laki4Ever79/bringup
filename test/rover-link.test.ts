// A rover that is one board of a system talks to the others over its links (bringup-lead, 14 Nov 2026: the rover +
// climate robot never settled; the rover template had no link code and hw_pins.h no link pins, so pin-mismatch "L1_TX on
// ?" stood for good). The rover gets the same link.h and frame code as the logger firmware.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { roverHeader } from "../src/mechanics/firmware.ts"
import { prepareFirmware } from "../src/tools/firmware.ts"
import { parsePinsHeader } from "../src/codegen/firmware.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import { boardLinks } from "../src/system/derive.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { tempDir, slow } from "./helpers.ts"

const ROOT = resolve(import.meta.dirname, "..")
const pio = join(ROOT, ".venv/bin/pio")
const spec: SystemSpec = {
	name: "rover and climate",
	boards: [{ name: "main", brief: "rover.md" }, { name: "climate", brief: "logger.md" }],
	links: [{ id: "L1", kind: "uart", a: { board: "climate" }, b: { board: "main" }, baud: 115200, cable: { lengthMm: 300 }, messages: [{ name: "reading", from: "climate", fields: [{ name: "tempCx100", type: "i16" }, { name: "rhx100", type: "u16" }] }] }],
} as SystemSpec
const rover = (): ContractSnapshot => {
	const s: ContractSnapshot = { revision: 20, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) }
	s.values.links = boardLinks(spec, "main")
	s.values.pins = [...s.values.pins!, { signal: "L1_TX", gpio: 3, partRef: "JL1", partPin: "IO2" }, { signal: "L1_RX", gpio: 1, partRef: "JL1", partPin: "IO1" }]
	return s
}

test("the rover header names its link pins as the product firmware does, so the firmware checks see them", () => {
	const s = rover()
	const h = roverHeader(s)
	assert.match(h, /#define PIN_L1_TX 3\n/)
	assert.match(h, /#define PIN_L1_RX 1\n/)
	const firmware = { revision: 20, ok: true, pins: parsePinsHeader(h), sensor: "SHT40", log: "" }
	assert.ok(!checkConsistency(s, { firmware } as never).some((v) => v.kind === "pin-mismatch"))
})

test("a rover in a system gets link.h and the frame code, and its loop starts, polls and sends on the link", async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, rover())
	assert.match(readFileSync(join(dir, "include/link.h"), "utf8"), /Serial1\.begin\(LINK_L1_BAUD, SERIAL_8N1, PIN_L1_RX, PIN_L1_TX\)/)
	assert.equal(readFileSync(join(dir, "include/linkframe.h"), "utf8"), readFileSync(join(ROOT, "templates/fw/include/linkframe.h"), "utf8"))
	const main = readFileSync(join(dir, "src/main.cpp"), "utf8")
	assert.match(main, /linkBegin\(\)/)
	assert.match(main, /linkPoll\(0\)/)
	assert.match(main, /linkSendReading\(ok, t, rh\)/)
})

// The system's link test runs each board's link-test build in QEMU, joined by a virtual cable (src/system/linktest.ts);
// the rover had no such build ("Unknown environment names 'esp32c3_linktest'", 14 Nov 2026).
test("the rover has the link-test builds the system's link test runs, QEMU and bench", async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, rover())
	const ini = readFileSync(join(dir, "platformio.ini"), "utf8")
	assert.match(ini, /\[env:esp32c3_linktest\][^[]*-DLINK_TEST=1/)
	assert.match(ini, /\[env:esp32c3_linktest_usb\][^[]*-DLINK_TEST_FOREVER=1/)
	assert.match(readFileSync(join(dir, "src/main.cpp"), "utf8"), /#ifdef LINK_TEST[\s\S]*linkSendReading\(true, 21\.5f, 40\.25f\)[\s\S]*LINK TEST DONE/)
})

test("a rover with no links still gets a link.h, with stubs", async () => {
	const dir = tempDir()
	const s = rover()
	s.values.links = []
	s.values.pins = s.values.pins!.filter((p) => !p.signal.startsWith("L1_"))
	await prepareFirmware(ROOT, dir, s)
	assert.match(readFileSync(join(dir, "include/link.h"), "utf8"), /#define LINK_COUNT 0/)
})

test("a rover with a UART link compiles: the board, the simulation and the link-test builds", { skip: slow || (existsSync(pio) ? false : "needs PlatformIO"), timeout: 900_000 }, async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, rover())
	const r = spawnSync(pio, ["run", "-d", dir, "-e", "esp32c3", "-e", "esp32c3_sim", "-e", "esp32c3_linktest"], { encoding: "utf8" })
	assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000))
})

// The rover as the controller of an I2C link: the link shares the bus its sensors are on (one Wire, begun by
// hw_begin before linkBegin), and reads the target's frame on that bus.
const i2cSpec: SystemSpec = {
	name: "rover and a beacon",
	boards: [{ name: "main", brief: "rover.md" }, { name: "beacon", brief: "beacon.md" }],
	links: [{ id: "L1", kind: "i2c", a: { board: "beacon" }, b: { board: "main" }, i2c: { controller: "main", targets: { beacon: 0x42 }, pullupsOn: "main" }, cable: { lengthMm: 150 }, messages: [{ name: "reading", from: "beacon", fields: [{ name: "tempCx100", type: "i16" }] }] }],
} as SystemSpec
const i2cRover = (): ContractSnapshot => {
	const s: ContractSnapshot = { revision: 20, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) }
	s.values.links = boardLinks(i2cSpec, "main")
	const bus = s.values.pins!.filter((p) => p.signal === "I2C_SDA" || p.signal === "I2C_SCL")
	s.values.pins = [...s.values.pins!, ...bus.map((p) => ({ signal: p.signal, gpio: p.gpio, partRef: "JL1", partPin: p.signal === "I2C_SDA" ? "IO1" : "IO2" }))]
	return s
}

test("a rover as an I2C controller reads its target on the sensors' bus, and compiles", { skip: existsSync(pio) ? false : "needs PlatformIO", timeout: 900_000 }, async () => {
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, i2cRover())
	const link = readFileSync(join(dir, "include/link.h"), "utf8")
	assert.match(link, /#define LINK_L1_I2C_CONTROLLER 1/)
	assert.match(link, /Wire\.requestFrom\(\(uint8_t\)LINK_L1_I2C_PEER_ADDRESS/)
	assert.doesNotMatch(link, /Wire\.begin\(/) // the rover's hw_begin owns the bus
	const r = spawnSync(pio, ["run", "-d", dir, "-e", "esp32c3", "-e", "esp32c3_linktest"], { encoding: "utf8" })
	assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000))
})
