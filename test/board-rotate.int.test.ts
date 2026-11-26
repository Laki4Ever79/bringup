// The routed proof for a turned part (board page, 14 Nov 2026): the rover's motor driver turned 90° on the board page
// must still route, with VINT's and VCP's capacitors within tscircuit's 5 mm bound. If the layout turned the pads the
// other way from tscircuit's pcbRotation, those capacitors would land across the chip and the build would fail.
import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { layoutBoard } from "../src/codegen/circuit.ts"
import { applyMoves } from "../src/board-edit/board-move.ts"
import { buildBoard } from "../src/tools/board.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { ROVER_BOARD, STM32_LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { tempDir } from "./helpers.ts"

const env = await detectEnvironment(fileURLToPath(new URL("..", import.meta.url)))

for (const rotationDeg of [90, 180, 270] as const) {
	test(`the rover with its motor driver turned ${rotationDeg}° routes, its pin capacitors within their bound`, { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 600_000 }, async () => {
		const s: ContractSnapshot = { revision: 20, versions: {} as never, values: structuredClone(ROVER_BOARD) as ContractSnapshot["values"] }
		const W = s.values.outline!.widthMm, H = s.values.outline!.heightMm
		const u5 = layoutBoard(s).parts.find((p) => p.ref === "U5")!
		const t = applyMoves(s, [{ ref: "U5", xMm: u5.x + W / 2, yMm: u5.y + H / 2, rotationDeg }])
		assert.equal(layoutBoard(t).parts.find((p) => p.ref === "U5")?.rotation, rotationDeg)
		const board = await buildBoard(env, tempDir(), t, t.revision)
		assert.ok(board.pcbPath)
	})
}

// The same rule faces a bare chip's decoupling toward its pad with nothing turned: on the STM32 logger it turns C4
// (left of the chip, pin 1 had been outside). The board must still route.
test("the STM32 logger routes with its decoupling faced toward the pads", { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 600_000 }, async () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(STM32_LOGGER_DESIGN) }
	// Both pin capacitors face their pins: C4 (VDD) and, since the reserved capacitor spots (lead-3's placement change,
	// 26 Nov 2026), C6 on NRST (PF2) too. No contract passive is involved (the logger lists none), so nothing is claimed twice.
	assert.deepEqual(layoutBoard(s).parts.filter((p) => p.rotation === 180 && p.ref.startsWith("C")).map((p) => p.ref), ["C4", "C6"])
	const board = await buildBoard(env, tempDir(), s, s.revision)
	assert.ok(board.pcbPath)
})

// The saved rover-turn run (revision 13): the architect's 42×29 mm rover with U5 turned 180° on the board page. Its board
// left the debug footprint off for a router via 0.287 mm from the edge, and after a pin capacitor's ground moved to its
// part's own GND pin it didn't build at all (GND to C6 14.7 mm against 5, 15 Nov 2026). Now it routes clean with the
// footprint on: VINT's capacitor lies along VINT and GND, and a via near the edge moves inward (via-edge.ts).
test("the 42×29 mm rover with its driver turned 180° routes clean with its debug footprint", { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 900_000 }, async () => {
	const { readFileSync } = await import("node:fs")
	const s = JSON.parse(readFileSync(fileURLToPath(new URL("fixtures/rover-turn-42x29-rev13.json", import.meta.url)), "utf8")) as ContractSnapshot
	const board = await buildBoard(env, tempDir(), s, s.revision)
	assert.equal(board.drc?.errors, 0, board.drc?.firstError ?? "")
	assert.equal(board.debugPortDropped, undefined, board.debugPortDropped)
})

// The scripted rover at 43×28 mm (d9610c's mod-rover run, revision 11, 15 Nov 2026) left its debug footprint off for a
// GND via 0.1734 mm from one of the TC2030's unplated holes (the fab's 0.2 mm). The via now moves clear of the hole.
test("the scripted rover at 43×28 mm routes clean with its debug footprint", { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 900_000 }, async () => {
	const { readFileSync } = await import("node:fs")
	const s = JSON.parse(readFileSync(fileURLToPath(new URL("fixtures/mod-rover-43x28-rev11.json", import.meta.url)), "utf8")) as ContractSnapshot
	const board = await buildBoard(env, tempDir(), s, s.revision)
	assert.equal(board.drc?.errors, 0, board.drc?.firstError ?? "")
	assert.equal(board.debugPortDropped, undefined, board.debugPortDropped)
})

// The real rover run on the Claude subscription (cc-rover-1, 15 Nov 2026), revision 19: the architect's 64×25 mm board
// after 60×21 didn't route. Its build ran 12 minutes without a board until the run's deadline (every layout failed on
// VCP's capacitor and the along-the-pads retry was never built). It routes now.
// It keeps its debug footprint since a trace's corner too near the edge moves inward (JD1.pin2's trace ran 0.25 mm
// from the edge, via-edge.ts).
test("the subscription run's 64×25 mm rover routes clean with its debug footprint", { skip: !(env.tsci && env.kicad) && "tsci or KiCad missing", timeout: 1_200_000 }, async () => {
	const { readFileSync } = await import("node:fs")
	const s = JSON.parse(readFileSync(fileURLToPath(new URL("fixtures/cc-rover-64x25-rev19.json", import.meta.url)), "utf8")) as ContractSnapshot
	const board = await buildBoard(env, tempDir(), s, s.revision)
	assert.equal(board.drc?.errors, 0, board.drc?.firstError ?? "")
	assert.equal(board.debugPortDropped, undefined, board.debugPortDropped)
})
