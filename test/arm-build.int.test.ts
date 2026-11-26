// py/arm.py end to end through src/tools/arm.ts on the fixture arm: parts on disk, a clean sweep, links the contract takes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { armBuildChecks, buildArm, armWithLinks } from "../src/tools/arm.ts"
import { armShapeError } from "../src/arm/shape.ts"
import { tempDir } from "./helpers.ts"
import { ARM, TARGETS } from "./arm-contract.test.ts"

const python = join(ROOT, ".venv/bin/python")

test("buildArm: the fixture arm's printed parts, a clean sweep with the pick and drop poses, measured links", { skip: !existsSync(python) && "no .venv python", timeout: 600_000 }, async () => {
	const r = await buildArm(python, ROOT, tempDir(), { arm: ARM, armTargets: TARGETS })
	assert.ok(r.ok, JSON.stringify(r))
	assert.ok(r.files.some((f) => f.endsWith("upper-arm-bracket.stl")), r.files.join(" "))
	assert.ok(r.built.poses > 182, `${r.built.poses}`) // the grid plus the pick and drop poses
	assert.deepEqual(armBuildChecks(r), [])
	assert.equal(r.links.length, 5)
	const next = armWithLinks(ARM, r.links)!
	assert.equal(armShapeError(next), null)
})
