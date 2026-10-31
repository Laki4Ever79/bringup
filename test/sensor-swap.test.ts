import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { checkConsistency } from "../src/contract/consistency.ts"
import { parseSensorHeader, pinsHeader, sensorDriver } from "../src/codegen/firmware.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { fixtureArtifacts, fixtureContract } from "./fixture.ts"

const catalog = loadCatalog(resolve(import.meta.dirname, ".."))

function withSensor(mpn: string) {
	const c = fixtureContract()
	c.values.parts = c.values.parts!.map((p) => (p.role === "sensor" ? { ...p, mpn } : p))
	return c
}

// "The SHT40 is out of stock; use a different sensor from the catalog" needs a second sensor to choose.
test("the catalog has a second temperature/humidity sensor, the SHTC3, with datasheet pin names", () => {
	const sensors = catalog.filter((p) => p.role === "sensor")
	assert.ok(sensors.length >= 2)
	const shtc3 = sensors.find((p) => p.mpn === "SHTC3-TR-2.5KS")!
	assert.equal(shtc3.lcsc, "C194656", "jlcsearch, 31 Oct 2026: SHTC3-TR-2.5KS DFN-4-EP(2x2)")
	// SHTC3 datasheet v4 (Dec 2022) Table 7: 1 VDD, 2 SCL, 3 SDA, 4 VSS; the centre pad is VSS.
	assert.deepEqual(shtc3.pins, ["VDD", "SCL", "SDA", "VSS"])
})

test("each catalog sensor has a firmware driver", () => {
	for (const s of catalog.filter((p) => p.role === "sensor")) assert.ok(sensorDriver(s.mpn), `${s.mpn} has no driver`)
	assert.equal(sensorDriver("SHT40-AD1B-R2"), "SHT40")
	assert.equal(sensorDriver("SHTC3-TR-2.5KS"), "SHTC3")
	assert.equal(sensorDriver("BME280"), null)
})

test("pins.h selects the sensor driver from the contract's parts, and it reads back", () => {
	assert.match(pinsHeader(fixtureContract()), /^#define SENSOR_SHT40 1$/m)
	const h = pinsHeader(withSensor("SHTC3-TR-2.5KS"))
	assert.match(h, /^#define SENSOR_SHTC3 1$/m)
	assert.doesNotMatch(h, /SENSOR_SHT40/)
	assert.equal(parseSensorHeader(h), "SHTC3")
	const none = fixtureContract()
	none.values.parts = none.values.parts!.filter((p) => p.role !== "sensor")
	assert.equal(parseSensorHeader(pinsHeader(none)), null)
})

test("firmware compiled for the old sensor is a violation until it is rebuilt, for no agent: the builder rebuilds", () => {
	const firmware = { ...fixtureArtifacts().firmware!, sensor: "SHT40" }
	const v = checkConsistency(withSensor("SHTC3-TR-2.5KS"), { firmware })
	assert.deepEqual(v.map((x) => [x.kind, x.affects]), [["sensor-mismatch", []]])
	assert.match(v[0].message, /SHT40.*SHTC3/)
	assert.deepEqual(checkConsistency(withSensor("SHTC3-TR-2.5KS"), { firmware: { ...firmware, sensor: "SHTC3" } }), [])
	// Artifacts from before this check (no sensor recorded) are not flagged.
	assert.deepEqual(checkConsistency(withSensor("SHTC3-TR-2.5KS"), { firmware: fixtureArtifacts().firmware! }), [])
})
