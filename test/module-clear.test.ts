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
