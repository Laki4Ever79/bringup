// py/arm.py end to end through src/tools/arm.ts on the fixture arm: parts on disk, a clean sweep, links the contract takes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { armBuildChecks, buildArm, armWithLinks } from "../src/tools/arm.ts"
import { armPictures } from "../src/package/assembly-pictures.ts"
import { readFileSync } from "node:fs"
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
	// The build package's pictures: the arm at rest, one step per body from the base to the gripper (py/stills.py --groups).
	assert.ok(r.files.every((f) => !f.endsWith("/posed")), "only files, not the posed/ folder")
	const groups = JSON.parse(readFileSync(join(r.dir, "posed", "groups.json"), "utf8"))
	assert.deepEqual(groups.steps.map((g: { name: string }) => g.name), ["base", "turntable", "upper-arm", "forearm", "wrist", "gripper"])
	const out = tempDir()
	const pics = await armPictures(python, ROOT, join(r.dir, "posed"), out)
	assert.equal(pics.note, null)
	assert.deepEqual(pics.files, ["step-1-base", "step-2-turntable", "step-3-upper-arm", "step-4-forearm", "step-5-wrist", "step-6-gripper", "exploded", "view-top", "view-side"].map((f) => `assembly/${f}.png`))
	assert.ok(pics.files.every((f) => existsSync(join(out, f))))
})
