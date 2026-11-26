// Every catalog part's footprint has a size the placer knows (circuit.ts knowsFootprintSize: the table, an MCU profile's
// extent, or a quad package's own w/h). An unknown one gets a 3 × 3 mm default and overlaps its neighbours on the board:
// the CNC's QFN28 drivers (mock run 5) and then its JST XH plugs (mock run 8), every board build failed on courtyards.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { knowsFootprintSize } from "../src/codegen/circuit.ts"

test("every catalog footprint has a placement size (no 3 mm default)", () => {
	const parts = JSON.parse(readFileSync(join(import.meta.dirname, "../catalog/parts.json"), "utf8")) as { mpn: string; footprint?: string }[]
	assert.deepEqual(parts.filter((p) => p.footprint && !knowsFootprintSize(p.footprint)).map((p) => `${p.mpn}: ${p.footprint}`), [])
})
