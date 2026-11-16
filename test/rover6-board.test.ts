// The real rover run 6 (16 Nov 2026, adopt 0867029) failed both its board builds at 44×29 mm. Rev 20: JT1's courtyard
// 0.4 mm past the right edge ("Autorouting was skipped"). Rev 21: U5's capacitors placed 4 mm from their pins, VM's
// trace 8.18 mm against 5, and nothing for the drawn-trace retry to draw.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { capPaths, layoutBoard } from "../src/codegen/circuit.ts"
import { connectorsOffEdge, connectorsOntoEdges } from "../src/contract/consistency.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as ContractSnapshot

test("a JST SH plug is judged along its edge by its 7.8 mm courtyard, so the packer keeps it inside", () => {
	const s = fixture("cc-rover6-44x29-rev20.json")
	const v = connectorsOffEdge(s)
	assert.equal(v.length, 1)
	assert.match(v[0].message, /JT1 \(right@25.5 mm\) runs 0.4 mm past the end of the 29 mm right edge: its footprint is 7.8 mm along it/)
	const packed = connectorsOntoEdges(s)!
	assert.equal(packed.find((k) => k.ref === "JT1")?.offsetMm, 25)
	assert.deepEqual(connectorsOffEdge({ ...s, values: { ...s.values, connectors: packed } }), [])
})

test("a part's pin capacitors are reserved where placement can put them: beside their pins, on the grid, apart", () => {
	const s = fixture("cc-rover6-44x29-rev21.json")
	const L = layoutBoard(s, { ldoFromUsbMm: 8 })
	const at = (ref: string) => L.parts.find((p) => p.ref === ref)!
	const u5 = at("U5")
	// Both on U5's pin side, within 2 mm of its row's centre height, not 4 mm away.
	for (const ref of ["C3", "C4"]) {
		const c = at(ref)
		assert.ok(c.x > u5.x + u5.w / 2 && c.x - (u5.x + u5.w / 2) < 3, `${ref} x ${c.x}`)
		assert.ok(Math.abs(c.y - u5.y) <= 2.5, `${ref} y ${c.y} vs U5 ${u5.y}`)
	}
	// So the retry has its four traces to draw, each within 5 mm.
	const paths = capPaths(s, { ldoFromUsbMm: 8 })
	assert.equal(paths.length, 4)
	assert.ok(paths.every((p) => p.lengthMm <= 5), paths.map((p) => p.lengthMm).join(","))
})

// Real rover run 9 (16 Nov 2026, from 678b509), rev 23 at 58×22 mm: the build failed once on VM's trace (5.84 mm against
// 5). The layout is right (C3 and C4 beside U5's pins, the four traces drawable at 2.1-4.25 mm, the drawCaps retry
// offered), but tscircuit's autorouter doesn't avoid drawn traces: by hand at 678b509 the retry had a via on VM's drawn
// trace and two routes 0.04-0.09 mm from it. Keepouts along them and pcbRouteHints were tried and don't help (backlog).
test("run 9's 58×22 board gets the drawn-trace retry with its four traces within reach", async () => {
	const { layoutAttempts } = await import("../src/tools/board.ts")
	const s = fixture("cc-rover9-58x22-rev23.json")
	assert.ok(layoutAttempts(s, [{ ldoFromUsbMm: 8 }]).some((p) => p.drawCaps))
	const paths = capPaths(s, { ldoFromUsbMm: 8 })
	assert.equal(paths.length, 4)
	assert.ok(paths.every((p) => p.lengthMm <= 5))
})
