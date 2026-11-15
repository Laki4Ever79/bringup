// A connector must sit on its edge, not past the end of it (bringup-lead, 14 Nov 2026: the scripted rover compacted to
// 44×28 mm with JT1 at top@43 mm; tscircuit refused the board, "JT1 extends outside board boundaries by 2.9mm", minutes
// into the build). Caught in plain code, on the contract, before any build.
import { test } from "node:test"
import assert from "node:assert/strict"
import { connectorsOffEdge } from "../src/contract/consistency.ts"
import { ROVER_BOARD, LOGGER_DESIGN } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const rover = (w: number, h: number, jt1: number): ContractSnapshot => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(ROVER_BOARD) } as ContractSnapshot["values"]
	s.values.outline = { widthMm: w, heightMm: h, thicknessMm: 1.6 }
	s.values.connectors = s.values.connectors!.map((c) => (c.ref === "JT1" ? { ...c, offsetMm: jt1 } : c))
	return s
}

test("a connector past the end of its edge is a violation for the architect, with the offsets that fit", () => {
	const v = connectorsOffEdge(rover(44, 28, 43))
	assert.equal(v.length, 1, JSON.stringify(v))
	assert.equal(v[0].kind, "connector-off-edge")
	assert.deepEqual(v[0].affects, ["architect"])
	assert.match(v[0].message, /JT1 \(top@43 mm\)/)
	assert.match(v[0].message, /from 3\.5 to 40\.5 mm/)
})

test("connectors on their edges pass: the rover as designed, scaled to 44 mm, and the logger", () => {
	assert.deepEqual(connectorsOffEdge(rover(60, 40, 42)), [])
	assert.deepEqual(connectorsOffEdge(rover(44, 28, 31)), [])
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	assert.deepEqual(connectorsOffEdge(s), [])
})

// Rover run cc-rover-3 (15 Nov 2026): the architect shrank the board from 78x17 to 78x16 mm and left J5 at right@13.5
// mm, 1 mm past the edge; the run ended with it open. The outline change now brings such a connector back onto its edge.
test("after an outline change, the connectors on an edge are packed back onto it with the least moves", async () => {
	const { connectorsOntoEdges, connectorClashes } = await import("../src/contract/consistency.ts")
	const { readFileSync } = await import("node:fs")
	const s = JSON.parse(readFileSync(new URL("./fixtures/cc-rover-3-78x16-rev25.json", import.meta.url), "utf8")) as ContractSnapshot
	assert.equal(connectorsOffEdge(s).length, 1)
	const fitted = connectorsOntoEdges(s)
	assert.ok(fitted)
	assert.equal(fitted.find((k) => k.ref === "J5")!.offsetMm, 12.5)
	// J5 alone at 12.5 would overlap JM2 on the 16 mm right edge, so JM2 steps down half a millimetre too.
	assert.equal(fitted.find((k) => k.ref === "JM2")!.offsetMm, 5.5)
	const others = (l: typeof fitted) => l.filter((k) => k.ref !== "J5" && k.ref !== "JM2")
	assert.deepEqual(others(fitted), others(s.values.connectors!))
	const after = { ...s, values: { ...s.values, connectors: fitted } }
	assert.deepEqual(connectorsOffEdge(after), [])
	assert.deepEqual(connectorClashes(after), [])
	assert.equal(connectorsOntoEdges(after), null)
})

// Rover run cc-rover-4 (15 Nov 2026): J1 at bottom@42 mm and JM2 at right@10 mm overlapped across the corner of a 54x24
// mm board; packing each edge alone can't see that.
test("connectors that overlap across a corner are moved apart along their edges", async () => {
	const { connectorsOntoEdges, connectorClashes } = await import("../src/contract/consistency.ts")
	const { readFileSync } = await import("node:fs")
	const s = JSON.parse(readFileSync(new URL("./fixtures/cc-rover-4-54x24-rev40.json", import.meta.url), "utf8")) as ContractSnapshot
	assert.ok(connectorClashes(s).length > 0, "the fixture has the run's clash")
	const fitted = connectorsOntoEdges(s)
	assert.ok(fitted)
	const after = { ...s, values: { ...s.values, connectors: fitted } }
	assert.deepEqual(connectorClashes(after), [])
	assert.deepEqual(connectorsOffEdge(after), [])
	const moved = fitted.filter((k) => s.values.connectors!.find((b) => b.ref === k.ref)!.offsetMm !== k.offsetMm)
	assert.ok(moved.length <= 2, JSON.stringify(moved))
})
