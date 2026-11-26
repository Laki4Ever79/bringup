// Every catalog footprint tscircuit draws from a string keeps its own pads apart (26 Nov 2026, on a CNC branch: the
// TMC2209's QFN28 at tscircuit's default pad length ran its pins into the 3.7 mm exposed pad, and every board build failed on
// "Pads U6.OA1 and unnamed SMD pad are too close (clearance: 0mm, minimum: 0.1mm)").
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { ownFootprint } from "../src/codegen/circuit.ts"

const ROOT = join(import.meta.dirname, "..")
const MIN_MM = 0.1 // tscircuit's own pad clearance minimum (its DRC message)

test("every catalog footprint's pads keep tscircuit's 0.1 mm clearance from each other", async () => {
	const lib = await import(pathToFileURL(join(ROOT, "tools/node/node_modules/@tscircuit/footprinter/dist/index.js")).href).catch(() => null)
	if (!lib) return // tscircuit not installed here (npm run setup): nothing to draw with
	const fp = lib.fp ?? lib.default?.fp
	const parts = JSON.parse(readFileSync(join(ROOT, "catalog/parts.json"), "utf8")) as { mpn: string; footprint?: string }[]
	const tight: string[] = []
	let drawn = 0
	// The ones the board generator draws itself (circuit.ts ownFootprint: the IMU's lands, a module's) are its own business.
	for (const f of new Set(parts.map((p) => p.footprint).filter((f): f is string => !!f && !ownFootprint(f)))) {
		let pads: { x: number; y: number; width: number; height: number; shape?: string }[]
		try {
			pads = fp.string(f).circuitJson().filter((x: { type: string }) => x.type === "pcb_smtpad")
		} catch {
			continue // a custom footprint (a module's own land pattern), not a footprinter string
		}
		drawn++
		const rect = pads.filter((p) => p.width !== undefined && p.height !== undefined)
		for (let i = 0; i < rect.length; i++)
			for (let j = i + 1; j < rect.length; j++) {
				const a = rect[i], b = rect[j]
				const dx = Math.abs(a.x - b.x) - (a.width + b.width) / 2, dy = Math.abs(a.y - b.y) - (a.height + b.height) / 2
				const gap = dx < 0 && dy < 0 ? Math.max(dx, dy) : Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
				if (gap < MIN_MM - 1e-6) { tight.push(`${f}: ${gap.toFixed(3)} mm`); i = rect.length; break }
			}
	}
	assert.ok(drawn > 5, `drew ${drawn} footprints`)
	assert.deepEqual(tight, [])
})
