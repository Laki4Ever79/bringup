import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkConsistency } from "../src/contract/consistency.ts"
import { buildEnclosure, enclosureSpec } from "../src/tools/enclosure.ts"
import { stubBoard } from "../src/tools/stubs.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const python = [join(root, ".venv/bin/python")].find(existsSync)
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

test("print-ready: a lid, a standoff under each board hole, raised cutouts and a passing print check", { skip }, async () => {
	const c = fixtureContract()
	const enclosure = await buildEnclosure(python!, root, tmp(), c, c.revision)
	assert.ok(statSync(enclosure.lidStlPath!).size > 0)
	assert.ok(statSync(enclosure.lidStepPath!).size > 0)
	assert.deepEqual(enclosure.printCheck, { ok: true, issues: [] })
	assert.deepEqual(enclosure.standoffs!.map((p) => [Math.round(p.xMm * 10) / 10, Math.round(p.yMm * 10) / 10, p.holeMm]), [[3, 3, 1.6], [47, 3, 1.6], [3, 27, 1.6], [47, 27, 1.6]])
	const board = stubBoard(c, c.revision, tmp())
	assert.deepEqual(checkConsistency(c, { board, enclosure }), [])
	// The board's underside sits on the 3 mm posts over the 2 mm floor, so J1 (3.5 mm tall) is centred 8.35 mm up.
	const j1 = enclosure.cutouts.find((x) => x.ref === "J1")!
	assert.ok(Math.abs(j1.zMm! - (2 + 3 + 1.6 + 3.5 / 2)) < 0.05, `J1 cutout centre at ${j1.zMm} mm`)
})

function printCheckOf(mutate: (spec: Record<string, any>) => void) {
	const dir = tmp()
	const spec = enclosureSpec(fixtureContract()) as Record<string, any>
	mutate(spec)
	writeFileSync(join(dir, "spec.json"), JSON.stringify(spec))
	const r = spawnSync(python!, [join(root, "py/enclosure.py"), join(dir, "spec.json"), dir], { encoding: "utf8" })
	assert.equal(r.status, 0, r.stderr)
	return JSON.parse(readFileSync(join(dir, "print.json"), "utf8")) as { ok: boolean; issues: string[] }
}

test("the print check catches a thin wall, a long bridge and a lid that won't fit", { skip }, () => {
	const thin = printCheckOf((s) => { s.wallMm = 1 })
	assert.equal(thin.ok, false)
	assert.ok(thin.issues.some((i) => /wall 1(\.0)? mm < 1\.2 mm/.test(i)), thin.issues.join("; "))

	const bridge = printCheckOf((s) => { s.connectors = [{ ref: "J9", kind: "header", edge: "bottom", offsetMm: 25, widthMm: 16, heightMm: 2 }] })
	assert.equal(bridge.ok, false)
	assert.ok(bridge.issues.some((i) => /J9: 17(\.0)? mm bridge/.test(i)), bridge.issues.join("; "))

	const tight = printCheckOf((s) => { s.lid.clearanceMm = 0.05 })
	assert.equal(tight.ok, false)
	assert.ok(tight.issues.some((i) => /lid clearance 0\.05 mm/.test(i)), tight.issues.join("; "))
})
