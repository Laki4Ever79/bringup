// Why each thing on the board is there (engineer, 13 Nov 2026): every part, passive, pad and the debug footprint gets
// a reason from something recorded when it was decided, never one made up afterwards.
import { test } from "node:test"
import assert from "node:assert/strict"
import { boardParts, bringupPads, debugPort, recoveryPads } from "../src/codegen/circuit.ts"
import { partReasons } from "../src/contract/reasons.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

test("every part on the board, every pad and the debug footprint has a reason with its source", () => {
	const s = logger()
	const r = partReasons(s)
	const refs = new Set(r.map((x) => x.ref))
	for (const b of boardParts(s)) assert.ok(refs.has(b.ref), `${b.ref} has a reason`)
	for (const p of [...recoveryPads(s).placed, ...bringupPads(s).placed]) assert.ok(refs.has(p.ref), p.ref)
	assert.ok(refs.has(debugPort(s).placed!.ref))
	for (const x of r) {
		assert.ok(x.why.length > 10, `${x.ref}: ${x.why}`)
		assert.ok(["recorded", "added", "datasheet", "rule", "none"].includes(x.source.kind))
	}
})

test("a chosen part shows the reason recorded when it was chosen, and its catalog facts apart", () => {
	const u2 = partReasons(logger()).find((x) => x.ref === "U2")!
	assert.equal(u2.source.kind, "recorded")
	assert.match(u2.why, /Temperature and humidity/)
	assert.match(u2.facts ?? "", /±1\.8 %RH/)
	assert.ok(u2.nets.includes("I2C_SDA"))
})

test("a passive says what it is for and where its value comes from; the reset RC points to its Added-for-you item", () => {
	const r = partReasons(logger())
	const r10 = r.find((x) => x.ref === "R10")!
	assert.equal(r10.what, "10k resistor")
	assert.match(r10.why, /EN reset RC/)
	assert.equal(r10.source.kind, "datasheet")
	assert.match(r10.source.detail, /Espressif/)
	assert.equal(r10.added?.id, "en-reset")
	const cc = r.find((x) => /USB-C CC1/.test(x.why))!
	assert.match(cc.source.detail, /5\.1 kΩ/)
})

test("pads and the debug footprint are on the bottom and say how to turn them off", () => {
	const r = partReasons(logger())
	const jd = r.find((x) => x.ref === "JD1")!
	assert.equal(jd.side, "bottom")
	assert.match(jd.added?.change ?? "", /debugPort/)
	const tp = r.find((x) => x.ref === "TP1")!
	assert.equal(tp.side, "bottom")
	assert.equal(tp.added?.id, "bringup-pads")
})

test("a part chosen without a recorded reason says so, or gives the generator's rule, never an invented why", () => {
	const s = logger()
	s.values.parts = s.values.parts!.map((p) => (p.ref === "U2" ? { ...p, reason: undefined } : p.ref === "U3" ? { ...p, reason: undefined } : p))
	const r = partReasons(s)
	const u2 = r.find((x) => x.ref === "U2")!
	assert.equal(u2.source.kind, "none")
	assert.equal(u2.why, "No reason was recorded for this part.")
	assert.equal(r.find((x) => x.ref === "U3")!.source.kind, "rule")
})
