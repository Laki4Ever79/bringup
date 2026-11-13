// Bring-up test pads on every board by default (engineer, 13 Nov 2026: "we should be adding test points as well to our
// designs", kept on by default): a small set on the underside for the first bench session, dropped where there is no
// room, never a reason to grow the board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { bringupNets, bringupPads, circuitFromContract, recoveryPads, testPoints } from "../src/codegen/circuit.ts"
import { addedForYou } from "../src/contract/added.ts"
import { mechanicalInterface } from "../src/contract/interface.ts"
import { minimumBoard } from "../src/contract/space.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

test("a board gets bring-up pads on ground and its rails without being asked", () => {
	const s = logger()
	const nets = bringupNets(s)
	assert.ok(nets.includes("GND"))
	assert.ok(nets.includes("V3V3"), "the 3.3 V rail")
	assert.ok(nets.includes("VBAT"), "the logger has a battery")
	assert.ok(!nets.includes("VBUS"), "VBUS is probed at the connector, no pad")
	const { placed, unplaced } = bringupPads(s)
	assert.deepEqual(unplaced, [])
	// Recovery pads already give GND a pad; bring-up doesn't repeat a net another bottom pad carries.
	const recovery = recoveryPads(s).placed.map((p) => p.net)
	assert.ok(recovery.includes("GND"))
	assert.ok(!placed.some((p) => recovery.includes(p.net)))
	assert.deepEqual(placed.map((p) => p.ref), placed.map((_, i) => `TP${i + 1}`))
	const tsx = circuitFromContract(s)
	for (const p of placed) {
		assert.match(tsx, new RegExp(`<testpoint name="${p.ref}" [^>]*layer="bottom"`))
		assert.match(tsx, new RegExp(`from="\\.${p.ref} > \\.pin1" to="net\\.${p.net}"`))
	}
	assert.deepEqual(mechanicalInterface(s)?.bottomPads.filter((b) => b.ref.startsWith("TP") && !b.ref.startsWith("TPR")).map((b) => b.net), placed.map((p) => p.net))
})

test("a UART debug port and a cable link's signals get pads", () => {
	const s = logger()
	s.values.pins = [...s.values.pins!, { signal: "UART_TX", gpio: 21, partRef: "U1", partPin: "GPIO21" }, { signal: "L1_RX", gpio: 20, partRef: "U1", partPin: "GPIO20" }]
	const nets = bringupNets(s)
	assert.ok(nets.includes("UART_TX"))
	assert.ok(nets.includes("L1_RX"))
	assert.ok(!nets.includes("I2C_SDA"), "a board's own bus without a link has no pad")
})

test("bring-up pads are off with requirements.testPads false, and a production test replaces them", () => {
	const off = logger()
	off.values.requirements = { ...off.values.requirements!, testPads: false }
	assert.deepEqual(bringupNets(off), [])
	assert.deepEqual(bringupPads(off).placed, [])
	assert.doesNotMatch(circuitFromContract(off), /<testpoint name="TP\d/)
	const prod = logger()
	prod.values.test = { points: ["GND", "V3V3", "I2C_SDA"], awakeMaxMa: 200, sleepMaxUa: 50 } as never
	assert.deepEqual(bringupPads(prod).placed, [])
	assert.deepEqual(testPoints(prod).placed.map((p) => p.net), ["GND", "V3V3", "I2C_SDA"])
})

test("bring-up pads never change the smallest board, and a pad with no room is dropped", () => {
	const s = logger()
	const off = logger()
	off.values.requirements = { ...off.values.requirements!, testPads: false }
	assert.deepEqual(minimumBoard(s), minimumBoard(off))
	// A board too small for any pad clear of the module, the connectors and the holes: the pads are left off, unplaced.
	const tiny = logger()
	tiny.values.outline = { ...tiny.values.outline!, widthMm: 24, heightMm: 18 }
	const { placed, unplaced } = bringupPads(tiny)
	assert.equal(placed.length + unplaced.length, bringupNets(tiny).filter((n) => !recoveryPads(tiny).placed.some((p) => p.net === n)).length)
})

test("the report lists the bring-up pads under Added for you, with how to turn them off", () => {
	const item = addedForYou(logger()).find((i) => i.id === "bringup-pads")
	assert.ok(item)
	assert.match(item.what, /test pads/i)
	assert.match(item.change, /testPads.*false|no test pads/)
	const off = logger()
	off.values.requirements = { ...off.values.requirements!, testPads: false }
	assert.equal(addedForYou(off).find((i) => i.id === "bringup-pads"), undefined)
})
