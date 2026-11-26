// The CNC's catalog entries (catalog/mechanics.json steppers, rails, spindles, the T8 screws; docs/cnc.md gaps 4–8):
// every number has a source, or is listed as an estimate that names its basis.
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadMechCatalog } from "../src/mechanics/catalog.ts"

const cat = loadMechCatalog(new URL("..", import.meta.url).pathname)
const sourced = (what: string, e: { source: Record<string, { url?: string; where?: string }>; estimates?: string[] }, keys: string[]) => {
	for (const k of keys) assert.ok(e.source[k]?.url && e.source[k]?.where, `${what}.${k} has no source`)
	for (const k of e.estimates ?? []) assert.match(e.source[k]?.where ?? "", /estimate/, `${what}: the estimate ${k} says so in its source`)
}

test("CNC catalog: steppers, rails, spindles and the T8 screws carry a source per number", () => {
	const [m] = cat.steppers ?? []
	assert.equal(m.mpn, "17HS15-1504S1")
	sourced(m.mpn, m, ["frameMm", "bodyMm", "shaftMm", "ratedA", "holdingNm", "stepDeg", "phaseOhm", "phaseMh", "massG", "pulloutNm", "pulloutAt"])
	assert.ok(m.pulloutNm.every((p, i) => i === 0 || (p.rpm > m.pulloutNm[i - 1].rpm && p.nm <= m.pulloutNm[i - 1].nm)), "the pull-out curve falls with speed")
	assert.ok(m.pulloutNm[0].nm <= m.holdingNm)
	const [r] = cat.rails ?? []
	sourced(r.mpn, r, ["railWidthMm", "railHeightMm", "heightMm", "blockWidthMm", "blockLengthMm", "dynamicN", "staticN", "blockMassG", "railGPerM"])
	const [s] = cat.spindles ?? []
	sourced(s.mpn, s, ["volts", "noLoadRpm", "collet", "bodyDiaMm", "bodyLengthMm", "watts", "amps"])
	assert.deepEqual(s.estimates, ["watts", "amps"], "no maker states the 775 spindle's power: an estimate, said so")
	const screws = (cat.driveTrain ?? []).filter((d) => d.kind === "leadscrew")
	assert.deepEqual(screws.map((d) => d.lengthMm), [200, 300, 400])
	for (const d of screws) sourced(d.mpn, d as never, ["diameterMm", "leadMm", "lengthMm"])
})
