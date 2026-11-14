// The routed proof for a turned part (board page, 14 Nov 2026): the rover's motor driver turned 90° on the board page
// must still route, with VINT's and VCP's capacitors within tscircuit's 5 mm bound. If the layout turned the pads the
// other way from tscircuit's pcbRotation, those capacitors would land across the chip and the build would fail.
import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { layoutBoard } from "../src/codegen/circuit.ts"
import { applyMoves } from "../src/dashboard/board-move.ts"
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
	assert.deepEqual(layoutBoard(s).parts.filter((p) => p.rotation === 180 && p.ref.startsWith("C")).map((p) => p.ref), ["C4"])
	const board = await buildBoard(env, tempDir(), s, s.revision)
	assert.ok(board.pcbPath)
})
