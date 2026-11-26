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

test("a pin named GND that the contract wires elsewhere isn't grounded by its name: the KF301 terminal on a spindle's minus lead", async () => {
	const { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } = await import("../src/inference/scripts.ts")
	const { fixtureContract } = await import("./fixture.ts")
	const base = fixtureContract()
	// The catalog's KF301 input terminal (pins VIN, GND) as the spindle's plug: its GND pin on the MOSFET's drain.
	const kf301 = { ref: "J3", role: "connector", mpn: "KF301-5.0-2P", lcsc: "C474881", footprint: "pinrow2_p5_id1.3_od2.6", pins: ["VIN", "GND"], nets: { VIN: "VMOT", GND: "@SPINDLE_N" } }
	const parts = [...CNC_DESIGN.parts.filter((p) => p.ref !== "J3"), kf301]
	const s = { ...base, values: { ...base.values, ...CNC_DESIGN, parts, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as typeof base
	const nets = generatedNets(s)
	assert.ok(nets.get("SPINDLE_N")!.includes("J3.GND"), "on the drain")
	assert.ok(!nets.get("GND")!.includes("J3.GND"), "not shorted to ground by its name")
	assert.deepEqual(pinsOnTwoNets(s).filter((e) => e.startsWith("J3.")), [])
	assert.ok(!supplyWiring(s).some((v) => v.kind === "net-short" && v.message.startsWith("J3.")))
	// A GND pin the contract leaves alone is still ground: the jack's.
	assert.ok(nets.get("GND")!.includes("J2.GND"))
})
