// grblHAL built for this CNC board, in a copy of its STM32F4xx driver.
// The clone in tools/grblhal-STM32F4xx (GPLv3: local only, never in this repo; docs/cnc.md gap 11) stays as cloned: each
// build copies it (without .git and .pio, about 40 MB) into its own folder and writes the generated map, environment and
// stall plugin there. Two builds at once (a test and a run, two sessions) wrote the same files in the shared clone, and
// PlatformIO wiped one's build folder when the other changed the environment (27 Nov: a test's build deleted the
// simulation's firmware mid-run).
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import type { ContractSnapshot } from "../contract/types.ts"
import { grblhalEnv, grblhalMap } from "../cnc/grblhal.ts"
import { stallHeader, stallParams, stallPlugin } from "../cnc/stall.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"

export const grblhalClone = (root: string) => join(root, "tools/grblhal-STM32F4xx")
export const grblhalReady = (root: string) => existsSync(join(grblhalClone(root), "platformio.ini")) && existsSync(join(root, ".venv/bin/pio"))

export interface GrblhalBuild {
	ok: boolean
	out: string // PlatformIO's output
	elf: string // the firmware, when ok
	src: string // the copy it built in
}

export function buildGrblhal(o: { root: string; dir: string; s: ContractSnapshot; env: "bringup_cnc" | "bringup_cnc_sim" }): GrblhalBuild {
	const src = join(o.dir, "grblhal-src")
	mkdirSync(o.dir, { recursive: true })
	cpSync(grblhalClone(o.root), src, { recursive: true, filter: (p) => !/[/\\]\.(git|pio)$/.test(p) })
	writeFileSync(join(src, "boards/my_machine_map.h"), grblhalMap(o.s))
	// The spindle's stall stop, a plugin in its Src/ (my_plugin_init), and the environment in platformio.local.ini, which
	// its platformio.ini reads: grblHAL's own files stay as cloned.
	const cat = defaultCheckCatalog()
	const stall = cat ? stallParams(o.s, cat) : null
	if (stall) {
		writeFileSync(join(src, "Src/bringup_stall.h"), stallHeader(stall))
		writeFileSync(join(src, "Src/bringup_stall.c"), stallPlugin(stall))
	}
	writeFileSync(join(src, "platformio.local.ini"), grblhalEnv())
	const r = spawnSync(join(o.root, ".venv/bin/pio"), ["run", "-e", o.env], { cwd: src, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	const elf = join(src, ".pio/build", o.env, "firmware.elf")
	return { ok: r.status === 0 && existsSync(elf), out: `${r.stdout ?? ""}${r.stderr ?? ""}`, elf, src }
}
