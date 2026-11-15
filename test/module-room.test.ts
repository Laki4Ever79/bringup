// One cause, one message (the real rover, run 5, 15 Nov 2026): the sensor connector J5 sat in the middle of the edge the
// radio module needs. module-blocked said "move J5"; space-room said "make the board 56×24 mm" for the same missing
// spot, and the build said "no room on the board" (read as "give it room"). The architect resized twice and shrank the
// board until its connectors ran off the edge. Now only module-blocked speaks, and the build waits on it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkConsistency } from "../src/contract/consistency.ts"
import { buildBoard, WAITING_ON_CONTRACT } from "../src/tools/board.ts"
import { LINK_CONNECTOR } from "../src/contract/links.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

// The logger (USB-C on the left, so the module goes on the right edge) with a header in the middle of that edge.
const blocked = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	s.values.parts = [...s.values.parts!, { ref: "J9", role: "connector", ...LINK_CONNECTOR, pins: [...LINK_CONNECTOR.pins] }]
	s.values.connectors = [...s.values.connectors!, { ref: "J9", kind: "header", edge: "right", offsetMm: 15, widthMm: 5.8, heightMm: 3 }]
	return s
}

test("a module kept off its edge by a connector is module-blocked's alone: no 'make the board bigger' for it", () => {
	const v = checkConsistency(blocked(), {})
	assert.ok(v.some((x) => x.kind === "module-blocked" && /J9/.test(x.message)), JSON.stringify(v.map((x) => x.kind)))
	assert.ok(!v.some((x) => x.kind === "space-room" && /\bU1\b/.test(x.message)), v.filter((x) => x.kind === "space-room").map((x) => x.message).join(" | "))
})

test("the board build waits on the connector instead of failing for room", async () => {
	const env = { root: "/nonexistent", tsci: "/nonexistent/tsci", kicad: null } as never
	await assert.rejects(buildBoard(env, tempDir(), blocked(), 1), (e: Error) => WAITING_ON_CONTRACT.test(e.message) && /U1/.test(e.message) && /J9/.test(e.message))
})
