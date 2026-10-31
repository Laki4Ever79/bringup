import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { wokwiProject } from "../src/codegen/wokwi.ts"
import { buildFirmware } from "../src/tools/firmware.ts"
import { detectEnvironment, firmwareSimBackend } from "../src/tools/env.ts"
import { chipWasm, EXPECTED_LINE, simulateFirmware } from "../src/tools/wokwi.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const env = await detectEnvironment(root)
const contract = fixtureContract()
const chip = wokwiProject(contract, "x").chip!
const skip =
	firmwareSimBackend(env) !== "wokwi" ? "Wokwi not set up (WOKWI_CLI_TOKEN and tools/wokwi-cli; optional, NOTES.md)" :
	!existsSync(chipWasm(root, chip)) ? `the ${chip} custom chip is not compiled (NOTES.md)` :
	!env.pio ? "pio not found" : false

// One short session (≤ 30 s of the free plan's minutes): the firmware reads the simulated sensor and stores it.
test("the firmware, simulated in Wokwi with the contract's sensor on its I2C pins, reads the sensor and stores the reading", { skip, timeout: 600_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-wokwi-"))
	try {
		const fw = await buildFirmware(env.pio!, root, dir, contract, 7)
		assert.equal(fw.ok, true, fw.log)
		const r = await simulateFirmware(env, dir, contract)
		assert.equal(r.ran, true, r.reason)
		assert.ok(r.serial!.includes(EXPECTED_LINE), r.serial)
		assert.match(r.serial!, /^HISTORY slot 0$/m)
		assert.equal(r.passed, true)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
