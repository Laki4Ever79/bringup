// Every connector carrying a rail against its rated current, and the battery plug that mates the pack (lead decision,
// 17 Nov 2026: the Eurobot base with two servos drew 5.07 A through a 2 A JST PH battery plug).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { CONNECTOR_HEADROOM, mechanicsChecks, mechanicsFigures } from "../src/mechanics/checks.ts"
import { completePowerTree } from "../src/contract/power-auto.ts"
import { generatedNets } from "../src/codegen/circuit.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const fx = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as ContractSnapshot
const conn = (s: ContractSnapshot, ref: string) => mechanicsFigures(s).find((f) => f.check === `Connector current ${ref}`)!
const over = (s: ContractSnapshot) => mechanicsChecks(s).filter((v) => /is rated .* but carries/.test(v.message))

test("the mock Eurobot (2S XT60 pack, two servos): 5.07 A through the 2 A JST PH is refused; the XT60PW-M that mates the pack carries it", () => {
	const s = fx("mock-eurobot-rev8.json")
	assert.equal(conn(s, "J2").value, "5.07 A")
	assert.equal(conn(s, "J2").ok, false)
	assert.match(over(s)[0]?.message ?? "", /J2 .* is rated 2 A but carries 5\.07 A/)
	s.values.parts = completePowerTree(s.values.parts!, s.values.mechanics!, s).parts
	const j2 = s.values.parts!.find((p) => p.ref === "J2")!
	assert.deepEqual([j2.mpn, j2.lcsc, j2.role], ["XT60PW-M", "C98732", "battery"])
	assert.equal(conn(s, "J2").ok, true)
	assert.deepEqual(over(s), [])
	const n = generatedNets(s)
	assert.ok(n.get("GND")!.includes("J2.GND"))
	// The servo plugs: 2.5 A on a 3 A header passes the rating but not the 1.25x headroom: a figure, not a violation.
	assert.equal(CONNECTOR_HEADROOM, 1.25)
	assert.equal(conn(s, "JV1").ok, false)
})

test("a 1S Adafruit pack keeps the JST PH it mates (1.11 A of 2 A), and run 20's 2S pack gets its XT60", () => {
	const r = fx("cc-rover-9-rev24.json")
	r.values.parts = completePowerTree(r.values.parts!, r.values.mechanics!, r).parts
	assert.equal(r.values.parts!.find((p) => p.role === "battery")!.mpn, "S2B-PH-K-S(LF)(SN)")
	assert.equal(conn(r, "J2").ok, true)
	const e = fx("cc-eurobot-20-final.json")
	e.values.parts = completePowerTree(e.values.parts!, e.values.mechanics!, e).parts
	assert.equal(e.values.parts!.find((p) => p.role === "battery")!.mpn, "XT60PW-M")
})
