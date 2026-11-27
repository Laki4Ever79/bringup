// The placer's pad math (padOffset) against tscircuit's own placement of the land patterns the generator draws itself
// (ownFootprint: the IMU's LGA-14, the SO-8 power pads, the SY8368A's polygons, the radio modules), at every quarter turn.
// The placer puts each pin capacitor beside a pad it computes, and the reach check measures from it: if a footprint or a
// tscircuit update moved the pads, both would drift silently. Checked 27 Nov 2026 when a turned rover IMU routed its VDD
// capacitor 35-39 mm (it agreed: that was the router). Renders tscircuit core in bun, no board build.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { DC091_FOOTPRINT, DDA_FOOTPRINT, IMU_FOOTPRINT, MIC_FOOTPRINT, MODULES, ownFootprint, padOffset, SO8E_FOOTPRINT, SY8368_FOOTPRINT, XT60_FOOTPRINT } from "../src/codegen/circuit.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const env = await detectEnvironment(root)
const modules = env.nodeModules ?? join(root, "tools/node/node_modules")
const bun = join(modules, ".bin", process.platform === "win32" ? "bun.exe" : "bun")
const core = join(modules, "@tscircuit", "core")
const ROTATIONS = [0, 90, 180, 270]
const MAX_PINS = 80

test("every own footprint's pads sit where the placer computes them, at every quarter turn", { skip: !(existsSync(bun) && existsSync(core)) && "tscircuit core or bun missing", timeout: 300_000 }, () => {
	const footprints = [IMU_FOOTPRINT, MIC_FOOTPRINT, SO8E_FOOTPRINT, DDA_FOOTPRINT, XT60_FOOTPRINT, SY8368_FOOTPRINT, DC091_FOOTPRINT, ...Object.keys(MODULES)]
	const expected: Record<string, Record<string, { x: number; y: number }>> = {}
	const cases: string[] = []
	for (const fp of footprints) {
		const jsx = ownFootprint(fp)
		const pins = Array.from({ length: MAX_PINS }, (_, i) => i + 1).filter((n) => padOffset(fp, n, 0) !== null)
		if (!jsx || !pins.length) continue // no pad math to check
		for (const r of ROTATIONS) {
			const key = `${fp}@${r}`
			expected[key] = Object.fromEntries(pins.map((n) => [`pin${n}`, padOffset(fp, n, r)!]))
			cases.push(`[${JSON.stringify(key)}, <board width="60mm" height="60mm"><chip name="U1" pcbX={0} pcbY={0} pcbRotation={${r}} footprint=${jsx} /></board>],`)
		}
	}
	assert.ok(expected[`${IMU_FOOTPRINT}@0`], "the IMU has pad math")
	const dir = tempDir()
	const out = join(dir, "actual.json")
	// A polygon pad (the SY8368A's) by its points' box centre, as the placer reads it (sy8368PadCentre).
	writeFileSync(join(dir, "run.tsx"), `import { Circuit } from ${JSON.stringify(core)}
import { writeFileSync } from "node:fs"
const cases: [string, any][] = [
${cases.join("\n")}
]
const actual: Record<string, Record<string, { x: number; y: number }>> = {}
for (const [key, el] of cases) {
	const c = new Circuit()
	c.add(el)
	c.render()
	const j: any[] = c.getCircuitJson()
	actual[key] = {}
	for (const pad of j.filter((e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole")) {
		const hint = (pad.port_hints ?? []).find((h: string) => /^pin\\d+$/.test(h))
		if (!hint || actual[key][hint]) continue
		let x = pad.x, y = pad.y
		if (pad.points?.length) {
			const xs = pad.points.map((p: any) => p.x), ys = pad.points.map((p: any) => p.y)
			x = (Math.min(...xs) + Math.max(...xs)) / 2
			y = (Math.min(...ys) + Math.max(...ys)) / 2
		}
		// From the footprint's origin, where pcbX/pcbY put it (0, 0): what the placer's pad math measures from.
		actual[key][hint] = { x, y }
	}
}
writeFileSync(${JSON.stringify(out)}, JSON.stringify(actual))
`)
	execFileSync(bun, [join(dir, "run.tsx")], { cwd: dir, stdio: "pipe", timeout: 240_000 })
	const actual = JSON.parse(readFileSync(out, "utf8")) as typeof expected
	const off: string[] = []
	for (const [key, pins] of Object.entries(expected))
		for (const [pin, e] of Object.entries(pins)) {
			const a = actual[key]?.[pin]
			if (!a) off.push(`${key} ${pin}: no pad in tscircuit`)
			else if (Math.hypot(a.x - e.x, a.y - e.y) > 0.01) off.push(`${key} ${pin}: placer (${e.x}, ${e.y}), tscircuit (${a.x.toFixed(3)}, ${a.y.toFixed(3)})`)
		}
	assert.deepEqual(off, [])
})
