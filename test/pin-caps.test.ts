// A capacitor wired to a chip pin sits beside that pin, whatever the board's shape (bringup-lead, 14 Nov 2026: the
// scripted rover with its link connector JL1, compacted to 33×42 mm, got the DRV8833's VINT capacitor 7.98 mm from the
// pin; tscircuit refused to route, "the 5mm maximum length for U5.VINT to C6.pin1 cannot be satisfied", every build
// after). The driver's VM capacitors end on a net, so they aimed at the driver's centre and, placed first, took the
// spots beside VINT and VCP.
import { test } from "node:test"
import assert from "node:assert/strict"
import { footprintFor, icPinOffset, layoutBoard, supportParts } from "../src/codegen/circuit.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import { LINK_CONNECTOR } from "../src/contract/links.ts"
import type { ContractSnapshot, Part } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const rover = (w: number, h: number, jl1: "top" | "bottom" | "right"): ContractSnapshot => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(ROVER_BOARD) } as ContractSnapshot["values"]
	s.values.outline = { widthMm: w, heightMm: h, thicknessMm: 1.6 }
	const side = (e: string) => (e === "left" || e === "right" ? h : w)
	s.values.connectors = [
		...s.values.connectors!.map((c) => ({ ...c, offsetMm: Math.min((c.offsetMm * side(c.edge)) / (c.edge === "left" || c.edge === "right" ? 40 : 60), side(c.edge) - c.widthMm / 2 - 1) })),
		{ ref: "JL1", kind: "header", edge: jl1, offsetMm: side(jl1) / 2, widthMm: 5.8, heightMm: 3 },
	]
	s.values.parts = [...s.values.parts!, { ref: "JL1", role: "connector", mpn: LINK_CONNECTOR.mpn, lcsc: LINK_CONNECTOR.lcsc, footprint: LINK_CONNECTOR.footprint, pins: LINK_CONNECTOR.pins } as Part]
	return s
}

for (const [w, h, edge] of [[60, 40, "top"], [33, 40, "top"], [33, 42, "top"], [33, 42, "bottom"]] as const) {
	test(`the DRV8833's VINT and VCP capacitors sit beside their pins on a ${w}×${h} mm rover, JL1 on the ${edge} edge`, () => {
		const s = rover(w, h, edge)
		const { parts } = layoutBoard(s)
		const u5 = parts.find((p) => p.ref === "U5")!
		const driver = s.values.parts!.find((p) => p.ref === "U5")!
		assert.equal(u5.rotation, 0)
		for (const sp of supportParts(s).filter((x) => x.near === "U5" && x.spec.kind === "capacitor" && "ref" in x.a)) {
			const end = sp.a as { ref: string; pin: string }
			const off = icPinOffset(footprintFor(driver), driver.pins.indexOf(end.pin) + 1)!
			const cap = parts.find((p) => p.ref === sp.ref)!
			const d = Math.hypot(cap.x - (u5.x + off.x), cap.y - (u5.y + off.y))
			assert.ok(d <= 2.5, `${sp.ref} on U5.${end.pin}: ${d.toFixed(1)} mm from the pad`)
		}
	})
}

// When a trace does run past its bound, the build error says so: the line was dropped before, and the architect saw
// only "0 passed 1 failed" (the rover, 14 Nov 2026).
import { buildErrors } from "../src/tools/board.ts"
test("a trace past its length bound is kept in the build error the agents read", () => {
	const out = ["Warning: C6 is underspecified", "PCB trace is 7.98 mm long, exceeding the 5mm maximum for U5.VINT to C6.pin1", "Circuits 0 passed 1 failed"].join("\n")
	assert.match(buildErrors(out), /7\.98 mm long, exceeding the 5mm maximum/)
	assert.doesNotMatch(buildErrors(out), /underspecified/)
})
