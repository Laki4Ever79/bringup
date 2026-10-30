import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { simulatePower } from "../src/tools/spice.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")

function hasImage(): boolean {
	try {
		execFileSync("docker", ["image", "inspect", "kicad/kicad:10.0"], { stdio: "ignore" })
		return true
	} catch {
		return false
	}
}
const skip = hasImage() ? false : "docker or kicad/kicad:10.0 missing"

async function simulate(mutate: (c: ReturnType<typeof fixtureContract>) => void = () => {}) {
	const dir = await mkdtemp(join(tmpdir(), "bringup-spice-"))
	try {
		const c = fixtureContract()
		mutate(c)
		return await simulatePower(root, dir, c)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

test("fixture rail regulates from VBUS and from a Li-ion at 3.7 V", { skip, timeout: 120_000 }, async () => {
	const report = await simulate()
	const byName = Object.fromEntries(report.scenarios.map((x) => [x.name, x]))
	for (const name of ["vbus-5v0", "liion-3v7"]) {
		const s = byName[name]
		assert.ok(s, `scenario ${name} missing: ${JSON.stringify(report)}`)
		assert.equal(s.ok, true, JSON.stringify(s))
		assert.ok(Math.abs(s.voutV - 3.3) < 0.01, `vout ${s.voutV}`)
		assert.ok(s.headroomMv > 0, `headroom ${s.headroomMv}`)
	}
	// 1.7 V across the regulator at 120 mA is about 204 mW.
	assert.ok(Math.abs(byName["vbus-5v0"].dissipationMw - 204) < 5, `dissipation ${byName["vbus-5v0"].dissipationMw}`)
})

test("600 mA from a Li-ion at 3.5 V drops out of regulation", { skip, timeout: 120_000 }, async () => {
	const report = await simulate((c) => { c.values.rails![0].loadMa = 600 })
	const s = report.scenarios.find((x) => x.name === "liion-3v5")!
	assert.equal(s.ok, false, JSON.stringify(s))
	assert.ok(s.voutV < 3.3 * 0.97, `vout ${s.voutV}`)
	assert.ok(s.headroomMv < 0, `headroom ${s.headroomMv}`)
})

test("real run 9's rails simulate: VBUS and VBAT are skipped, the 3.3 V rail is reported", { skip, timeout: 120_000 }, async () => {
	const report = await simulate((c) => {
		c.values.rails = [
			{ name: "VBUS", voltageV: 5, regulatorMaxMa: 500, loadMa: 0 },
			{ name: "VBAT", voltageV: 3.7, regulatorMaxMa: 1000, loadMa: 500, averageMa: 0 },
			{ name: "VDD_3V3", voltageV: 3.3, regulatorMaxMa: 300, loadMa: 180, averageMa: 0.097 },
		]
	})
	assert.deepEqual([...new Set(report.scenarios.map((x) => x.rail))], ["VDD_3V3"])
	assert.ok(report.scenarios.find((x) => x.name === "liion-3v7")!.ok)
})
