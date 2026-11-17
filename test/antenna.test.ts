// The ESP32-C3 module's antenna and Espressif's recommended 15 mm clearance (src/contract/antenna.ts, 17 Nov 2026):
// advisory, a report line naming the board parts within it. Of the 31 fixtures with a module, 30 have one; no layout
// changes for it yet.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { antennaClearance, antennaLine, ANTENNA_CLEARANCE_MM } from "../src/contract/antenna.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"
import { STM32_LOGGER_DESIGN } from "../src/inference/scripts.ts"

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as ContractSnapshot

test("the parts within 15 mm of the antenna are named, nearest first, the module itself left out", () => {
	const c = antennaClearance(fixture("cc-rover-60x21-rev17.json"))!
	assert.equal(c.edge, "top")
	assert.ok(c.near.length > 0 && c.near.every((n) => n.mm < ANTENNA_CLEARANCE_MM))
	assert.deepEqual(c.near.map((n) => n.mm), [...c.near.map((n) => n.mm)].sort((a, b) => a - b))
	assert.ok(!c.near.some((n) => n.ref === "U1"))
	assert.match(antennaLine(fixture("cc-rover-60x21-rev17.json"))!, /^- Antenna \(advisory\): \d+ parts? within Espressif's recommended 15 mm of the module's antenna \(past the top edge\): /)
})

test("a board with nothing near the antenna says so; a board without the module has no line", () => {
	assert.equal(antennaClearance(fixture("cc-eurobot-16-rev22.json"))!.near.length, 0)
	assert.match(antennaLine(fixture("cc-eurobot-16-rev22.json"))!, /no board part within Espressif's recommended 15 mm/)
	const stm = fixtureContract()
	stm.values = { ...stm.values, ...structuredClone(STM32_LOGGER_DESIGN) }
	assert.equal(antennaLine(stm), null)
})
