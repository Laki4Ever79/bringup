// Run cc-eurobot-11 (16 Nov 2026, Claude subscription): with the distance sensor's plug as the board's only I2C device,
// "needs an I2C bus" and "the plug takes no pins" contradicted each other, and the architect moved the bus on and off
// JT1 six times (revisions 15-29). The bus on the plug in the STEMMA QT order is allowed; other pins on it are not.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mechanicsChecks } from "../src/mechanics/checks.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const rev = (n: number) => JSON.parse(readFileSync(new URL(`./fixtures/cc-eurobot-11-rev${n}.json`, import.meta.url), "utf8")) as ContractSnapshot
const plugFindings = (s: ContractSnapshot) => mechanicsChecks(s).filter((v) => v.kind === "mech-wiring" && /JT1/.test(v.message))

test("revision 14: the bus on JT1.IO1/IO2 with no other I2C part is accepted", () => {
	assert.deepEqual(plugFindings(rev(14)).map((v) => v.message), [])
	assert.ok(!checkConsistency(rev(14), {}).some((v) => /JT1/.test(v.message) && /I2C/.test(v.message)), "no other check refuses it")
})

test("revision 15: with the bus removed, the finding says exactly where it may go", () => {
	const m = plugFindings(rev(15)).map((v) => v.message).join("\\n")
	assert.match(m, /needs an I2C bus/)
	assert.match(m, /I2C_SDA → JT1\.IO1 and I2C_SCL → JT1\.IO2/)
})

test("another signal on the plug, or the bus on the wrong plug pins, is still refused", () => {
	const s = rev(14)
	const swapped = { ...s, values: { ...s.values, pins: s.values.pins!.map((p) => (p.signal === "I2C_SDA" ? { ...p, partPin: "IO2" } : p.signal === "I2C_SCL" ? { ...p, partPin: "IO1" } : p)) } }
	assert.match(plugFindings(swapped).map((v) => v.message).join(), /remove them/)
})
