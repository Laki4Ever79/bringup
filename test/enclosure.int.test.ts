import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkConsistency } from "../src/contract/consistency.ts"
import { buildEnclosure } from "../src/tools/enclosure.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const python = [join(root, ".venv/bin/python"), resolve(root, "../agent-mesh/.venv/bin/python")].find(existsSync)
const skip = python ? false : "no .venv python with build123d"

function tmp() {
	return mkdtempSync(join(tmpdir(), "bringup-enclosure-"))
}

test("enclosure cutouts match connectors", { skip }, async () => {
	const c = fixtureContract()
	const enclosure = await buildEnclosure(python!, root, tmp(), c, c.revision)
	assert.equal(enclosure.revision, c.revision)
	assert.ok(statSync(enclosure.stlPath).size > 0)
	assert.ok(statSync(enclosure.stepPath).size > 0)
	const cutoutViolations = checkConsistency(fixtureContract(), { enclosure }).filter((v) => v.kind.startsWith("cutout-"))
	assert.deepEqual(cutoutViolations, [])
})

test("moving J1 moves the cutout", { skip }, async () => {
	const c = fixtureContract()
	c.values.connectors![0].offsetMm = 10
	const enclosure = await buildEnclosure(python!, root, tmp(), c, c.revision)
	const j1 = enclosure.cutouts.find((x) => x.ref === "J1")!
	assert.equal(j1.edge, "left")
	assert.ok(Math.abs(j1.offsetMm - 10) < 0.1, `cutout at ${j1.offsetMm} mm`)
	// The old contract (J1 at 15 mm) no longer matches this case.
	const kinds = checkConsistency(fixtureContract(), { enclosure }).map((v) => v.kind)
	assert.deepEqual(kinds, ["cutout-misaligned"])
})

test("a connector off the board fails with the script's message", { skip }, async () => {
	const c = fixtureContract()
	c.values.connectors![0].offsetMm = 40
	await assert.rejects(buildEnclosure(python!, root, tmp(), c, c.revision), /J1/)
})
