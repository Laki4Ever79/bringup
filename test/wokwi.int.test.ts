import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { wokwiProject } from "../src/codegen/wokwi.ts"
import { buildFirmware } from "../src/tools/firmware.ts"
import { detectEnvironment, firmwareSimBackend } from "../src/tools/env.ts"
import { chipWasm, EXPECTED_LINE, loadWokwiToken, simulateFirmware } from "../src/tools/wokwi.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
loadWokwiToken(root)
const env = await detectEnvironment(root)
const contract = fixtureContract()
const chip = wokwiProject(contract, "x").chip!
// Excluded from the regular runs for now (the user, 15 Nov): BRINGUP_WOKWI=1 runs it. When it runs it never skips: a
// machine without Wokwi fails here, naming what is missing, instead of passing quietly.
const excluded = process.env.BRINGUP_WOKWI === "1" ? false : "Wokwi excluded for now (the user, 15 Nov); BRINGUP_WOKWI=1 runs it"
const missing =
	firmwareSimBackend(env) !== "wokwi" ? "Wokwi is not set up: WOKWI_CLI_TOKEN in .env and tools/wokwi-cli (npm run setup -- --wokwi, NOTES.md)" :
	!existsSync(chipWasm(root, chip)) ? `the ${chip} custom chip is not compiled (NOTES.md)` :
	!env.pio ? "pio not found (npm run setup)" : null

// One short session (≤ 30 s of the free plan's minutes): the firmware reads the simulated sensor and stores it.
test("the firmware, simulated in Wokwi with the contract's sensor on its I2C pins, reads the sensor and stores the reading", { skip: excluded, timeout: 600_000 }, async () => {
	assert.equal(missing, null, missing ?? "")
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
