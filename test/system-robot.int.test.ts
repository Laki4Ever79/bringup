// A scripted two-board robot end to end (docs/system.md, system view phase 1): the system run hands both boards the
// chassis assembly, builds them with the toolchain, and the main board's chassis carries both on one plate.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { runSystem, boardDir } from "../src/system/run.ts"
import { loadSpec } from "../src/system/spec.ts"
import type { ChassisSpec } from "../src/tools/chassis.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import { tempDir } from "./helpers.ts"

const env = await detectEnvironment(ROOT)
const skip = env.tsci && env.kicad && env.python ? false : "needs tscircuit, KiCad and the .venv with build123d (npm run doctor)"

// Every spec.json under a folder (the chassis builder writes one next to chassis.step).
function chassisSpecs(dir: string): string[] {
	const out: string[] = []
	for (const e of readdirSync(dir)) {
		const p = join(dir, e)
		if (statSync(p).isDirectory()) out.push(...chassisSpecs(p))
		else if (e === "spec.json" && existsSync(join(dir, "chassis.step"))) out.push(p)
	}
	return out
}

test("a scripted two-board robot builds with every board on the chassis", { skip, timeout: 2_400_000 }, async (t) => {
	const out = tempDir()
	const r = await runSystem({ spec: loadSpec("briefs/systems/rover-climate.json"), outDir: out, mock: true, boardArgs: ["--no-review"], pollMs: 500, timeoutMs: 1_800_000 })
	const specs = chassisSpecs(boardDir(out, "main"))
	assert.ok(specs.length > 0, "the main board built no chassis")
	// The latest chassis revision by its number (a string sort puts rev-9 after rev-10).
	const rev = (p: string) => Number(/rev-(\d+)/.exec(p)?.[1] ?? -1)
	const chassis = JSON.parse(readFileSync(specs.sort((a, b) => rev(a) - rev(b)).at(-1)!, "utf8")) as ChassisSpec
	assert.deepEqual(chassis.boards.map((b) => b.name).sort(), ["climate", "main"])
	assert.deepEqual(chassis.unplaced, [])
	// Climate settles, and the system's assembly takes its built outline (the one in climate's own contract; sorted, so a
	// rotation passes).
	const climate = JSON.parse(readFileSync(join(boardDir(out, "climate"), "contract.json"), "utf8")) as ContractSnapshot
	const built = [climate.values.outline!.widthMm, climate.values.outline!.heightMm].sort((a, b) => a - b)
	const sys = JSON.parse(readFileSync(join(out, "system.json"), "utf8")) as SystemSpec
	const merged = sys.assembly?.boards.find((b) => b.name === "climate")
	assert.equal(merged?.outlineSource, "built", "the system's assembly still has climate's estimated outline")
	assert.deepEqual([merged!.outline.widthMm, merged!.outline.heightMm].sort((a, b) => a - b), built)
	// Known gap on adopt, not in the assembly: the rover firmware template (templates/fw-rover) has no link code or L1
	// pins, so main ends unsettled on a pin mismatch for L1_TX/L1_RX.
	// A stuck board is not sent the new assembly, and main's chassis is rebuilt only when main's board builds, so main's
	// assembly and chassis carry climate's built outline only once main settles.
	await t.test("the whole robot settles", { todo: "scripted rover with JL1 does not settle on adopt: its firmware template has no link support (L1_TX/L1_RX)" }, () => {
		assert.equal(r.ok, true, `system did not settle, see ${r.reportPath}`)
		const main = JSON.parse(readFileSync(join(boardDir(out, "main"), "contract.json"), "utf8")) as ContractSnapshot
		const handed = main.values.assembly?.boards.find((b) => b.name === "climate")
		assert.equal(handed?.outlineSource, "built", "main's assembly still has climate's estimated outline")
		const placed = chassis.boards.find((b) => b.name === "climate")!
		assert.deepEqual([placed.widthMm, placed.heightMm].sort((a, b) => a - b), built, "main's chassis lists climate at an estimated outline")
		assert.deepEqual(sys.assembly?.boards.map((b) => b.outlineSource), ["built", "built"])
	})
})
