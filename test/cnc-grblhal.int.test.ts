// grblHAL itself builds with the CNC's generated board map and environment (gap 11): its STM32F4xx driver cloned into
// tools/grblhal-STM32F4xx (GPLv3: local only, never in this repo; docs/cnc.md gap 11), built with PlatformIO's ststm32:
//   git clone --depth 1 --recurse-submodules --shallow-submodules https://github.com/grblHAL/STM32F4xx.git tools/grblhal-STM32F4xx
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { grblhalEnv, grblhalMap } from "../src/cnc/grblhal.ts"
import { stallHeader, stallParams, stallPlugin } from "../src/cnc/stall.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const G = join(root, "tools/grblhal-STM32F4xx")
const pio = join(root, ".venv/bin/pio")
const skip = !existsSync(join(G, "platformio.ini")) || !existsSync(pio) ? "needs grblHAL's STM32F4xx in tools/ and PlatformIO" : false

test("grblHAL builds for the CNC board from the generated map, environment and stall-stop plugin", { skip, timeout: 900_000 }, () => {
	const b = fixtureContract()
	const s = { ...b, values: { ...b.values, ...CNC_DESIGN, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as typeof b
	writeFileSync(join(G, "boards/my_machine_map.h"), grblhalMap(s))
	// The spindle's stall stop, a plugin in its Src/ (my_plugin_init), and the environment in platformio.local.ini, which
	// its platformio.ini reads and git ignores: grblHAL's own files stay as cloned.
	const stall = stallParams(s, defaultCheckCatalog()!)!
	writeFileSync(join(G, "Src/bringup_stall.h"), stallHeader(stall))
	writeFileSync(join(G, "Src/bringup_stall.c"), stallPlugin(stall))
	writeFileSync(join(G, "platformio.local.ini"), grblhalEnv())
	const r = spawnSync(pio, ["run", "-e", "bringup_cnc"], { cwd: G, encoding: "utf8" })
	const out = `${r.stdout}${r.stderr}`
	assert.equal(r.status, 0, out.split("\n").filter((l) => / error|FAILED/.test(l)).join("\n") || out.slice(-2000))
	assert.match(out, /Flash: \[/)
})
