import { test } from "node:test"
import assert from "node:assert/strict"
import { checkConsistency, type ViolationKind } from "../src/contract/consistency.ts"
import { fixtureArtifacts, fixtureContract } from "./fixture.ts"

function only(kind: ViolationKind, affects: string[], mutate: (c: ReturnType<typeof fixtureContract>, a: ReturnType<typeof fixtureArtifacts>) => void) {
	const c = fixtureContract()
	const a = fixtureArtifacts()
	mutate(c, a)
	const v = checkConsistency(c, a)
	assert.equal(v.length, 1, JSON.stringify(v))
	assert.equal(v[0].kind, kind)
	assert.deepEqual(v[0].affects, affects)
}

test("consistent fixture has no violations", () => {
	assert.deepEqual(checkConsistency(fixtureContract(), fixtureArtifacts()), [])
})

test("outline-mismatch", () => only("outline-mismatch", ["board"], (_c, a) => { a.board!.widthMm = 52 }))

test("net-missing", () => only("net-missing", ["board"], (_c, a) => { a.board!.nets.I2C_SDA = ["U2.SDA"] }))

test("pin-mismatch", () => only("pin-mismatch", ["firmware"], (_c, a) => { a.firmware!.pins.I2C_SCL = 7 }))

test("cutout-missing", () => only("cutout-missing", ["enclosure"], (_c, a) => { a.enclosure!.cutouts = [] }))

test("cutout-misaligned", () => only("cutout-misaligned", ["enclosure"], (_c, a) => { a.enclosure!.cutouts[0].offsetMm = 18 }))

test("rail-overload", () => only("rail-overload", ["architect", "parts"], (c) => { c.values.rails![0].loadMa = 600 }))

test("firmware-build-failed", () => only("firmware-build-failed", ["firmware"], (_c, a) => { a.firmware!.ok = false }))

test("rules skip missing artifacts", () => {
	assert.deepEqual(checkConsistency(fixtureContract(), {}), [])
})
