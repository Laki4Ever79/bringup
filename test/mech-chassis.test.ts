// The chassis builder's TypeScript side (src/tools/chassis.ts): the spec it writes from the contract, and a chassis
// that can't be built failing with the generator's reason.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildChassis, chassisSpec } from "../src/tools/chassis.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { tempDir } from "./helpers.ts"

const ROOT = resolve(import.meta.dirname, "..")
const python = join(ROOT, ".venv/bin/python")
const rover = (): ContractSnapshot => ({ revision: 3, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })

test("the chassis spec carries the plate, both motors, the caster's holes, the battery, the board and the sensor", () => {
	const spec = chassisSpec(rover())!
	assert.deepEqual([spec.plate.lengthMm, spec.plate.widthMm, spec.plate.clearanceMm], [150, 110, 50.5])
	assert.deepEqual(spec.motors.map((m) => m.side), ["left", "right"])
	assert.equal(spec.caster.holesMm.length, 4)
	assert.deepEqual(spec.boards.map((b) => [b.name, b.widthMm, b.heightMm]), [["main", 60, 40]])
	assert.equal(spec.sensor.xMm, 72)
	assert.equal(spec.edgeMm, 3, "the simulated course's step is the brief's edge")
	assert.ok(spec.motors.every((m) => m.axleDropMm === 10.5), "the brackets drop to the 40 mm axle")
	assert.ok(spec.massG > 100 && spec.com.length === 3, "mass and centre of mass for the simulation")
})

test("no mechanics, no chassis spec", () => {
	const s = rover()
	delete (s.values as Record<string, unknown>).mechanics
	assert.equal(chassisSpec(s), null)
})

test("a chassis that can't be built fails with the generator's reason", { skip: existsSync(python) ? false : "needs .venv with build123d", timeout: 120_000 }, async () => {
	const s = rover()
	s.values.mechanics!.chassis.plateMm = [50, 30]
	const r = await buildChassis(python, ROOT, tempDir(), s, 3)
	assert.equal(r.ok, false)
	assert.match(r.ok ? "" : r.reason, /board main .* doesn't fit/)
})
