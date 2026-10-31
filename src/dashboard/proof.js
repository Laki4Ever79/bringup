// The evidence for "change one thing and the whole design follows": af's A/B experiment (docs/experiment.md,
// docs/experiment-results.json). Arm A is the shared contract; arm B is every team working from its own copy.
// Plain ES module with no dependencies but ripple.js: the page imports it from /proof.js, the tests in Node.
import { whatMoved } from "./ripple.js"

// Most telling first: a misplaced cutout or a wrong outline is visible in plastic, a wrong part on the board in
// copper; a missing net is a dead board.
const VIVID = ["cutout-misaligned", "outline-mismatch", "part-mismatch", "net-missing", "cutout-missing", "standoff-mismatch"]

export function vividMismatch(shipped) {
	if (!shipped?.length) return null
	const rank = (k) => (VIVID.includes(k) ? VIVID.indexOf(k) : VIVID.length)
	return [...shipped].sort((a, b) => rank(a.kind) - rank(b.kind))[0].message
}

export function proofSummary(results) {
	const trials = results?.results ?? []
	if (!trials.length) return null
	const rows = trials.map((t) => ({ id: t.change, label: t.label, seconds: Math.round(t.armA.ms / 1000), woken: t.armA.woken.length, workers: t.armA.workers, shipped: t.armB.shipped.length, vivid: vividMismatch(t.armB.shipped) }))
	const secs = rows.map((r) => r.seconds)
	const rangeS = [Math.min(...secs), Math.max(...secs)]
	const violations = trials.reduce((n, t) => n + t.armA.violations.length, 0)
	const shipped = rows.reduce((n, r) => n + r.shipped, 0)
	return {
		changes: rows.length,
		violations,
		rangeS,
		shipped,
		rows,
		headline: `${rows.length} real changes · with the shared contract: ${violations} violation${violations === 1 ? "" : "s"}, consistent again in ${rangeS[0]}–${rangeS[1]} s · each team on its own copy: ${shipped} mismatches would ship`,
	}
}

// The trial that ran exactly this change from exactly this starting design (the settled logger, 50 × 30 mm), or
// null. Never a near miss: a different amount, another field changed too, or another brief is no match.
export function matchTrial({ brief, before, after }, results) {
	const p = proofSummary(results)
	if (!p || !before || !after || !/climate logger/i.test(brief ?? "")) return null
	const o = before.outline
	if (!o || o.widthMm !== 50 || o.heightMm !== 30) return null
	const m = whatMoved(before, after)
	const only = (n) => m.count === n
	const id =
		m.outline && only(1) && m.outline.after.w === o.widthMm - 10 && m.outline.after.h === o.heightMm ? "narrower"
		: m.outline && only(1) && m.outline.after.h === o.heightMm + 6 && m.outline.after.w === o.widthMm ? "taller"
		: !m.outline && only(1) && m.connectors[0]?.kind === "usb-c" && m.connectors[0].before?.edge !== "bottom" && m.connectors[0].after?.edge === "bottom" && m.connectors[0].after.offsetMm === o.widthMm / 2 ? "usb-edge"
		: only(2) && m.pins.length === 2 && m.pins.every((x) => (x.signal === "I2C_SDA" && x.after === 4) || (x.signal === "I2C_SCL" && x.after === 5)) ? "i2c-pins"
		: null
	return id ? (p.rows.find((r) => r.id === id) ?? null) : null
}
