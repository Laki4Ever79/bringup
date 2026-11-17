// Power parts recognised by part number, and power modules made assemblable (lead decisions after real run 20, Eurobot,
// 17 Nov 2026).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { assemblableSupplies, completePowerTree } from "../src/contract/power-auto.ts"
import { generatedNets, SERVO_5V_NET, SERVO_FB_NET, SERVO_SW_NET, supportParts } from "../src/codegen/circuit.ts"
import { supplyWiring, unconnectedParts } from "../src/contract/consistency.ts"
import type { ContractSnapshot, Part } from "../src/contract/types.ts"

const fx = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as ContractSnapshot
const tree = (ps: Part[]) => ps.filter((p) => ["buck", "diode", "ideal-diode"].includes(p.role ?? "") || /D24V5F5|B5819W|AP63205/.test(p.mpn)).map((p) => `${p.ref} ${p.mpn} ${p.role}`).sort()

test("run 20 rev 20: the agents' step-down and Schottkys written as \"other\" are adopted, not doubled", () => {
	const s = fx("cc-eurobot-20-rev20.json")
	// The agents' write: rev 20 without what the code added beside it (U8, D12, D13).
	const written = s.values.parts!.filter((p) => !["U8", "D12", "D13"].includes(p.ref))
	const t = completePowerTree(written, s.values.mechanics!, s)
	assert.deepEqual(tree(t.parts), ["D10 B5819W SL diode", "D11 B5819W SL diode", "U7 AP63205WU-7 buck"])
	assert.match(t.note ?? "", /U7 POLOLU-2843 D24V5F5 is the catalog's buck/)
	// Before: rev 20 itself, the tree doubled.
	assert.equal(tree(s.values.parts!).length, 6)
})

test("U9: the servos' module supply becomes the SY8205 when it covers the pack and two servos at stall (5 A)", () => {
	const s = fx("mock-eurobot-rev8.json")
	const before = s.values.parts!.find((p) => p.role === "servo-supply")!
	assert.equal(before.lcsc, null)
	const a = assemblableSupplies(s.values.parts!, s.values.mechanics!)
	const u9 = a.parts.find((p) => p.role === "servo-supply")!
	assert.deepEqual([u9.ref, u9.mpn, u9.lcsc], [before.ref, "SY8205FCC", "C111875"])
	// Three servos (7.5 A) are over its 5 A: the module stays.
	const three = [...s.values.parts!, { ref: "JV9", role: "servo", mpn: "PZ254V-11-03P", lcsc: "C492402", footprint: "pinrow3", pins: ["SIG", "V5", "GND"] } as Part]
	assert.equal(assemblableSupplies(three, s.values.mechanics!).parts.find((p) => p.role === "servo-supply")!.mpn, before.mpn)
})

test("the SY8205 is wired as its application note draws it, with its parts, and nothing is left open", () => {
	const s = fx("mock-eurobot-rev8.json")
	s.values.parts = completePowerTree(s.values.parts!, s.values.mechanics!, s).parts
	const u = s.values.parts!.find((p) => p.role === "servo-supply")!
	assert.equal(u.mpn, "SY8205FCC")
	const n = generatedNets(s)
	for (const pin of ["PVIN", "PVIN_2"]) assert.ok(n.get("VBAT")!.includes(`${u.ref}.${pin}`), pin)
	assert.ok(n.get(SERVO_SW_NET)!.includes(`${u.ref}.LX`))
	assert.ok(n.get(SERVO_FB_NET)!.includes(`${u.ref}.FB`))
	assert.ok(n.get("GND")!.includes(`${u.ref}.GND`))
	assert.ok(!(n.get("V3V3") ?? []).includes(`${u.ref}.VCC_INT`), "its internal LDO's pin is on no rail")
	const mine = supportParts(s).filter((x) => x.near === u.ref)
	assert.deepEqual(mine.filter((x) => x.spec.kind === "inductor").map((x) => x.spec.mpn), ["SPM7054VT-4R7M-D"])
	assert.equal(mine.filter((x) => x.spec.value === "22uF" && "net" in x.a && x.a.net === SERVO_5V_NET).length, 3)
	assert.deepEqual(mine.filter((x) => /feedback divider/.test(x.job ?? "")).map((x) => x.spec.value).sort(), ["22k", "3k"])
	assert.deepEqual(unconnectedParts(s).map((v) => v.message.split(" is ")[0]), [])
	assert.deepEqual(supplyWiring(s).filter((v) => v.kind === "net-short"), [])
})
