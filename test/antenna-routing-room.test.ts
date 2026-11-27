// A board grown so the router has room keeps the antenna's 4 mm floor: the room is the router's. A deeper band took it
// back as the mock rover widened (6 mm at 45×29, 12 at 49×29, 15 at 53×29 and 55×29), its IMU's capacitors routed long
// at every width, and without Freerouting the run ended unsettled at r16 (OS smoke run 45952251126, 27 Nov 2026).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ANTENNA_CLEAR_MM, layoutBoard } from "../src/codegen/circuit.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const rover = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/rover-routing-55x29-rev16.json"), "utf8")) as ContractSnapshot

test("a board widened for routing keeps the 4 mm band; the same board at its own size takes the deepest that places", () => {
	assert.equal(rover.values.outline?.sizeReason?.kind, "routing")
	assert.equal(layoutBoard(rover).antennaClearMm, ANTENNA_CLEAR_MM.at(-1))
	const own = structuredClone(rover)
	delete own.values.outline!.sizeReason
	assert.ok((layoutBoard(own).antennaClearMm ?? 0) > ANTENNA_CLEAR_MM.at(-1)!, "without the routing reason the band is deeper")
})
