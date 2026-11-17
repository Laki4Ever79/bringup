// A robot's 5 V step-down is a chip JLCPCB assembles, the AP63205 with its datasheet's parts, not the Pololu module
// (real run 20, Eurobot, 17 Nov 2026: the D24V5F5 had no LCSC number, and the 46x38 board had no room for its header,
// so the run kept 56x46). The module stays the fallback for a pack over the chip's 32 V.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { completePowerTree } from "../src/contract/power-auto.ts"
import { BUCK_NET, BUCK_SW_NET, generatedNets, supportParts } from "../src/codegen/circuit.ts"
import { checkConsistency, packVoltage, supplyWiring, unconnectedParts } from "../src/contract/consistency.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const s17 = () => JSON.parse(readFileSync(new URL("./fixtures/cc-eurobot-19b-rev17.json", import.meta.url), "utf8")) as ContractSnapshot
const withTree = () => {
	const s = s17()
	s.values.parts = completePowerTree(s.values.parts!, s.values.mechanics!, s).parts
	return s
}

test("the 2S pack's step-down is the AP63205 (LCSC C2071056), wired EN/VIN to the pack, FB to 5 V, SW to its inductor", () => {
	const s = withTree()
	const buck = s.values.parts!.find((p) => p.role === "buck")!
	assert.equal(buck.mpn, "AP63205WU-7")
	assert.equal(buck.lcsc, "C2071056")
	const n = generatedNets(s)
	for (const pin of ["VIN", "EN"]) assert.ok(n.get("VBAT")!.includes(`${buck.ref}.${pin}`), pin)
	assert.ok(n.get(BUCK_NET)!.includes(`${buck.ref}.FB`))
	assert.ok(n.get(BUCK_SW_NET)!.includes(`${buck.ref}.SW`))
	assert.ok(n.get("GND")!.includes(`${buck.ref}.GND`))
})

test("its Table 3 parts come with it: 4.7 uH, 10 uF in, 2 x 22 uF out, 100 nF BST to SW", () => {
	const s = withTree()
	const ref = s.values.parts!.find((p) => p.role === "buck")!.ref
	const mine = supportParts(s).filter((x) => x.near === ref)
	const by = (v: string) => mine.filter((x) => x.spec.value === v)
	assert.deepEqual(by("4.7uH").map((x) => [x.spec.kind, x.spec.lcsc, x.ref.startsWith("L")]), [["inductor", "C92961", true]])
	assert.equal(by("10uF").length, 1)
	assert.equal(by("22uF").length, 2)
	const bst = by("100nF")[0]
	assert.deepEqual([bst.a, bst.b], [{ ref, pin: "BST" }, { net: BUCK_SW_NET }])
})

test("the power tree with the chip: no short, no rail without a source, no part on nothing, nothing over its rating", () => {
	const s = withTree()
	const kinds = [...supplyWiring(s), ...packVoltage(s)].map((v) => v.kind)
	assert.deepEqual(kinds.filter((k) => ["net-short", "rail-battery-source", "rail-unwired", "pack-voltage", "charger-pack"].includes(k)), [])
	assert.deepEqual(unconnectedParts(s).map((v) => v.message.split(" is ")[0]), [])
	assert.deepEqual(checkConsistency(s, {}).filter((v) => v.kind === "net-short"), [])
})
