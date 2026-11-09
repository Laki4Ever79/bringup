// The mechanics agent and the scripted rover (briefs/rover.md): a whole scripted run settles with motion and mechanics
// set and no mechanics violation, and "make it 2 cm narrower" ripples through the mechanics design.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { mechanicsShapeError } from "../src/mechanics/shape.ts"
import { ROVER_MECHANICS } from "../src/inference/scripts.ts"
import { runDesign } from "../src/run.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

const ROOT = resolve(import.meta.dirname, "..")
const quiet = async <T>(fn: () => Promise<T>) => {
	const cloud = process.env.BRINGUP_CLOUD
	process.env.BRINGUP_CLOUD = "off"
	try {
		return await fn()
	} finally {
		if (cloud === undefined) delete process.env.BRINGUP_CLOUD
		else process.env.BRINGUP_CLOUD = cloud
	}
}
const lastContract = (out: string) => JSON.parse(readFileSync(join(out, "contract.json"), "utf8")).values
const mechViolations = (out: string) =>
	readFileSync(join(out, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "consistency.checked").at(-1)?.payload.violations.filter((v: { kind: string }) => v.kind.startsWith("mech-")) ?? []

test("the contract accepts the scripted rover's mechanics and rejects one without a drive", () => {
	assert.equal(mechanicsShapeError(ROVER_MECHANICS), null)
	const { drive: _d, ...noDrive } = ROVER_MECHANICS
	assert.match(mechanicsShapeError(noDrive) ?? "", /mechanics must be/)
})

test("a scripted rover run settles with motion and mechanics and no mechanics violation", { timeout: 90_000 }, async () => {
	const out = tempDir()
	const env = await detectEnvironment(ROOT)
	const r = await quiet(() => runDesign({ brief: readFileSync(join(ROOT, "briefs/rover.md"), "utf8"), mock: true, noHardware: true, outDir: out, env, timeoutMs: 80_000 }))
	assert.ok(r.settled)
	const v = lastContract(out)
	assert.equal(v.motion.speedMps, 0.3)
	assert.equal(v.mechanics.drive.motor, ROVER_MECHANICS.drive.motor)
	assert.deepEqual(mechViolations(out), [])
})

test("\"make it 2 cm narrower\" narrows the chassis and the run settles again", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const env = await detectEnvironment(ROOT)
	const r = await quiet(() => runDesign({ brief: readFileSync(join(ROOT, "briefs/rover.md"), "utf8"), mock: true, noHardware: true, outDir: out, env, timeoutMs: 110_000, changes: ["make it 2 cm narrower"] }))
	assert.ok(r.settled)
	const v = lastContract(out)
	assert.equal(v.mechanics.chassis.plateMm[1], ROVER_MECHANICS.chassis.plateMm[1] - 20)
	assert.equal(v.mechanics.drive.trackMm, ROVER_MECHANICS.drive.trackMm - 20)
	assert.deepEqual(mechViolations(out), [])
})

test("designers of a robot get the drive catalog and the computed mass in their facts; other boards don't", async () => {
	const { designFacts } = await import("../src/agents/design-facts.ts")
	const { ROVER_BOARD } = await import("../src/inference/scripts.ts")
	const { fixtureContract } = await import("./fixture.ts")
	const rover = designFacts({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) }, "").join("\n")
	assert.match(rover, /## Mechanics/)
	assert.match(rover, /POLOLU-2367 100:1 MP 6V: 6 V, 220 rpm, stall 0\.0922 N·m \/ 0\.67 A/)
	assert.match(rover, /mass about \d+ g/)
	assert.doesNotMatch(designFacts(fixtureContract(), "").join("\n"), /## Mechanics/)
})
