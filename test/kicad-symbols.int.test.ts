import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { groundParts, matchSymbol } from "../src/contract/grounding.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { loadSymbols } from "../src/tools/kicad-symbols.ts"
import { fixtureContract } from "./fixture.ts"

const root = await mkdtemp(join(tmpdir(), "bringup-sym-"))
const env = await detectEnvironment(root)
const skip = env.kicad === "docker" ? false : "kicad/kicad:10.0 docker image missing"

test("KiCad's Sensor_Humidity library grounds the SHT40", { skip, timeout: 120_000 }, async () => {
	try {
		const symbols = await loadSymbols(env, ["Sensor_Humidity", "Regulator_Linear"])
		const name = matchSymbol("SHT40-AD1B-R2", symbols)
		assert.equal(name, "SHT4x")
		assert.deepEqual(symbols[name!].pins.map((p) => p.name).sort(), ["SCL", "SDA", "VDD", "VSS"])
		assert.equal(matchSymbol("AP2112K-3.3TRG1", symbols), "AP2112K-3.3")
		assert.deepEqual(symbols["AP2112K-3.3"].pins.map((p) => p.name).sort(), ["EN", "GND", "NC", "VIN", "VOUT"])

		// Grounded in KiCad alone, without the catalog, the fixture's sensor still checks out.
		const c = fixtureContract()
		c.values.parts = c.values.parts!.filter((p) => p.ref === "U2")
		c.values.pins = []
		assert.deepEqual(groundParts(c, { catalog: [], symbols }), [])

		// The catalog's second sensor, for "the SHT40 is out of stock": KiCad's SHTC3 symbol has the same four pin names.
		assert.equal(matchSymbol("SHTC3-TR-2.5KS", symbols), "SHTC3")
		const swapped = fixtureContract()
		swapped.values.parts = swapped.values.parts!.filter((p) => p.ref === "U2").map((p) => ({ ...p, mpn: "SHTC3-TR-2.5KS", lcsc: "C194656", pins: ["VDD", "SCL", "SDA", "VSS"] }))
		swapped.values.pins = []
		assert.deepEqual(groundParts(swapped, { catalog: [], symbols }), [])

		// The second load comes from the cache, not from docker.
		const start = Date.now()
		await loadSymbols(env, ["Sensor_Humidity", "Regulator_Linear"])
		assert.ok(Date.now() - start < 500, `cached load took ${Date.now() - start} ms`)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
