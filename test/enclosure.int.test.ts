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
import { MIC_PART } from "../src/inference/scripts.ts"

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

test("a sensor gets a slot vent in the lid right over it, and the print check still passes", { skip }, async () => {
	const c = fixtureContract()
	const enclosure = await buildEnclosure(python!, root, tmp(), c, c.revision)
	const sensor = (enclosureSpec(c) as { sensors: { ref: string; xMm: number; yMm: number }[] }).sensors[0]
	const vent = enclosure.vents!.find((v) => v.ref === "U2")!
	// The grille stays inside the lid's lip, so near a corner its centre can sit a little off; the sensor stays under it.
	const msg = `vent ${vent.widthMm}×${vent.heightMm} mm at (${vent.xMm}, ${vent.yMm}), sensor at (${sensor.xMm}, ${sensor.yMm})`
	assert.ok(Math.abs(vent.xMm - sensor.xMm) <= vent.widthMm / 2 - 1 && Math.abs(vent.yMm - sensor.yMm) <= vent.heightMm / 2 - 1, msg)
	assert.ok(Math.hypot(vent.xMm - sensor.xMm, vent.yMm - sensor.yMm) < 1.5, msg)
	assert.ok(vent.widthMm >= 5 && vent.heightMm >= 5, msg)
	assert.deepEqual(enclosure.printCheck, { ok: true, issues: [] })
	const board = stubBoard(c, c.revision, tmp())
	assert.ok(board.placements?.U2, "the stub board reports where the generator placed U2")
	assert.deepEqual(checkConsistency(c, { board, enclosure }), [])
})

test("no sensor, no vent", { skip }, async () => {
	const c = fixtureContract()
	c.values.parts = c.values.parts!.filter((p) => p.role !== "sensor")
	c.values.pins = []
	const enclosure = await buildEnclosure(python!, root, tmp(), c, c.revision)
	assert.deepEqual(enclosure.vents, [])
	assert.deepEqual(enclosure.printCheck, { ok: true, issues: [] })
})

test("a microphone gets a round opening through the floor under its sound hole, and the print check still passes", { skip }, async () => {
	const c = fixtureContract()
	c.values.parts = [...c.values.parts!, MIC_PART]
	const enclosure = await buildEnclosure(python!, root, tmp(), c, c.revision)
	const hole = (enclosureSpec(c) as { ports: { ref: string; xMm: number; yMm: number }[] }).ports[0]
	const port = enclosure.ports!.find((p) => p.ref === "U5")!
	assert.ok(port, `ports: ${JSON.stringify(enclosure.ports)}`)
	assert.ok(Math.hypot(port.xMm - hole.xMm, port.yMm - hole.yMm) < 0.05, `opening at (${port.xMm}, ${port.yMm}), sound hole at (${hole.xMm}, ${hole.yMm})`)
	assert.ok(Math.abs(port.diameterMm - 2) < 0.05, `opening ø${port.diameterMm} mm`)
	assert.deepEqual(enclosure.printCheck, { ok: true, issues: [] })
	const board = stubBoard(c, c.revision, tmp())
	assert.ok(board.placements?.U5, "the stub board reports where the generator placed U5")
	assert.deepEqual(checkConsistency(c, { board, enclosure }).filter((v) => v.kind === "port-missing"), [])
})

test("no microphone, no opening in the floor", { skip }, async () => {
	const c = fixtureContract()
	const enclosure = await buildEnclosure(python!, root, tmp(), c, c.revision)
	assert.deepEqual(enclosure.ports, [])
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

test("the case field's features are built and measured on the solid, and the case still passes the print check", { skip }, async () => {
	const c = fixtureContract()
	c.values.case = {
		wallMm: 2,
		heightMm: 16,
		features: [
			{ id: "mount", kind: "wall-mount", sides: "top-bottom" },
			{ id: "loop", kind: "lanyard", corner: "top-right" },
			{ id: "label", kind: "text", text: "BRINGUP" },
			{ id: "gland", kind: "hole", edge: "right", offsetMm: 15, diameterMm: 6 },
		],
	}
	c.versions.case = 1
	const enclosure = await buildEnclosure(python!, root, tmp(), c, c.revision)
	assert.deepEqual(enclosure.printCheck, { ok: true, issues: [] })
	const byId = Object.fromEntries(enclosure.features!.map((f) => [f.id, f]))
	for (const id of ["mount", "loop", "label", "gland"]) assert.equal(byId[id]?.ok, true, `${id}: ${JSON.stringify(byId[id])}`)
	// The gland's hole, read back from the solid: 6 mm across, centred 15 mm along the right wall.
	assert.ok(Math.abs(byId.gland.offsetMm! - 15) < 0.1 && Math.abs(byId.gland.diameterMm! - 6) < 0.1, JSON.stringify(byId.gland))
	// The mount tabs' holes: 4.5 mm, centred on the top wall's tab (board 30 mm + 2 mm clearance + 2 mm wall + 5 mm).
	assert.ok(Math.abs(byId.mount.diameterMm! - 4.5) < 0.1 && Math.abs(Math.abs(byId.mount.yMm! - 15) - 24) < 0.1, JSON.stringify(byId.mount))
	assert.deepEqual(checkConsistency(c, { enclosure }).filter((v) => v.kind.startsWith("case-")), [])
})

test("the module's antenna hangs past the board edge, and the built case and lid leave it clear (either side)", { skip }, async () => {
	for (const edge of ["left", "right"] as const) {
		const c = fixtureContract()
		c.values.connectors = [{ ...c.values.connectors![0], edge }]
		const enclosure = await buildEnclosure(python!, root, tmp(), c, c.revision)
		assert.deepEqual(enclosure.printCheck, { ok: true, issues: [] }, `USB-C on the ${edge}`)
		// Measured back in the contract's frame: the cutout and the posts are where the board has them.
		assert.deepEqual(checkConsistency(c, { enclosure }).filter((v) => /cutout|standoff|vent|port/.test(v.kind)), [], `USB-C on the ${edge}`)
	}
})
