// The silkscreen as a fab reads it (src/tools/silk.ts, 18 Nov 2026). Real run 20b's board carried 97 KiCad warnings;
// on its saved rev-38 board: 97 -> 1 (errors 0): text below 0.8 mm raised, the library check ignored (footprints are
// embedded), colliding reference designators hidden. Left: two pin labels on JS1's header ("GND", "START") at 0.8 mm.
import { test } from "node:test"
import assert from "node:assert/strict"
import { collidingReferences, hideReferences, raiseSilkText } from "../src/tools/silk.ts"
import { applyFabRules } from "../src/tools/drc.ts"

const ref = (r: string, layer: string, size: number, thick = 0.1) => `\t\t(property "Reference" "${r}"\n\t\t\t(at 0 -2.54 0)\n\t\t\t(layer "${layer}")\n\t\t\t(uuid "u-${r}")\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size ${size} ${size})\n\t\t\t\t\t(thickness ${thick})\n\t\t\t\t)\n\t\t\t)\n\t\t)\n`

test("silkscreen text below 0.8 mm is raised; copper and fab text are left alone", () => {
	const pcb = `(footprint "x"\n${ref("R1", "F.SilkS", 0.7)}${ref("R2", "F.Fab", 0.5)}${ref("R3", "B.SilkS", 1)})`
	const out = raiseSilkText(pcb)
	assert.match(out, /"R1"[\s\S]*?\(size 0\.8 0\.8\)\s*\(thickness 0\.15\)/)
	assert.match(out, /"R2"[\s\S]*?\(size 0\.5 0\.5\)/)
	assert.match(out, /"R3"[\s\S]*?\(size 1 1\)\s*\(thickness 0\.15\)/)
})

test("a colliding reference designator is hidden; the DRC's items name them", () => {
	const refs = collidingReferences([{ type: "silk_overlap", items: [{ description: "Reference field of R5" }, { description: "Segment of U6 on F.Silkscreen" }] }, { type: "silk_edge_clearance", items: [{ description: "Segment on Edge.Cuts" }, { description: "Reference field of JT1" }] }, { type: "clearance", items: [{ description: "Reference field of X9" }] }])
	assert.deepEqual(refs, ["R5", "JT1"])
	const out = hideReferences(`(footprint "x"\n${ref("R5", "F.SilkS", 0.8)}${ref("R6", "F.SilkS", 0.8)})`, ["R5"])
	assert.match(out, /"R5"[\s\S]*?\(hide yes\)\s*\(effects/)
	assert.doesNotMatch(out.slice(out.indexOf('"R6"')), /hide yes/)
})

test("the fab rules don't check footprints against a library: they are embedded in the board", () => {
	const p = applyFabRules({ board: { design_settings: {} } })
	assert.equal(p.board.design_settings.rule_severities.lib_footprint_issues, "ignore")
	assert.equal(p.board.design_settings.rule_severities.hole_to_hole, "error")
})
