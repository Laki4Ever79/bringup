// The CNC's firmware in the loop end to end (gap 12): grblHAL's simulation build in its own copy of tools/grblhal-STM32F4xx,
// the scenario in Renode 1.17 (tools/renode), the judgement. Needs both tools; about a minute (an estimate: the build is
// most of it).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { cncSimReady, runCncSim } from "../src/tools/cnc-sim.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const skip = cncSimReady(root) ? false : "needs grblHAL's STM32F4xx and Renode 1.17 in tools/, and PlatformIO"

test("the simulated CNC: exact steps per motor, the e-stop, the stall stop and a hard limit each raise their alarm", { skip, timeout: 900_000 }, () => {
	const b = fixtureContract()
	const s = { ...b, values: { ...b.values, ...CNC_DESIGN, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as typeof b
	const dir = mkdtempSync(join(tmpdir(), "bringup-cncsim-"))
	const r = runCncSim(root, s, dir)
	assert.equal(r.result, "pass", `${JSON.stringify(r.checks, null, 1)}\n(the run's files: ${dir})`)
	assert.deepEqual(r.checks.map((c) => c.name), ["X steps", "Y steps", "Y2 (M3) steps", "Z steps", "e-stop", "stall stop", "hard limit"])
	// A pass leaves nothing behind (about 70 MB: the grblHAL copy and its build); a failure keeps its files to look at.
	rmSync(dir, { recursive: true, force: true })
})
