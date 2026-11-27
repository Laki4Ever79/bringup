// "Change one thing, everything follows": a change request either reaches the design, with the values it asked for, or
// comes back as not done with the reason. Never a run that settles having silently changed nothing (27 Nov 2026: a mock
// rover's "make it 2 cm wider" was refused by the contract, the scripted agent answered "chassis updated", and the
// report said only "nothing changed"). Scripted requests through mock runs, read the way get_pictures compare reads them.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runDesign } from "../src/run.ts"
import { compareDesigns, designAt, lastChange, leafChanges } from "../src/package/compare.ts"
import { changeRipples, readTrace } from "../src/runner/ripple.ts"
import { runSummary } from "../src/runner/summary.ts"
import { tempDir } from "./helpers.ts"

async function change(brief: string, request: string) {
	const out = tempDir()
	await runDesign({ brief: readFileSync(brief, "utf8"), mock: true, noHardware: true, review: false, outDir: out, changes: [request], changeTimeoutMs: 40_000 })
	const span = lastChange(out)
	assert.ok(span, `no change request in ${out}`)
	const ripple = changeRipples(readTrace(out)).at(-1)!
	const a = designAt(out, span.before), b = designAt(out, span.after)
	// The guarantee itself: something changed, or a refusal says why.
	assert.ok(ripple.fieldsChanged.length > 0 || ripple.refused.length > 0, `"${request}" changed nothing and nothing says why`)
	return { out, ripple, a, b, summary: compareDesigns(a, b).summary }
}

test("a board size request reaches the outline", { timeout: 120_000 }, async () => {
	const r = await change("briefs/logger.md", "make the board 60 mm wide")
	assert.deepEqual(r.ripple.fieldsChanged, ["outline"])
	assert.equal((r.b.contract?.outline as { widthMm: number }).widthMm, 60)
	assert.match(r.summary, /^board \d+×\d+ → 60×\d+ mm/)
})

test("a part swap keeps the ref and changes the part", { timeout: 120_000 }, async () => {
	const r = await change("briefs/logger.md", "swap U2 SHT40-AD1B-R2 for the SHTC3-TR-2.5KS (C194656) from the catalog")
	assert.ok(r.ripple.fieldsChanged.includes("parts"))
	assert.match(r.summary, /swapped U2 SHT40-AD1B-R2 → SHTC3-TR-2\.5KS/)
})

test("a narrower rover: the plate and the track both 20 mm less", { timeout: 120_000 }, async () => {
	const r = await change("briefs/rover.md", "make it 2 cm narrower")
	assert.ok(r.ripple.fieldsChanged.includes("mechanics"))
	const leaves = new Map(leafChanges(r.a.contract?.mechanics, r.b.contract?.mechanics).map(([path, x, y]) => [path, [x, y]]))
	assert.deepEqual(leaves.get("drive.trackMm"), [110, 90])
	assert.deepEqual(leaves.get("chassis.plateMm[1]"), [96, 76])
	assert.match(r.summary, /drive track: 110 → 90 mm/)
})

test("a wider rover past the brief's size: not done, and the report and run_summary say why", { timeout: 120_000 }, async () => {
	const r = await change("briefs/rover.md", "make it 2 cm wider")
	assert.deepEqual(r.ripple.fieldsChanged, [])
	assert.match(r.ripple.refused.map((x) => x.reason).join(" "), /over the 150 × 120 mm the brief allows/)
	assert.match(readFileSync(join(r.out, "report.md"), "utf8"), /\| make it 2 cm wider \|.*\*\*not done\*\*, refused: mechanics/)
	assert.match(runSummary(r.out, "r").text, /change "make it 2 cm wider": NOT DONE, refused: mechanics: the chassis can't change size that way/)
})
