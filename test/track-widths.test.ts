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
	// The brick's peak: the servo rails' power through the converters plus the logic, at 20 V (the GST120A20); under its 6 A rating.
	const brick = gen.find((r) => r.name === "VIN_BRICK")!
	assert.equal(brick.voltageV, 20)
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
	// No rail pour on an outer layer (the arm is a 4-layer board: its rails ride the inner power layer, below).
	assert.doesNotMatch(src, /<copperpour connectsTo="net\.VSERVO1" layer="(top|bottom)"/)
	assert.match(src, /<copperpour connectsTo="net\.GND" layer="bottom"/)
})

test("4 layers when the wide rails' lanes are over 15 % of the board: ground on In1, each rail's own regions on In2, the reason named", async () => {
	const { boardLayers, powerPlaneRegions, circuitFromContract } = await import("../src/codegen/circuit.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))
	const l = boardLayers(s)
	assert.equal(l.layers, 4)
	assert.equal(l.reason?.by, "estimate")
	assert.match(l.reason?.detail ?? "", /lanes .* are \d+ % of the 80x60 mm board, over 15 %/)
	const src = circuitFromContract(s, { routingDisabled: true })
	assert.match(src, /<board layers=\{4\}/)
	assert.match(src, /<copperpour connectsTo="net\.GND" layer="inner1"/)
	const regions = powerPlaneRegions(s)
	assert.deepEqual([...new Set(regions.map((r) => r.net))].sort(), ["VIN_BRICK", "VSERVO1", "VSERVO2", "VSERVO3"])
	assert.equal((src.match(/layer="inner2"/g) ?? []).length, regions.length)
	// Each region joining two or more pads is wide enough for its rail (IPC-2221), so no plane neck finding.
	for (const r of regions.filter((x) => Number.isFinite(x.neckMm))) assert.ok(r.neckMm >= supplyWidths(s).get(r.net)!, `${r.net} ${r.neckMm}`)
	// A board without wide rails stays at 2 layers.
	assert.equal(boardLayers({ ...s, values: { ...s.values, arm: undefined, rails: [] } }).layers, 2)
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
	// (About 3810 with the antenna's keep-out band, 27 Nov 2026: the module's band costs placement room.)
	assert.ok(m.areaMm2 - lanes > 3300 && m.areaMm2 - lanes < 4000, `${m.areaMm2} - ${lanes}`)
	assert.ok(m.widthMm * m.heightMm >= m.areaMm2)
	// A board without wide rails is unchanged (the HAT's 5 V is poured).
	assert.deepEqual(railCorridors({ ...s, values: { ...s.values, arm: undefined, rails: [] } }), [])
})

test("the order estimate leaves a 4-layer board's bare boards to JLC's quote (no published price), a 2-layer one at $2", async () => {
	const { jlcEstimate } = await import("../src/package/build.ts")
	assert.equal(jlcEstimate({ widthMm: 80, heightMm: 60 }, 100, [], 10).pcbUsd, 2)
	const four = jlcEstimate({ widthMm: 80, heightMm: 60, layers: 4 }, 100, [], 10)
	assert.equal(four.pcbUsd, null)
	assert.equal(four.totalUsd, null)
})

test("a Freerouting board always pours ground, whatever its widths (GND at 0.35 mm got no pour); tscircuit's keep their rule", async () => {
	const { supplyPours, routedWidths: rw, supplyWidths: sw, DEFAULT_TRACE_MM, MAX_TRACK_MM } = await import("../src/codegen/circuit.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))
	// Only a modest rail: about 0.35 mm for its peak, over the default, under MAX_TRACK_MM.
	const small = { ...s, values: { ...s.values, arm: undefined, rails: [{ name: "V12", voltageV: 12, regulatorMaxMa: 1000, loadMa: 900 }] } }
	const g = sw(small).get("GND")!
	assert.ok(g > DEFAULT_TRACE_MM && g <= MAX_TRACK_MM, String(g))
	assert.deepEqual(supplyPours(small, true), [{ net: "GND", layer: "bottom" }])
	assert.equal(rw(small, true).has("GND"), false)
	// tscircuit's boards keep their rule (a pour only past MAX_TRACK_MM).
	assert.deepEqual(supplyPours(small, false), [])
	// No wide net at all: a Freerouting board still pours ground.
	const none = { ...small, values: { ...small.values, rails: [] } }
	assert.deepEqual(supplyPours(none, true), [{ net: "GND", layer: "bottom" }])
})

test("a part tscircuit can't address is no size failure: no 4-layer retry, no bigger board (lead-3's CNC mock 12)", async () => {
	const { sizeFailure } = await import("../src/tools/board.ts")
	assert.equal(sizeFailure("tscircuit build failed (exit 1):\nCould not find port for selector '.J3 > .M+' ... It has no ports\nPort pin1 on R13 is missing a trace"), false)
	assert.equal(sizeFailure("tscircuit build failed (exit 1):\nPort pin1 on R13 is missing a trace"), true)
})
