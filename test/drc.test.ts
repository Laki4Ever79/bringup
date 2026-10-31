import { test } from "node:test"
import assert from "node:assert/strict"
import { applyFabRules, summarizeDrc, FAB_RULES } from "../src/tools/drc.ts"

test("fab rules set the JLCPCB 2-layer minimums and the default net class", () => {
	const pro = applyFabRules({ meta: { version: 3 } }) as any
	assert.equal(pro.board.design_settings.rules.min_track_width, FAB_RULES.minTrackMm)
	assert.equal(pro.board.design_settings.rules.min_via_diameter, FAB_RULES.minViaDiameterMm)
	const cls = pro.net_settings.classes.find((c: any) => c.name === "Default")
	assert.equal(cls.clearance, FAB_RULES.minClearanceMm)
	assert.equal(pro.meta.version, 3, "keeps the rest of the project")
})

test("a DRC report is summarised by severity and type", () => {
	const s = summarizeDrc({
		violations: [
			{ type: "clearance", severity: "error", description: "a" },
			{ type: "clearance", severity: "error", description: "b" },
			{ type: "silk_over_copper", severity: "warning", description: "c" },
		],
		unconnected_items: [{}],
	})
	assert.deepEqual(s, { rules: "JLCPCB 2-layer", errors: 2, warnings: 1, unconnected: 1, byType: { clearance: 2, silk_over_copper: 1 }, firstError: "a", ownFootprint: {} })
})

test("errors inside one part's own footprint are counted per part (a vendor land pattern vs the fab's generic rule)", () => {
	const s = summarizeDrc({
		violations: [
			// The USB-C receptacle's GND pad 0.17 mm from its own locating hole: both items belong to J1.
			{ type: "hole_clearance", severity: "error", description: "Hole clearance violation", items: [{ description: "Pad 5 [GND] of J1 on F.Cu" }, { description: "NPTH pad of J1" }] },
			{ type: "hole_clearance", severity: "error", description: "Hole clearance violation", items: [{ description: "Pad 16 [GND] of J1 on F.Cu" }, { description: "NPTH pad of J1" }] },
			// Between two parts: a real layout error, never counted as in-footprint.
			{ type: "clearance", severity: "error", description: "Clearance violation", items: [{ description: "Pad 1 [VBUS] of J1 on F.Cu" }, { description: "Track [VBUS] on F.Cu" }] },
			{ type: "clearance", severity: "error", description: "Clearance violation", items: [{ description: "Pad 2 of U1 on F.Cu" }, { description: "Pad 1 of C3 on F.Cu" }] },
			{ type: "silk_over_copper", severity: "warning", description: "c", items: [{ description: "Reference field of U1" }, { description: "Pad 3 of U1" }] },
		],
	})
	assert.equal(s.errors, 4)
	assert.deepEqual(s.ownFootprint, { J1: 2 }, "errors only, and only when every item is the same part's")
})

test("the report shows the DRC summary", async () => {
	const { drcReportLinesForTest } = await import("../src/report.ts")
	assert.deepEqual(drcReportLinesForTest({ rules: "JLCPCB 2-layer", errors: 2, warnings: 1, unconnected: 0, byType: { clearance: 2, silk_over_copper: 1 }, firstError: "a" }), ["- Design rules (KiCad, JLCPCB 2-layer): 2 errors, 1 warnings, 0 unconnected (clearance 2, silk_over_copper 1)"])
	assert.deepEqual(drcReportLinesForTest(null), ["- Design rules (KiCad): not checked (KiCad could not run)"])
	assert.deepEqual(drcReportLinesForTest({ rules: "JLCPCB 2-layer", errors: 2, warnings: 0, unconnected: 0, byType: { hole_clearance: 2 }, firstError: "a", ownFootprint: { J1: 2 } }), ["- Design rules (KiCad, JLCPCB 2-layer): 2 errors, 0 warnings, 0 unconnected (hole_clearance 2); 2 of them inside J1's own footprint (its vendor land pattern against the fab's generic rule, not the layout)"])
})
