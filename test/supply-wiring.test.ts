// Supply pins named by the contract (Part.nets), copper sized for the rail's current, and the checks that catch a rail
// wired to nothing (the rpi-5 HAT, 15 Nov 2026: its 5V rail reached no header pin).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { circuitFromContract, DEFAULT_TRACE_MM, generatedNets, ipc2221WidthMm, MAX_TRACK_MM, netTraceWidths, supplyPours, THROUGH_HOLE_FOOTPRINT, wideTracks } from "../src/codegen/circuit.ts"
import { supplyWiring } from "../src/contract/consistency.ts"
import { hatDesign, hatFromBrief } from "../src/inference/scripts.ts"

const hat = (): ContractSnapshot => {
	const d = hatDesign(hatFromBrief(readFileSync("briefs/rpi-5-carrier.md", "utf8"))!)
	return { revision: 1, values: { requirements: d.requirements, outline: d.outline, connectors: d.connectors, rails: d.rails, parts: d.parts, pins: d.pins } } as unknown as ContractSnapshot
}

test("IPC-2221 widths: the default track holds 0.6 A, 5 A needs about 2.8 mm (10 °C rise, 1 oz)", () => {
	assert.ok(ipc2221WidthMm(0.6) <= DEFAULT_TRACE_MM)
	assert.equal(ipc2221WidthMm(5), 2.8)
})

test("the HAT's header pins 2 and 4 and the input's VIN share the 5 V net; its ground pins and the input's GND share ground", () => {
	const nets = generatedNets(hat())
	assert.deepEqual(nets.get("V5V")!.sort(), ["J1.2", "J1.4", "J2.VIN"])
	for (const pin of ["6", "9", "14", "20", "25", "30", "34", "39"]) assert.ok(nets.get("GND")!.includes(`J1.${pin}`), pin)
	assert.ok(nets.get("GND")!.includes("J2.GND"))
	assert.deepEqual(supplyWiring(hat()), [])
})

test("a 5 A rail is poured (5 V on top, ground below), not a track wider than a header's pin gap", () => {
	const c = hat()
	assert.deepEqual(supplyPours(c), [{ net: "V5V", layer: "top" }, { net: "GND", layer: "bottom" }])
	assert.equal(netTraceWidths(c).size, 0)
	const src = circuitFromContract(c)
	assert.match(src, /<copperpour connectsTo="net\.V5V" layer="top"/)
	assert.match(src, /<copperpour connectsTo="net\.GND" layer="bottom"/)
})

test("a 1 A rail gets a wider track, no pour; a board within the default gets neither", () => {
	const c = hat()
	c.values.rails = [{ name: "5V", voltageV: 5, regulatorMaxMa: 1000, loadMa: 1000 }]
	assert.deepEqual(supplyPours(c), [])
	const w = netTraceWidths(c).get("V5V")!
	assert.ok(w > DEFAULT_TRACE_MM && w <= MAX_TRACK_MM, String(w))
	assert.match(circuitFromContract(c), /<net name="V5V" nominalTraceWidth="[\d.]+mm" \/>/)
	c.values.rails = [{ name: "5V", voltageV: 5, regulatorMaxMa: 300, loadMa: 300 }]
	assert.equal(netTraceWidths(c).size, 0)
	assert.doesNotMatch(circuitFromContract(c), /copperpour|nominalTraceWidth/)
})

test("the checks: a nets entry on a missing pin or rail, a rail wired to nothing, a second wide rail routed at width", () => {
	const c = hat()
	c.values.parts = c.values.parts!.map((p) => (p.ref === "J1" ? { ...p, nets: { ...p.nets, "41": "5V", "1": "3V3" } } : p))
	const kinds = supplyWiring(c).map((v) => v.kind)
	assert.deepEqual(kinds, ["part-net-unknown", "part-net-unknown"])
	// Before the fix: no nets, so the 5V rail reached nothing.
	const bare = hat()
	bare.values.parts = bare.values.parts!.map(({ nets: _n, ...p }) => p)
	assert.deepEqual(supplyWiring(bare).map((v) => v.kind), ["rail-unwired"])
	const two = hat()
	two.values.rails = [...two.values.rails!, { name: "12V", voltageV: 12, regulatorMaxMa: 3000, loadMa: 3000 }]
	two.values.parts = two.values.parts!.map((p) => (p.ref === "J2" ? { ...p, nets: { VIN: "5V" } } : p.ref === "J1" ? { ...p, nets: { ...p.nets, "1": "12V" } } : p))
	// The second wide rail is routed at its width (Freerouting necks it down at the pins), not refused.
	assert.ok(!supplyWiring(two).some((v) => v.kind === "rail-current-copper"))
	assert.ok(wideTracks(two).some(([n]) => n === "V12V"))
})

test("through-hole footprints keep the bottom test pads off their holes", () => {
	for (const fp of ["pinrow2_p5_id1.3_od2.6", "pinrow4", "jst2_ph", "pinrow40_rows2_female_pinnumbering(columnmajor)"]) assert.match(fp, THROUGH_HOLE_FOOTPRINT)
	for (const fp of ["0402", "sot23_5", "jst4_sh", "usbcmidmount"]) assert.doesNotMatch(fp, THROUGH_HOLE_FOOTPRINT)
})
