// Each board's screw follows its own holes (backlog: the chassis screwed a Raspberry Pi's Ø2.7 mm holes with the
// designed boards' M2 into an M2 pilot).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { boardScrew, chassisSpec } from "../src/tools/chassis.ts"
import { hardwareFit, robotPartLines } from "../src/tools/robot-parts.ts"

const main = JSON.parse(readFileSync("examples/rover-pi/boards/main/contract.json", "utf8")) as ContractSnapshot

test("a Ø2.2 mm hole takes M2 into a 1.6 mm pilot, a Ø2.7 mm one M2.5 into 2.1 mm", () => {
	assert.deepEqual(boardScrew(2.2), { threadMm: 2, pilotMm: 1.6 })
	assert.deepEqual(boardScrew(2.7), { threadMm: 2.5, pilotMm: 2.1 })
})

test("Rover with a Pi: the Pi's standoffs get the M2.5 pilot, main keeps M2; the parts list counts each screw and nothing misfits", () => {
	const spec = chassisSpec(main)!
	const brain = spec.boards.find((b) => b.name === "brain")!
	assert.deepEqual([brain.screwHoleMm, brain.pilotMm, brain.holes.length], [2.7, 2.1, 4])
	const own = spec.boards.find((b) => b.name === "main")!
	assert.equal(own.pilotMm, 1.6)
	const screws = robotPartLines(main).filter((l) => l.item === "board screw").map((l) => [l.mpn, l.qty])
	assert.deepEqual(screws, [["M2x8 self-tapping pan head screw (for plastic)", own.holes.length], ["M2.5x8 thread-forming pan head screw (for plastic)", 4]])
	assert.deepEqual(hardwareFit(main), [])
})

import { stackFit, MIN_ENGAGEMENT_MM } from "../src/system/compute.ts"
import { HAT_STACK, moduleById } from "../src/system/bought.ts"

test("the HAT's 8.5 mm socket at the 16 mm stack: the Pi's pin height is unknown, so it is a warning that says what is needed", () => {
	const pi = moduleById("rpi-5")!
	const hdr = { mpn: "ADAFRUIT-2223", socketHeightMm: 8.5, heightSource: "adafruit" }
	const [f] = stackFit(pi, hdr, HAT_STACK.mm, HAT_STACK.source)
	assert.equal(f.level, "warning")
	assert.match(f.message, new RegExp(`mouth is 7\\.5 mm above rpi-5's board .* at least ${7.5 + MIN_ENGAGEMENT_MM} mm tall`))
	// With a measured pin height: too short is an error naming the stack that would fit; tall enough passes.
	const withPins = (h: number) => ({ ...pi, compute: { ...pi.compute, header: { ...(pi.compute as any).header, pinHeightMm: { value: h, unit: "mm", source: { url: "x", where: "measured" } } } } }) as typeof pi
	const short = stackFit(withPins(8.5), hdr, 16)
	assert.deepEqual(short.map((x) => x.level), ["error"])
	assert.match(short[0].message, /lower the stack to 14 mm/)
	assert.deepEqual(stackFit(withPins(11), hdr, 16), [])
})
