import { test } from "node:test"
import assert from "node:assert/strict"
import { narrowNets, netCopper } from "../src/tools/track-widths.ts"
import { routedWidths, wideTracks, supplyWidths, netTraceWidths, MAX_TRACK_MM } from "../src/codegen/circuit.ts"
import { readFileSync } from "node:fs"

const seg = (x0: number, x1: number, w: number, net: number) => `  (segment (start ${x0} 0) (end ${x1} 0) (width ${w}) (layer "F.Cu") (net ${net}) (uuid "u"))`
const pcb = (segs: string[]) => [`(kicad_pcb`, `  (net 0 "")`, `  (net 1 "VSERVO1")`, `  (net 2 "SDA")`, ...segs, `)`].join("\n")

test("a wide net's copper counts the track at width; a neck-down into a pin is allowed, a thin run is not", () => {
	const ok = netCopper(pcb([seg(0, 18, 2.4, 1), seg(18, 20, 0.6, 1), seg(0, 50, 0.2, 2)]), new Map([["VSERVO1", 2.4]]))
	assert.deepEqual(ok.map((r) => [r.net, r.totalMm, r.atWidthMm]), [["VSERVO1", 20, 18]])
	assert.equal(narrowNets(ok).length, 0)
	const thin = netCopper(pcb([seg(0, 20, 0.2, 1)]), new Map([["VSERVO1", 2.4]]))
	assert.equal(narrowNets(thin)[0].net, "VSERVO1")
})

test("an arm's generated rails get IPC-2221 widths; the unpoured wide ones go to Freerouting at full width, tscircuit capped", () => {
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))
	const w = supplyWidths(s)
	for (const n of ["VSERVO1", "VSERVO2", "VIN_BRICK"]) assert.ok((w.get(n) ?? 0) > MAX_TRACK_MM, `${n}: ${w.get(n)}`)
	const wide = new Map(wideTracks(s))
	assert.ok(wide.size >= 1)
	for (const [n, mm] of wide) {
		assert.equal(routedWidths(s).get(n), mm)
		assert.equal(netTraceWidths(s).get(n), MAX_TRACK_MM)
	}
})

test("an arm's rails enter the contract with their peak, replacing older entries of the same name", async () => {
	const { armRailEntries, withArmRails } = await import("../src/contract/arm-rails.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))
	const gen = armRailEntries(s)
	assert.deepEqual(gen.map((r) => r.name), ["VSERVO1", "VSERVO2", "VSERVO3", "VIN_BRICK"])
	// The brick's peak: the servo rails' power through the converters plus the logic, at 19.5 V; under its 4.62 A rating.
	const brick = gen.find((r) => r.name === "VIN_BRICK")!
	assert.equal(brick.voltageV, 19.5)
	assert.ok(brick.loadMa > 3000 && brick.loadMa <= brick.regulatorMaxMa, String(brick.loadMa))
	const merged = withArmRails(s.values.rails, s)
	assert.equal(merged.filter((r) => r.name === "VIN_BRICK").length, 1)
	assert.ok(merged.some((r) => r.name === "3V3"))
	assert.deepEqual(withArmRails(s.values.rails, { ...s, values: { ...s.values, arm: undefined } }), s.values.rails)
})

test("a board Freerouting routes pours ground only; every rail is a track at its width, none capped", async () => {
	const { supplyPours, circuitFromContract } = await import("../src/codegen/circuit.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))
	assert.deepEqual(supplyPours(s, true), [{ net: "GND", layer: "bottom" }])
	const fr = routedWidths(s, true)
	for (const n of ["VSERVO1", "VSERVO2", "VIN_BRICK"]) assert.equal(fr.get(n), supplyWidths(s).get(n))
	const src = circuitFromContract(s, { routingDisabled: true })
	assert.doesNotMatch(src, /<copperpour connectsTo="net\.VSERVO1"/)
	assert.match(src, /<copperpour connectsTo="net\.GND" layer="bottom"/)
})

test("the space model reserves each wide rail's lane and grows the minimum board for it, saying so", async () => {
	const { minimumBoard, railCorridors } = await import("../src/contract/space.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))
	const c = railCorridors(s)
	assert.deepEqual(c.map((x) => x.net), ["VSERVO1", "VSERVO2", "VSERVO3", "VIN_BRICK"])
	// A lane: the spanning tree over its parts times the rail's IPC-2221 width plus 0.15 mm clearance a side.
	for (const x of c) assert.ok(Math.abs(x.areaMm2 - x.lengthMm * (x.widthMm + 0.3)) < 2, `${x.net}: ${x.areaMm2}`)
	const m = minimumBoard(s)!
	assert.equal(m.limitedBy, "rail-copper")
	// Placement alone packs it in about 3550 mm² (three rail chips with their parts, 26 Nov 2026; 2914 with two
	// SY8368As); with the lanes the area is that plus theirs.
	const lanes = c.reduce((a, x) => a + x.areaMm2, 0)
	assert.ok(m.areaMm2 - lanes > 3300 && m.areaMm2 - lanes < 3800, `${m.areaMm2} - ${lanes}`)
	assert.ok(m.widthMm * m.heightMm >= m.areaMm2)
	// A board without wide rails is unchanged (the HAT's 5 V is poured).
	assert.deepEqual(railCorridors({ ...s, values: { ...s.values, arm: undefined, rails: [] } }), [])
})
