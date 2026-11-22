// A size change the brief can't take is refused with the reason, not laid back out as a silent no-op (the rover's "make it
// 2 cm wider", 22 Nov 2026: over the brief's 150 x 120 mm, re-laid out at the old plate, and the run settled as if made).
import { test } from "node:test"
import assert from "node:assert/strict"
import { laidOut } from "../src/mechanics/solve.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const rover = () => ({ revision: 1, versions: {}, values: structuredClone(ROVER_BOARD) }) as unknown as ContractSnapshot
const resized = (s: ContractSnapshot, d: number) => {
	const m = s.values.mechanics!
	return { ...m, drive: { ...m.drive, trackMm: m.drive.trackMm + d }, chassis: { ...m.chassis, plateMm: [m.chassis.plateMm[0], m.chassis.plateMm[1] + d] as [number, number] } }
}

test("2 cm wider, over the brief's size, is refused with the reason; 2 cm narrower goes through", () => {
	const s = rover()
	const wide = laidOut(s, resized(s, 20), defaultCheckCatalog()!)
	assert.match(wide.refusal ?? "", /can't change size.*over the .* the brief allows/)
	const narrow = laidOut(s, resized(s, -20), defaultCheckCatalog()!)
	assert.equal(narrow.refusal, undefined)
	assert.equal(narrow.mechanics.chassis.plateMm[1], s.values.mechanics!.chassis.plateMm[1] - 20)
})
