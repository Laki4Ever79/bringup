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
