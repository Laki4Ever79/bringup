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
			assert.ok(d <= 3.5, `${sp.ref} on U5.${end.pin}: ${d.toFixed(1)} mm from the pad`)
			// And clear of the driver: 0.5 mm overlapped its courtyard, and tscircuit refused the board (14 Nov 2026).
			const gap = Math.max(Math.abs(cap.x - u5.x) - (cap.w + u5.w) / 2, Math.abs(cap.y - u5.y) - (cap.h + u5.h) / 2)
			assert.ok(gap >= 1.5 - 1e-9, `${sp.ref} is ${gap.toFixed(2)} mm from U5's box`)
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

// The charge pump's capacitor goes from VCP to the driver's own VM pin, as TI's schematic draws it (DRV8833 §7.3), not
// to the VM net: tscircuit joined its far end to the net 9.8 mm away, past the 5 mm bound (the rover at 33×42 mm,
// 14 Nov 2026).
test("the DRV8833's VCP capacitor ends on the driver's VM pin, not on the VM net", () => {
	const s = rover(33, 42, "top")
	const vcp = supportParts(s).find((sp) => "ref" in sp.a && sp.a.pin === "VCP")!
	assert.deepEqual(vcp.b, { ref: "U5", pin: "VM" })
})

// A capacitor on a part's pin ends its ground side on that part's own GND pin, as TI draws the DRV8833's VINT capacitor:
// to the GND net, tscircuit reached ground 25 mm away on the 50×29 mm rover (no ground pour), past the 5 mm bound that
// counts the ground return too, and every wider board failed the same way (bringup-lead's edit test, 15 Nov 2026).
test("the driver's VINT capacitor ends on the driver's own GND pin", () => {
	const s: ContractSnapshot = { revision: 1, versions: {} as never, values: structuredClone(ROVER_BOARD) as ContractSnapshot["values"] }
	const vint = supportParts(s).find((sp) => /VINT/.test(sp.job))!
	assert.deepEqual([vint.a, vint.b], [{ ref: "U5", pin: "VINT" }, { ref: "U5", pin: "GND" }])
})
