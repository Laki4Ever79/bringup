import { test } from "node:test"
import assert from "node:assert/strict"
import { checkConsistency } from "../src/contract/consistency.ts"
import { regulatorRating } from "../src/contract/power.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}
const over = (s: ReturnType<typeof logger>) => checkConsistency(s, {}).filter((v) => v.kind === "regulator-overclaimed")

test("the catalog's regulators carry their rated output, with where it comes from", () => {
	const ldo = (mpn: string) => ({ ref: "U3", role: "ldo", mpn, lcsc: null, footprint: "sot23", pins: [] })
	assert.equal(regulatorRating(ldo("AP2112K-3.3TRG1"))?.maxMa, 600)
	assert.equal(regulatorRating(ldo("XC6206P332MR-G"))?.maxMa, 200)
	assert.match(regulatorRating(ldo("AP2112K-3.3TRG1"))!.source, /DS39724/)
	assert.equal(regulatorRating(ldo("LM1117")), null)
})

test("a rail can't claim more than its regulator part is rated for", () => {
	assert.deepEqual(over(logger()), [], "the logger's AP2112K is rated the 600 mA its rail claims")
	const s = logger()
	s.values.parts = s.values.parts!.map((p) => (p.role === "ldo" ? { ...p, mpn: "XC6206P332MR-G", lcsc: "C5446", footprint: "sot23", pins: ["GND", "VOUT", "VIN"] } : p))
	const v = over(s)
	assert.deepEqual(v.map((x) => x.affects), [["architect"]])
	assert.match(v[0].message, /3V3 claims a 600 mA regulator, but U3 XC6206P332MR-G is rated 200 mA/)
	s.values.rails = s.values.rails!.map((r) => ({ ...r, regulatorMaxMa: 200 }))
	assert.deepEqual(over(s), [])
})

test("the RT9080 is the low-Iq regulator the module can run from: rated 600 mA, 2 µA, the AP2112K's pins", async () => {
	const { estimatePower } = await import("../src/contract/power.ts")
	const rt = { ref: "U3", role: "ldo", mpn: "RT9080-33GJ5", lcsc: "C841192", footprint: "sot23_5", pins: ["VIN", "GND", "EN", "NC", "VOUT"] }
	assert.equal(regulatorRating(rt)?.maxMa, 600)
	assert.match(regulatorRating(rt)!.source, /DS9080-09/)
	const ap = logger()
	const s = logger()
	s.values.parts = s.values.parts!.map((p) => (p.role === "ldo" ? { ...rt, ref: p.ref } : p))
	// A drop-in: same pins, so the nets the architect wired to the AP2112K still land; no supply or rating violation.
	const kinds = (x: ReturnType<typeof logger>) => checkConsistency(x, {}).map((v) => v.kind)
	assert.deepEqual(kinds(s), kinds(ap))
	for (const k of ["supply-underrated", "regulator-overclaimed", "rail-underrated"] as const) assert.ok(!kinds(s).includes(k), k)
	const days = (x: ReturnType<typeof logger>) => estimatePower(x, "500 mAh").days!
	assert.ok(days(s) > days(ap) * 1.5, `RT9080 ${Math.round(days(s))} days vs AP2112K ${Math.round(days(ap))}`)
})
