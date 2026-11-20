// A connector in the radio module's strip moves along its edge to the nearest spot that clears it, in the same write
// (the Rover + climate system mock, 20 Nov 2026: main's link plug JL1 at right@20 mm blocked U1's edge every revision).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { connectorsOntoEdges } from "../src/contract/connectors.ts"
import { moduleBlocked } from "../src/codegen/circuit.ts"
import { connectorClashes, connectorsOffEdge } from "../src/contract/connectors.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

test("the rover's JL1 leaves the module's strip for the nearest clear spot on its edge", () => {
	const s = JSON.parse(readFileSync(new URL("./fixtures/rover-climate-main-rev17.json", import.meta.url), "utf8")) as ContractSnapshot
	assert.deepEqual(moduleBlocked(s)?.blockers, ["JL1"], "before: JL1 blocks U1's edge")
	const out = connectorsOntoEdges(s, { clearModule: true })!
	const after = { ...s, values: { ...s.values, connectors: out } }
	assert.equal(moduleBlocked(after), null)
	assert.equal(connectorsOffEdge(after).length + connectorClashes(after).length, 0)
	const jl1 = out.find((k) => k.ref === "JL1")!
	assert.equal(jl1.edge, "right")
	console.log("JL1 ->", jl1.edge, jl1.offsetMm)
	assert.equal(connectorsOntoEdges(after, { clearModule: true }), null, "already clear: nothing to do")
	assert.equal(connectorsOntoEdges(s), null, "without the option (the size search) nothing moves")
})

// The cheap module check (moduleSpotFree) gives the placement's own answer: the clearing asks it for every offset it
// tries, in the size search too.
test("the module's spot check agrees with the full placement on every size of the rover and the Eurobot base", async () => {
	const { moduleSpotFree, placeParts } = await import("../src/codegen/circuit.ts")
	let n = 0
	for (const f of ["rover-climate-main-rev17.json", "cc-eurobot-20b-final.json"]) {
		const s = JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as ContractSnapshot
		const mcu = s.values.parts!.find((p) => p.role === "mcu")!.ref
		for (let w = 26; w <= 60; w += 4) for (let h = 22; h <= 50; h += 4) {
			const t = { ...s, values: { ...s.values, outline: { ...s.values.outline!, widthMm: w, heightMm: h } } }
			let full: boolean
			try { full = placeParts(t).some((b) => b.ref === mcu) } catch { continue }
			assert.equal(moduleSpotFree(t), full, `${f} ${w}x${h}`)
			n++
		}
	}
	assert.ok(n > 50)
})

// The size search lays the connectors out as an outline change does, the module's strip cleared in both (bringup-board's
// min-place lesson): the smallest board it offers places once the outline changes to it.
test("the space model's smallest board places after the outline change to it, the module's strip cleared", async () => {
	const { minimumBoard, resized, placesAll } = await import("../src/contract/space.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/rover-climate-main-rev17.json", import.meta.url), "utf8")) as ContractSnapshot
	const m = minimumBoard(s)!
	const r = resized(s, m.widthMm, m.heightMm)
	assert.equal(moduleBlocked(r), null)
	assert.ok(placesAll(r, m.widthMm, m.heightMm))
})
