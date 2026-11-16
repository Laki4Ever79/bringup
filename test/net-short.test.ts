import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { generatedNets, ldoInputNet } from "../src/codegen/circuit.ts"
import { supplyWiring } from "../src/contract/consistency.ts"

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"))
const pinsOnTwoNets = (s: any) => {
	const on = new Map<string, string[]>()
	for (const [n, ends] of generatedNets(s)) for (const e of new Set(ends)) on.set(e, [...(on.get(e) ?? []), n])
	return [...on].filter(([, n]) => n.length > 1).map(([e]) => e)
}

test("the LDO input the contract names is its only source: USB 5 V never meets the cell (real run 15)", () => {
	const s = load("cc-eurobot-15-rev31.json")
	assert.equal(ldoInputNet(s), "VBAT")
	assert.ok(!(generatedNets(s).get("VBUS") ?? []).includes("U3.VIN"))
	assert.deepEqual(pinsOnTwoNets(s), [])
	assert.ok(!supplyWiring(s).some((v) => v.kind === "net-short"))
})

test("the LDO's own nets choose its source: a 2S pack over its rating leaves it on USB", () => {
	const s = load("cc-eurobot11-35x39-rev41.json")
	assert.equal(ldoInputNet(s), "VBUS")
	assert.deepEqual(pinsOnTwoNets(s), [])
})

test("a pin on two nets is refused, naming the fix: run 12's VM on VBAT would bypass the e-stop", () => {
	const v = supplyWiring(load("cc-eurobot-12-rev27.json")).filter((x) => x.kind === "net-short")
	assert.equal(v.length, 1)
	assert.match(v[0].message, /U5\.VM is on VBAT and MOTOR_VM/)
	assert.match(v[0].message, /drop it from U5's nets/)
})

test("no other board fixture puts a pin on two nets", () => {
	const skip = new Set(["cc-eurobot-12-rev27.json"])
	for (const f of readdirSync(new URL("./fixtures/", import.meta.url)).filter((f) => f.endsWith(".json") && !skip.has(f))) {
		const s = load(f)
		if (!s?.values?.parts) continue
		assert.deepEqual(pinsOnTwoNets(s), [], f)
	}
})
