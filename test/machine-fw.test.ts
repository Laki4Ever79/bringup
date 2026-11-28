// The firmware a CNC runs (src/tools/machine-fw.ts): PlatformIO's sizes read, the report's lines, and "not run" where
// the firmware can't be built here (grblHAL on the ESP32, FluidNC without its platform).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildMachineFirmware, fluidncReady, machineFwLines, pioSizes } from "../src/tools/machine-fw.ts"
import { CNC_FLUIDNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

test("PlatformIO's RAM and flash percent; the report's lines for built, failed and not run", () => {
	const out = "RAM:   [==        ]  20.9% (used 68352 bytes from 327680 bytes)\nFlash: [==========]  97.1% (used 1908920 bytes from 1966080 bytes)\n"
	assert.deepEqual(pioSizes(out), { ramPct: 20.9, flashPct: 97.1 })
	assert.deepEqual(machineFwLines({ revision: 12, dir: "d", firmware: "fluidnc", result: "built", ramPct: 20.9, flashPct: 97.1, ms: 87_000, fsImage: "x" }), ["- Machine firmware (FluidNC, rev 12): builds, RAM 20.9%, flash 97.1% in 87 s; config.yaml in its LittleFS image"])
	assert.deepEqual(machineFwLines({ revision: 3, dir: "d", firmware: "grblhal", result: "failed", reason: "map.h:4: error: x" }), ["- Machine firmware (grblHAL, rev 3): does NOT build: map.h:4: error: x"])
	assert.match(machineFwLines({ revision: 3, dir: "d", firmware: "fluidnc", result: "not run", reason: "no platform" })[0], /not built \(no platform\)/)
})

test("not run: grblHAL on the ESP32 names the fix; FluidNC without its platform says what is missing", async () => {
	const b = fixtureContract()
	const s = (firmware: "grblhal" | "fluidnc") => ({ ...b, values: { ...b.values, ...CNC_FLUIDNC_DESIGN, cncTargets: CNC_TARGETS, cnc: { ...CNC_MACHINE, firmware } } }) as ContractSnapshot
	const empty = mkdtempSync(join(tmpdir(), "bringup-mfw-"))
	const g = await buildMachineFirmware(empty, s("grblhal"), join(empty, "out"))
	assert.equal(g.result, "not run")
	assert.match(g.reason!, /builds grblHAL for the STM32F4.*ESP32-WROOM-32E/)
	assert.equal(fluidncReady(empty), false)
	const f = await buildMachineFirmware(empty, s("fluidnc"), join(empty, "out"))
	assert.equal(f.result, "not run")
	assert.match(f.reason!, /FluidNC's clone \(tools\/FluidNC\) or its pinned platform/)
})
