// grblHAL itself builds with the CNC's generated board map and environment (gap 11): its STM32F4xx driver cloned into
// tools/grblhal-STM32F4xx (GPLv3: local only, never in this repo; docs/cnc.md gap 11), built with PlatformIO's ststm32:
//   git clone --depth 1 --recurse-submodules --shallow-submodules https://github.com/grblHAL/STM32F4xx.git tools/grblhal-STM32F4xx
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { buildGrblhal, grblhalReady } from "../src/tools/grblhal-build.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const skip = grblhalReady(root) ? false : "needs grblHAL's STM32F4xx in tools/ and PlatformIO"

test("grblHAL builds for the CNC board from the generated map, environment and stall-stop plugin, in its own copy", { skip, timeout: 900_000 }, () => {
	const b = fixtureContract()
	const s = { ...b, values: { ...b.values, ...CNC_DESIGN, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as typeof b
	const r = buildGrblhal({ root, dir: mkdtempSync(join(tmpdir(), "bringup-grblhal-")), s, env: "bringup_cnc" })
	assert.ok(r.ok, r.out.split("\n").filter((l) => / error|FAILED/.test(l)).join("\n") || r.out.slice(-2000))
	assert.match(r.out, /Flash: \[/)
})
