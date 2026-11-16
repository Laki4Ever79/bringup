// Run cc-eurobot-15's review (16 Nov 2026): the base carried a bare LiPo pouch, which Eurobot's F.4.b (p. 11) allows only
// kept permanently in a certified fireproof bag with a homologated charger; LiFePO4 and a manufacturer's cased battery
// with its own BMS are exempt. A pouch in a case of our own is not that exemption.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mechanicsChecks } from "../src/mechanics/checks.ts"
import { completeForRules } from "../src/rules/layout.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const run15 = () => JSON.parse(readFileSync(new URL("./fixtures/cc-eurobot-15-rev31.json", import.meta.url), "utf8")) as ContractSnapshot
const f4b = (s: ContractSnapshot) => mechanicsChecks(s).filter((v) => /F\.4\.b/.test(v.message) && /fireproof bag/.test(v.message))

test("run 15's bare pouch is refused under Eurobot's F.4.b, naming the bag and the exemptions", () => {
	const v = f4b(run15())
	assert.equal(v.length, 1, JSON.stringify(mechanicsChecks(run15()).map((x) => x.message)))
	assert.match(v[0].message, /ADAFRUIT-2011 is a bare lithium pack/)
	assert.match(v[0].message, /LiFePO4 pack or a manufacturer's cased battery/)
})

test("in a fireproof bag it passes; completeForRules bags a bare lithium pack itself", () => {
	const s = run15()
	const bagged = { ...s, values: { ...s.values, mechanics: { ...s.values.mechanics!, battery: { ...s.values.mechanics!.battery, enclosure: "fireproof-bag" as const } } } }
	assert.deepEqual(f4b(bagged), [])
	const m = completeForRules(s.values.mechanics!, s.values, defaultCheckCatalog()!)
	assert.equal(m.battery.enclosure, "fireproof-bag")
})
