import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { netsFromCircuitJson } from "../src/tools/board-nets.ts"

// Built by tsci from circuitFromContract(fixtureContract()).
const elements = JSON.parse(readFileSync(new URL("./data/fixture.circuit.json", import.meta.url), "utf8"))

test("nets map signal names to REF.pinLabel ends", () => {
	const nets = netsFromCircuitJson(elements)
	assert.deepEqual(nets.I2C_SDA?.slice().sort(), ["U1.GPIO8", "U2.SDA"])
	assert.deepEqual(nets.I2C_SCL?.slice().sort(), ["U1.GPIO9", "U2.SCL"])
})

test("a net with no traces is listed empty", () => {
	const nets = netsFromCircuitJson([{ type: "source_net", source_net_id: "n0", name: "SPARE" }])
	assert.deepEqual(nets, { SPARE: [] })
})
