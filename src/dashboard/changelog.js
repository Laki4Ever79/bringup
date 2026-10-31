// "What changed and why" between two contract revisions: per write, who, a readable diff, the writer's own reason
// and the cause (what woke it), from contract.changed's reason / before / after / cause. Older traces have none of
// those: the diff then comes from the per-revision snapshots, and the reason says it was not recorded.
// Plain ES module: the page imports it from /changelog.js, the tests in Node.
import { contractDiff } from "./model.js"
import { PROBLEM } from "./ripple.js"

const WHO = { architect: "Architect", parts: "Parts", firmware: "Firmware", reviewer: "Reviewer", engineer: "You", bench: "Bench", consistency: "Consistency" }
const who = (role) => WHO[role] ?? role

const dims = (o) => `${o.widthMm}×${o.heightMm}`

// One field's change as readable lines: the outline as W×H mm, lists by their key (contractDiff), objects per key.
export function readableDiff(field, before, after) {
	if (field === "outline" && after) return before ? (dims(before) === dims(after) ? contractDiff(field, before, after) : [`outline ${dims(before)} → ${dims(after)} mm`]) : [`outline ${dims(after)} mm (first)`]
	return contractDiff(field, before ?? undefined, after ?? undefined)
}

const plus = (n) => (n > 0 ? ` (+${n} more)` : "")

const basename = (path) => path.split("/").pop()

// The cause in words, and what it links to in the page: a ripple, a check, or a held change. `requests` maps a
// request id to its change.requested payload, so a request that came from a saved file reads as that file edit.
export function causeText(cause, requests = new Map()) {
	if (!cause) return { text: "cause not recorded (older run)", link: null }
	switch (cause.kind) {
		case "brief": return { text: "the brief", link: null }
		case "request": {
			const src = requests.get(cause.id)?.source
			if (src?.kind === "file") return { text: `file edit: ${basename(src.path)}${src.items?.length ? ` “${src.items.join("; ")}”` : ""}`, link: { ripple: cause.id } }
			return { text: `request #${cause.id.replace(/^req-/, "") || "?"} “${cause.text}”`, link: cause.id ? { ripple: cause.id } : null }
		}
		case "violation": return { text: `consistency at rev ${cause.revision}: ${cause.items[0] ? `${cause.items[0].kind}: ${cause.items[0].message}` : "violations"}${plus(cause.items.length - 1)}`, link: { checks: "consistency" } }
		case "grounding": return { text: `grounding at rev ${cause.revision}: ${cause.items[0] ? `${cause.items[0].partRef}: ${cause.items[0].detail}` : "findings"}${plus(cause.items.length - 1)}`, link: { checks: "grounding" } }
		case "review": return { text: `brief review at rev ${cause.revision}${cause.items[0] ? ` (${cause.items[0].severity}): ${cause.items[0].issue}` : ""}${plus(cause.items.length - 1)}`, link: { checks: "review" } }
		case "build-failed": return { text: `the ${cause.artifact} build failed at rev ${cause.revision}: ${cause.error}`, link: null }
		case "field-changed": return { text: `${cause.fields.join(" or ")} changed`, link: null }
		case "approval": return { text: `approved by ${cause.approvedBy.map(who).join(" + ")}: “${cause.reason}”`, link: { changes: cause.proposalId } }
		case "measurement": return { text: `bench measurement at rev ${cause.revision}: ${cause.detail}`, link: null }
		default: return { text: String(cause.kind), link: null }
	}
}

// Every write after `from` up to and including `to`, oldest first.
export function changeLog(events, from, to, snapshots) {
	const requests = new Map(events.filter((e) => e.type === "change.requested").map((e) => [e.payload.id, e.payload]))
	return events
		.filter((e) => e.type === "contract.changed" && e.payload.revision > from && e.payload.revision <= to)
		.map((e) => {
			const p = e.payload
			const recorded = "after" in p
			const before = recorded ? p.before : snapshots.get(p.revision - 1)?.values?.[p.field]
			const after = recorded ? p.after : snapshots.get(p.revision)?.values?.[p.field]
			const diff = recorded || (snapshots.has(p.revision) && snapshots.has(p.revision - 1)) ? readableDiff(p.field, before, after) : []
			return { revision: p.revision, field: p.field, version: p.version, by: p.by, who: who(p.by), diff, reason: p.reason ?? null, cause: causeText(p.cause, requests) }
		})
		.sort((a, b) => a.revision - b.revision)
}

// The latest two revisions: the newest write and the one before it.
export function defaultRange(events) {
	const revs = events.filter((e) => e.type === "contract.changed").map((e) => e.payload.revision)
	if (!revs.length) return null
	const to = Math.max(...revs)
	return { from: to - 1, to }
}

// Saves of a generated file that the design won't keep (file.drift): an edit with no contract field (the next
// rebuild overwrites it), or a file saved against an older revision (not applied). Oldest first.
export function fileDrift(events) {
	return events
		.filter((e) => e.type === "file.drift")
		.map((e) => {
			const p = e.payload
			const name = basename(p.path)
			return { seq: e.seq, at: e.at, name, path: p.path, reason: p.reason, items: p.items ?? [], line: `${name}: ${p.message}${p.reason === "stale" ? "; not applied" : ""}` }
		})
}

// ── The timeline beside 03 Agents: how a change travelled, step by step, with times from the request ──────────────
const ACTOR = { architect: "architect", parts: "parts", firmware: "firmware agent", reviewer: "reviewer", engineer: "you", bench: "bench" }
const BUILT = { board: "board", enclosure: "case", firmware: "firmware" }
const since = (ms) => (ms < 10_000 ? `+${(Math.max(0, ms) / 1000).toFixed(1)} s` : ms < 60_000 ? `+${Math.round(ms / 1000)} s` : `+${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}`)

function step(e) {
	const p = e.payload ?? {}
	switch (e.type) {
		case "change.requested": return p.source?.kind === "file" ? `you edited ${basename(p.source.path)}: ${(p.source.items ?? []).join("; ")}` : `you asked “${p.text}”`
		case "contract.changed": {
			const who = ACTOR[p.by] ?? p.by
			const diff = "after" in p ? readableDiff(p.field, p.before, p.after)[0]?.replace(/^[~+−-] /, "") : null
			return diff ? `${who}: ${diff}` : `${who} ${p.version === 1 ? "set" : "changed"} ${p.field}`
		}
		case "artifact.ready": return `${BUILT[p.kind] ?? p.kind} rebuilt · rev ${p.revision}`
		case "artifact.failed": return `${BUILT[p.kind] ?? p.kind} build failed · rev ${p.revision}`
		case "firmware.booted": return p.booted ? `firmware boots in QEMU · rev ${p.revision}` : `firmware did not boot · rev ${p.revision}`
		case "bench.flashed": return p.ok ? `flashed the real board · rev ${p.revision}` : `flashing the board failed · rev ${p.revision}`
		case "bench.blink": return `measured on the board: ${typeof p.tiltBlinkMs === "number" ? `tilted ${p.tiltBlinkMs} ms` : `blink ${p.blinkMs} ms`} ${p.pass ? "✓" : "✗"}`
		default: return null
	}
}

// Steps from fromMs up to toMs (exclusive). `start`: a first line when the window has no request (the first design).
// consistentAtMs: when the change was consistent again (the ripple's), the closing step. The newest `max` steps stay.
export function rippleTimeline(events, { fromMs, toMs = Infinity, consistentAtMs = null, start = null, max = 7 } = {}) {
	const steps = []
	if (start) steps.push({ key: "start", at: fromMs, text: start })
	let mismatches = 0
	for (const e of events) {
		const at = Date.parse(e.at)
		if (at < fromMs || at >= toMs) continue
		if (e.type === "consistency.checked") {
			const v = e.payload.violations ?? []
			if (v.length && v.length !== mismatches) steps.push({ key: `c${e.seq}`, at, text: `${v.length} mismatch${v.length === 1 ? "" : "es"}: ${PROBLEM[v[0].kind] ?? v[0].kind}` })
			mismatches = v.length
			continue
		}
		const text = step(e)
		if (text) steps.push({ key: `e${e.seq}`, at, text })
	}
	if (consistentAtMs !== null && consistentAtMs < toMs) steps.push({ key: "done", at: consistentAtMs, text: "consistent: board, case and firmware agree" })
	steps.sort((a, b) => a.at - b.at)
	const shown = steps.length > max ? [{ key: "earlier", at: fromMs, text: `… ${steps.length - (max - 1)} earlier steps` }, ...steps.slice(-(max - 1))] : steps
	return shown.map((s) => ({ key: s.key, t: s.key === "earlier" ? "" : since(s.at - fromMs), text: s.text }))
}
