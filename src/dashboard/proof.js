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
// Every contract field outside `fields` is the same before and after.
function onlyChanged(before, after, fields) {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)])
	return [...keys].every((k) => fields.includes(k) || JSON.stringify(before[k]) === JSON.stringify(after[k]))
}

export function matchTrial({ brief, before, after }, results) {
	const p = proofSummary(results)
	if (!p || !before || !after || !/climate logger/i.test(brief ?? "")) return null
	const o = before.outline
	if (!o || o.widthMm !== 50 || o.heightMm !== 30) return null
	const m = whatMoved(before, after)
	const only = (n, fields) => m.count === n && onlyChanged(before, after, fields)
	const added = (list, ref) => list.length === 1 && list[0].before === null && list[0][ref] !== undefined
	const u3 = m.parts[0]
	const sw = m.connectors[0]
	const id =
		m.outline && only(1, ["outline"]) && m.outline.after.w === o.widthMm - 10 && m.outline.after.h === o.heightMm ? "narrower"
		: m.outline && only(1, ["outline"]) && m.outline.after.h === o.heightMm + 6 && m.outline.after.w === o.widthMm ? "taller"
		: !m.outline && only(1, ["connectors"]) && m.connectors[0]?.kind === "usb-c" && m.connectors[0].before?.edge !== "bottom" && m.connectors[0].after?.edge === "bottom" && m.connectors[0].after.offsetMm === o.widthMm / 2 ? "usb-edge"
		: only(2, ["pins"]) && m.pins.length === 2 && m.pins.every((x) => (x.signal === "I2C_SDA" && x.after === 4) || (x.signal === "I2C_SCL" && x.after === 5)) ? "i2c-pins"
		// The LDO (U3) swapped for the low-Iq XC6206P332MR-G, rails untouched.
		: only(1, ["parts"]) && m.parts.length === 1 && u3.ref === "U3" && u3.after === "XC6206P332MR-G" && (before.parts ?? []).find((x) => x.ref === "U3")?.role === "ldo" ? "ldo-swap"
		// SW1 added: the part, its BUTTON pin on GPIO3, and its opening in the case's top edge at the middle.
		: only(3, ["parts", "pins", "connectors"]) && added(m.parts, "ref") && m.parts[0].ref === "SW1" && m.pins.length === 1 && m.pins[0].signal === "BUTTON" && m.pins[0].before === null && m.pins[0].after === 3 && sw?.ref === "SW1" && sw.before === null && sw.after?.edge === "top" && sw.after.offsetMm === o.widthMm / 2 ? "add-button"
		: null
	return id ? (p.rows.find((r) => r.id === id) ?? null) : null
}
