// The firmware a CNC runs, really built (src/tools/machine-fw.ts; needs PlatformIO, tools/grblhal-STM32F4xx and
// tools/FluidNC with its platform): grblHAL's board build for the scripted STM32F411 CNC, FluidNC's wifi build and its
// LittleFS image for the ESP32 one. About 2-3 min.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { buildMachineFirmware, fluidncReady } from "../src/tools/machine-fw.ts"
import { grblhalReady } from "../src/tools/grblhal-build.ts"
import { CNC_DESIGN, CNC_FLUIDNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const b = fixtureContract()

test("grblHAL's board build for the STM32F411 CNC", { skip: grblhalReady(root) ? false : "no grblHAL clone or PlatformIO" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-mfw-grbl-"))
	const s = { ...b, values: { ...b.values, ...CNC_DESIGN, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as ContractSnapshot
	const r = await buildMachineFirmware(root, s, dir)
	assert.equal(r.result, "built", `${r.result}: ${r.reason}`)
	assert.ok(r.flashPct! > 0 && r.flashPct! < 100)
	rmSync(dir, { recursive: true, force: true })
})

test("FluidNC's build and its LittleFS image with the board's config.yaml for the ESP32 CNC", { skip: fluidncReady(root) ? false : "no FluidNC clone or platform" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-mfw-fnc-"))
	const s = { ...b, values: { ...b.values, ...CNC_FLUIDNC_DESIGN, cncTargets: CNC_TARGETS, cnc: { ...CNC_MACHINE, firmware: "fluidnc" } } } as ContractSnapshot
	const r = await buildMachineFirmware(root, s, dir)
	assert.equal(r.result, "built", `${r.result}: ${r.reason}`)
	assert.ok(r.ramPct! > 0 && r.flashPct! > 0)
	assert.ok(r.fsImage && existsSync(r.fsImage), "the LittleFS image")
	rmSync(dir, { recursive: true, force: true })
})
