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
	assert.deepEqual(s, { rules: "JLCPCB 2-layer", errors: 2, warnings: 1, unconnected: 1, byType: { clearance: 2, silk_over_copper: 1 }, firstError: "a" })
})

test("the report shows the DRC summary", async () => {
	const { drcReportLinesForTest } = await import("../src/report.ts")
	assert.deepEqual(drcReportLinesForTest({ rules: "JLCPCB 2-layer", errors: 2, warnings: 1, unconnected: 0, byType: { clearance: 2, silk_over_copper: 1 }, firstError: "a" }), ["- Design rules (KiCad, JLCPCB 2-layer): 2 errors, 1 warnings, 0 unconnected (clearance 2, silk_over_copper 1)"])
	assert.deepEqual(drcReportLinesForTest(null), ["- Design rules (KiCad): not checked (KiCad could not run)"])
})
