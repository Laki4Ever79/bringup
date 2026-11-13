import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { FORMULAS } from "../src/learn/formulas.ts"
import { loadKinds } from "../src/learn/kinds.ts"
import { completeFacts, judge } from "../src/learn/rule.ts"
import type { Fact } from "../src/learn/types.ts"

const kinds = loadKinds(resolve(import.meta.dirname, ".."))
const spk = kinds.get("speaker-driver")!
const amp = kinds.get("amplifier")!

const read = (field: string, value: Fact["value"], unit?: string): Fact => ({ field, value, unit, status: "datasheet", critical: false, check: "text", source: { doc: "d", page: 1, region: [0, 0, 1, 1], quote: String(value) } })
const speakerFacts = (qts: number): Fact[] => [read("outline", [40, 18.5], "mm"), read("height", 18.5, "mm"), read("mountHoles", "2 x 2.2 on 46"), read("pins", "+,-"), read("impedanceOhm", 8, "Ω"), read("ratedPowerW", 3, "W"), read("vasL", 0.12, "L"), read("qts", qts)]

test("sealed-box back volume from Vas and Qts", () => {
	const f = FORMULAS["sealed-box-min-volume"]
	assert.ok(Math.abs(f.fn({ vasL: 0.12, qts: 0.5 }) - 120.2) < 0.5)
	assert.ok(!Number.isFinite(f.fn({ vasL: 0.12, qts: 0.85 })), "Qts above 0.707 has no sealed box")
	assert.match(f.text, /Vas/)
})

test("a calculated fact shows its formula and inputs", () => {
	const facts = completeFacts(speakerFacts(0.5), spk)
	const v = facts.find((f) => f.field === "backVolumeMinCm3")!
	assert.equal(v.status, "calculated")
	assert.deepEqual(v.inputs, ["vasL", "qts"])
	assert.match(v.formula!, /Vas/)
	assert.equal(v.unit, "cm³")
})

test("no calculated fact when the formula has no answer", () => {
	assert.equal(completeFacts(speakerFacts(0.85), spk).find((f) => f.field === "backVolumeMinCm3"), undefined)
})

test("a missing non-critical field gets its default, marked red with the reason", () => {
	const facts = completeFacts(speakerFacts(0.5), spk)
	const k = facts.find((f) => f.field === "micKeepOutMm")!
	assert.equal(k.status, "default")
	assert.equal(k.value, 30)
	assert.match(k.reason!, /flagged/)
	const j = judge(facts, spk)
	assert.ok(j.ok)
	assert.deepEqual(j.reds.map((r) => r.field), ["micKeepOutMm"])
})

test("critical fields are marked critical", () => {
	const facts = completeFacts(speakerFacts(0.5), spk)
	assert.equal(facts.find((f) => f.field === "impedanceOhm")!.critical, true)
	assert.equal(facts.find((f) => f.field === "fsHz"), undefined)
	assert.equal(facts.find((f) => f.field === "vasL")!.critical, false)
})

test("a missing critical field is never defaulted", () => {
	const facts = completeFacts(speakerFacts(0.5).filter((f) => f.field !== "impedanceOhm"), spk)
	assert.equal(facts.find((f) => f.field === "impedanceOhm"), undefined)
	assert.deepEqual(judge(facts, spk), { ok: false, missingCritical: ["impedanceOhm"] })
})

test("a speaker without mount holes can be learned: the case clamps it by its rim, so its outline is what counts", () => {
	const facts = completeFacts(speakerFacts(0.5).filter((f) => f.field !== "mountHoles"), spk)
	assert.ok(judge(facts, spk).ok)
	assert.ok(spk.needs?.includes("clamp-rim"))
	assert.ok(judge(completeFacts(speakerFacts(0.5).filter((f) => f.field !== "outline"), spk), spk).ok === false)
})

test("a case part needs no footprint; a board part does", () => {
	assert.ok(judge(completeFacts(speakerFacts(0.5), spk), spk).ok)
	const ampFacts = completeFacts([read("outline", [3, 3], "mm"), read("height", 0.75, "mm"), read("pins", "SD,GAIN"), read("supplyMaxV", 6, "V"), read("supplyRange", [2.5, 5.5], "V"), read("minLoadOhm", 4, "Ω")], amp)
	assert.deepEqual(judge(ampFacts, amp), { ok: false, missingCritical: ["footprint"] })
})

test("non-critical fields with no default and no value are listed as unknown", () => {
	const j = judge(completeFacts(speakerFacts(0.5), spk), spk)
	assert.ok(j.ok)
	assert.ok(j.unknown.includes("fsHz"))
})

test("a speaker whose datasheet prints no terminal names gets + and - as a flagged default; it is still learned", () => {
	const facts = completeFacts(speakerFacts(0.5).filter((f) => f.field !== "pins"), spk)
	const pins = facts.find((f) => f.field === "pins")!
	assert.equal(pins.value, "+,-")
	assert.equal(pins.status, "default")
	assert.ok(judge(facts, spk).ok)
})
