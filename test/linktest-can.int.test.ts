// A CAN link (docs/system.md): both boards' link-test builds compile against ESP-IDF's TWAI driver, one sending a
// message as a CAN frame, the other receiving it. QEMU has no TWAI, so compiling is as far as this computer goes; the
// bench plan runs it on two real boards. Needs PlatformIO; skipped otherwise.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { buildLinkTestFirmware, prepareFirmware } from "../src/tools/firmware.ts"
import { BENCH_ENV } from "../src/system/bench-plan.ts"
import { boardLinks } from "../src/system/derive.ts"
import { CAN_TRANSCEIVER, canSignals, LINK_CONNECTOR } from "../src/contract/links.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir, slow } from "./helpers.ts"

const pio = [join(ROOT, ".venv/bin/pio")].find(existsSync) ?? null

const spec: SystemSpec = {
	name: "two boards on CAN",
	boards: [{ name: "hub", brief: "h.md" }, { name: "sensor", brief: "s.md" }],
	links: [{ id: "L1", kind: "can", a: { board: "hub" }, b: { board: "sensor" }, can: { kbps: 500 }, cable: { lengthMm: 500 }, messages: [{ name: "reading", from: "sensor", fields: [{ name: "tempCx100", type: "i16" }, { name: "rhx100", type: "u16" }] }] }],
}

function board(name: string): ContractSnapshot {
	const c = fixtureContract()
	c.values = { ...c.values, ...structuredClone(LOGGER_DESIGN), links: boardLinks(spec, name) }
	const [l] = c.values.links!
	c.values.parts = [...c.values.parts!, { ref: l.connector, role: "connector", ...LINK_CONNECTOR }, { ref: "U9", role: "can-transceiver", ...CAN_TRANSCEIVER }]
	const used = new Set(c.values.pins!.map((p) => p.gpio))
	const [g1, g2] = [4, 5, 6, 7, 3, 1, 0].filter((g) => !used.has(g))
	c.values.pins = [...c.values.pins!, { signal: canSignals(l).tx, gpio: g1, partRef: "U9", partPin: "D" }, { signal: canSignals(l).rx, gpio: g2, partRef: "U9", partPin: "R" }]
	return c
}

test("both sides of a CAN link compile as link tests (ESP32-C3 TWAI)", { skip: slow || (pio ? false : "needs PlatformIO"), timeout: 900_000 }, async () => {
	for (const name of ["hub", "sensor"]) {
		const dir = tempDir()
		await prepareFirmware(ROOT, dir, board(name))
		const link = readFileSync(join(dir, "include", "link.h"), "utf8")
		assert.match(link, /twai_driver_install/, `${name}'s link.h`)
		assert.match(link, name === "hub" ? /twai_receive/ : /twai_transmit/, `${name}'s link.h`)
		const r = await buildLinkTestFirmware(pio!, dir, BENCH_ENV)
		assert.equal(r.ok, true, `${name}: ${r.log.slice(-3000)}`)
		assert.ok(existsSync(join(dir, ".pio", "build", BENCH_ENV, "firmware.bin")), `${name}: no firmware.bin`)
	}
})

// STM32 bxCAN (the HAL's CAN driver), on the STM32F103's CAN at PB8 (RX) / PB9 (TX): the same frames as the ESP32's, each
// message a Cyphal/CAN single-frame transfer (linkcyphal.h). Before 16 Nov 2026 an STM32 board with a CAN link got #error.
test("both sides of a CAN link compile as link tests on an STM32F103 (bxCAN)", { skip: slow || (pio ? false : "needs PlatformIO"), timeout: 1_200_000 }, async () => {
	const { STM32_LOGGER_DESIGN } = await import("../src/inference/scripts.ts")
	for (const name of ["hub", "sensor"]) {
		const c = fixtureContract()
		c.values = { ...c.values, ...structuredClone(STM32_LOGGER_DESIGN), links: boardLinks(spec, name) }
		// The STM32 logger is a G031 (no CAN): the same board on the F103, each pin moved by its name to the F103's index.
		const { loadProfiles } = await import("../src/mcu/profile.ts")
		const ps = loadProfiles(), g031 = ps.find((x) => x.id === "stm32g031k8t6")!, f103 = ps.find((x) => x.id === "stm32f103c8t6")!
		const f103Part = (JSON.parse(readFileSync(join(ROOT, "catalog", "parts.json"), "utf8")) as { mpn: string }[]).find((x) => x.mpn === "STM32F103C8T6")!
		c.values.parts = c.values.parts!.map((x) => (x.role === "mcu" ? { ...x, ...f103Part, ref: x.ref } : x))
		c.values.pins = c.values.pins!.map((x) => ({ ...x, gpio: f103.pins.find((q) => q.name === g031.pins.find((g) => g.index === x.gpio)?.name)!.index }))
		const [l] = c.values.links!
		c.values.parts = [...c.values.parts!, { ref: l.connector, role: "connector", ...LINK_CONNECTOR }, { ref: "U9", role: "can-transceiver", ...CAN_TRANSCEIVER }]
		assert.ok(!c.values.pins!.some((p) => p.gpio === 24 || p.gpio === 25), "PB8/PB9 are free on the STM32 logger")
		c.values.pins = [...c.values.pins!, { signal: canSignals(l).tx, gpio: 25, partRef: "U9", partPin: "D" }, { signal: canSignals(l).rx, gpio: 24, partRef: "U9", partPin: "R" }]
		const dir = tempDir()
		await prepareFirmware(ROOT, dir, c)
		const link = readFileSync(join(dir, "include", "link.h"), "utf8")
		assert.doesNotMatch(link, /#error "Bringup: a CAN link on an STM32/)
		assert.match(link, /HAL_CAN_Start/)
		assert.match(link, name === "hub" ? /HAL_CAN_GetRxMessage/ : /HAL_CAN_AddTxMessage/)
		const r = await buildLinkTestFirmware(pio!, dir)
		assert.equal(r.ok, true, `${name}: ${r.log.slice(-3000)}`)
	}
})

// A CAN bus of three boards (link.can.bus): sensor-a and sensor-b at its ends, the hub in the middle on two segments
// with one transceiver and one controller. Each sensor sends its own message (one sender per frame identifier); the
// hub receives both and names the segment each came on by its identifier.
const reading = (name: string, from: string) => ({ name, from, fields: [{ name: "tempCx100", type: "i16" as const }, { name: "rhx100", type: "u16" as const }] })
const bus: SystemSpec = {
	name: "three boards on one CAN bus",
	boards: [{ name: "sensor-a", brief: "a.md" }, { name: "hub", brief: "h.md" }, { name: "sensor-b", brief: "b.md" }],
	links: [
		{ id: "L1", kind: "can", a: { board: "sensor-a" }, b: { board: "hub" }, can: { kbps: 500, bus: "B1" }, cable: { lengthMm: 500 }, messages: [reading("reading_a", "sensor-a")] },
		{ id: "L2", kind: "can", a: { board: "hub" }, b: { board: "sensor-b" }, can: { kbps: 500, bus: "B1" }, cable: { lengthMm: 500 }, messages: [reading("reading_b", "sensor-b")] },
	],
}
function busBoard(name: string): ContractSnapshot {
	const c = fixtureContract()
	const links = boardLinks(bus, name)
	c.values = { ...c.values, ...structuredClone(LOGGER_DESIGN), links }
	c.values.parts = [...c.values.parts!, ...links.map((l) => ({ ref: l.connector, role: "connector" as const, ...LINK_CONNECTOR })), { ref: "U9", role: "can-transceiver", ...CAN_TRANSCEIVER }]
	const used = new Set(c.values.pins!.map((p) => p.gpio))
	const [g1, g2] = [4, 5, 6, 7, 3, 1, 0].filter((g) => !used.has(g))
	c.values.pins = [...c.values.pins!, { signal: canSignals(links[0]).tx, gpio: g1, partRef: "U9", partPin: "D" }, { signal: canSignals(links[0]).rx, gpio: g2, partRef: "U9", partPin: "R" }]
	return c
}

test("a CAN bus of three boards: the middle board receives both ends' messages on one controller; all three compile", { skip: slow || (pio ? false : "needs PlatformIO"), timeout: 1_200_000 }, async () => {
	for (const name of ["hub", "sensor-a", "sensor-b"]) {
		const dir = tempDir()
		await prepareFirmware(ROOT, dir, busBoard(name))
		const link = readFileSync(join(dir, "include", "link.h"), "utf8")
		assert.equal(link.match(/twai_driver_install/g)?.length, 1, `${name}: one controller`)
		if (name === "hub") {
			assert.match(link, /twai_receive/)
			// Each frame's subject-ID names its message, and the message its segment.
			assert.match(link, /if \(subject == MSG_READING_A_SUBJECT\) \{\n\t\tlinkReceived\("L1", MSG_READING_A_HASH/)
			assert.match(link, /if \(subject == MSG_READING_B_SUBJECT\) \{\n\t\tlinkReceived\("L2", MSG_READING_B_HASH/)
			assert.ok(existsSync(join(dir, "dsdl/bringup/ReadingA.1.0.dsdl")) && existsSync(join(dir, "dsdl/bringup/ReadingB.1.0.dsdl")))
		} else assert.match(link, /twai_transmit/)
		const r = await buildLinkTestFirmware(pio!, dir, BENCH_ENV)
		assert.equal(r.ok, true, `${name}: ${r.log.slice(-3000)}`)
	}
})
