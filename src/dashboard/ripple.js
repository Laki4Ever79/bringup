// The change moment as the page shows it: one ripple per engineer request, from the request to the next one.
// Which contract fields it touched, which agents woke and which stayed idle, the checks going red then green, and
// when the design was consistent again. The runner writes the same thing to ripples.json (src/runner/ripple.ts);
// that file wins where it has an answer, and this live view from the trace fills in while a ripple is in flight.
// Plain ES module with no dependencies but lanes.js: the page imports it from /ripple.js, the tests in Node.
import { LANES, applyLaneEvent, createLanes } from "./lanes.js"

const KEYS = LANES.map((l) => l.key)
const AGENTS = new Set(["architect", "parts", "firmware", "reviewer"])
// Same as BUILD_INPUTS in src/agents/builders.ts.
const BUILD_INPUTS = { "build:board": ["parts", "pins", "outline", "connectors"], "build:enclosure": ["outline", "connectors"], "build:firmware": ["parts", "pins", "behavior"] }
const ACTIVE = new Set(["thinking", "tool", "building", "checking", "held"])

// The run's clock: run.started, else the first event. ripples.json times are ms from it.
export function runStart(events) {
	const e = events.find((x) => x.type === "run.started") ?? events[0]
	return e ? Date.parse(e.at) : null
}

// One ripple per request ({at, text}, requests.jsonl order), from the trace alone, as of `now` (epoch ms).
export function liveRipples(events, requests, now = Date.now()) {
	const lanes = createLanes()
	const windows = requests.map((r, i) => ({ r, i, from: Date.parse(r.at), to: i + 1 < requests.length ? Date.parse(requests[i + 1].at) : Infinity, events: [], cleanIn: true }))
	// consistency.checked only reports a change of result, so each window starts from the newest check before it.
	let clean = true
	let benchSource = null
	for (const e of events) {
		applyLaneEvent(lanes, e)
		if (e.type === "bench.connected") benchSource = e.payload.source
		const t = Date.parse(e.at)
		for (const w of windows) if (t < w.from) w.cleanIn = clean
		for (const w of windows) if (t < w.to) w.benchSource = benchSource
		if (e.type === "consistency.checked") clean = (e.payload.violations ?? []).length === 0
		const w = windows.find((x) => t >= x.from && t < x.to)
		if (w) w.events.push(e)
	}
	return windows.map((w) => ripple(w, lanes, now))
}

function ripple({ r, i, from, to, events: all, cleanIn, benchSource }, lanes, now) {
	// The request's ripple ends at the first design.ready after it, inclusive (src/runner/ripple.ts): what the brief
	// review changes after that is a follow-up, not the request. No design.ready yet: up to the next request.
	const readyAt = all.findIndex((e) => e.type === "design.ready")
	const events = readyAt >= 0 ? all.slice(0, readyAt + 1) : all
	const after = readyAt >= 0 ? all.slice(readyAt + 1) : []
	const reviewFollowUps = { fieldsChanged: [...new Set(after.filter((e) => e.type === "contract.changed").map((e) => e.payload.field))], rounds: after.filter((e) => e.type === "review.completed").length }
	const fields = []
	const changes = []
	const turned = new Set()
	const acted = new Set()
	let unsettled = false
	let settled = false
	for (const e of events) {
		const p = e.payload ?? {}
		if (e.type === "contract.changed") {
			if (!fields.includes(p.field)) fields.push(p.field)
			changes.push({ field: p.field, revision: p.revision, at: Date.parse(e.at) })
			acted.add(p.by)
		}
		if (e.type === "change.proposed") acted.add(p.by)
		if (e.type === "agent.activity" && p.phase === "turn" && AGENTS.has(p.role)) turned.add(p.role)
		if (e.type === "design.settled") (p.settled ? (settled = true) : (unsettled = true))
	}
	const touched = (inputs) => fields.some((f) => inputs.includes(f))
	// Woke: changed or proposed a field (agents), or had its inputs change (builders, grounding, consistency).
	// Checked: took a turn and changed nothing. Same three-way split as the runner's ripples.json.
	const wakes = (k) => (AGENTS.has(k) ? acted.has(k) : BUILD_INPUTS[k] ? touched(BUILD_INPUTS[k]) : k === "grounding" ? touched(["parts", "pins"]) : fields.length > 0)
	const woke = KEYS.filter(wakes)
	// Reading: took a turn, still at it, nothing changed or proposed yet; it ends as woke or checked. Live only.
	const reading = to === Infinity && readyAt < 0 ? KEYS.filter((k) => turned.has(k) && !wakes(k) && ACTIVE.has(lanes[k]?.status)) : []
	const checked = KEYS.filter((k) => !wakes(k) && turned.has(k) && !reading.includes(k))
	const stayedIdle = KEYS.filter((k) => !wakes(k) && !turned.has(k))
	const lastChange = changes.at(-1) ?? null

	// Consistent again: the newest check is clean and every woken builder has reached the last change to its
	// inputs. A contract change or a dirty check resets it (same rule as src/runner/ripple.ts).
	const builds = woke.filter((k) => BUILD_INPUTS[k]).map((k) => buildCheck(k, events, changes))
	const seq = []
	let clean = cleanIn
	let consistentAtMs = null
	let lastCount = null
	const seen = []
	for (const e of events) {
		const t = Date.parse(e.at)
		seen.push(e)
		if (e.type === "contract.changed") consistentAtMs = null
		if (e.type === "consistency.checked") {
			const n = (e.payload.violations ?? []).length
			if (seq.at(-1) !== n) seq.push(n)
			lastCount = n
			clean = n === 0
			if (!clean) consistentAtMs = null
		}
		const sofar = changes.filter((c) => c.at <= t)
		if (consistentAtMs === null && sofar.length && clean && caughtUp(seen, sofar)) consistentAtMs = t
	}
	const state = consistentAtMs !== null ? "consistent" : unsettled ? "unsettled" : fields.length ? "rippling" : settled || to !== Infinity || readyAt >= 0 ? "no-change" : "sent"
	const checks = []
	if (fields.length) checks.push({ key: "consistency", label: "Contract", seq, state: clean ? "ok" : "error", detail: clean ? "consistent" : `${lastCount} violation${lastCount === 1 ? "" : "s"}` })
	for (const b of builds) checks.push({ key: b.key, label: b.label, state: b.state, detail: b.detail })
	if (woke.includes("grounding")) checks.push(groundingCheck(events))
	if (benchSource && woke.includes("build:firmware")) checks.push(benchCheck(benchSource, events, changes))
	return {
		id: `req-${i + 1}`,
		text: r.text,
		// Saved in a generated file (pins.h, board.kicad_pcb) rather than typed: which file, and what it changed.
		file: r.source?.kind === "file" ? { name: r.source.path.split("/").pop(), path: r.source.path, revision: r.source.revision, items: r.source.items ?? [] } : null,
		atMs: from,
		fieldsChanged: fields,
		woke,
		checked,
		reading,
		stayedIdle,
		working: state === "consistent" ? [] : woke.filter((k) => ACTIVE.has(lanes[k]?.status)),
		violationsPeak: seq.length ? Math.max(...seq) : 0,
		violations: seq,
		consistentAtMs,
		durationMs: consistentAtMs === null ? null : consistentAtMs - from,
		revisions: changes.length ? { from: Math.min(...changes.map((c) => c.revision)), to: Math.max(...changes.map((c) => c.revision)) } : null,
		checks,
		state,
		reviewFollowUps,
	}
}

// Every builder that the changes so far woke has a build (ready or failed) at or past the last change to its inputs.
function caughtUp(events, changes) {
	for (const [key, inputs] of Object.entries(BUILD_INPUTS)) {
		const need = changes.filter((c) => inputs.includes(c.field)).map((c) => c.revision)
		if (!need.length) continue
		const rev = Math.max(...need)
		const kind = key.slice("build:".length)
		if (!events.some((e) => (e.type === "artifact.ready" || e.type === "artifact.failed") && e.payload.kind === kind && e.payload.revision >= rev)) return false
	}
	return true
}

const BUILD_LABEL = { "build:board": "Board", "build:enclosure": "Case", "build:firmware": "Firmware" }

function buildCheck(key, events, changes) {
	const kind = key.slice("build:".length)
	const need = Math.max(...changes.filter((c) => BUILD_INPUTS[key].includes(c.field)).map((c) => c.revision))
	let done = null
	let boot = null
	for (const e of events) {
		const p = e.payload ?? {}
		if ((e.type === "artifact.ready" || e.type === "artifact.failed") && p.kind === kind && p.revision >= need) done ??= e
		if (e.type === "firmware.booted" && kind === "firmware") boot = p
	}
	if (!done) return { key, label: BUILD_LABEL[key], state: "running", detail: `building rev ${need}`, doneAt: null }
	const doneAt = Date.parse(done.at)
	if (done.type === "artifact.failed") return { key, label: BUILD_LABEL[key], state: "error", detail: `rev ${done.payload.revision} failed`, doneAt }
	const drc = done.payload.drc
	if (drc) {
		// Errors inside one part's own footprint (its vendor land pattern) are amber and named; any other is red.
		const own = Object.entries(drc.ownFootprint ?? {})
		const ownCount = own.reduce((n, [, c]) => n + c, 0)
		const ownText = own.map(([ref, n]) => `${n} inside ${ref}'s footprint`).join(", ")
		const rev = `rev ${done.payload.revision}`
		if (drc.errors + drc.unconnected === 0) {
			// Clean, and which custom rule that relied on (the USB-C vendor land pattern), by kind.
			const kinds = [...new Set((drc.exemptions ?? []).map((x) => x.replace(/ \(.*$/, "")))]
			return { key, label: BUILD_LABEL[key], state: "ok", detail: `${rev} · ${kinds.length ? `DRC clean (${drc.exemptions.length} rule${drc.exemptions.length === 1 ? "" : "s"}: ${kinds.join(", ")})` : "DRC 0 errors"}`, doneAt }
		}
		if (ownCount === drc.errors && !drc.unconnected) return { key, label: BUILD_LABEL[key], state: "warn", detail: `${rev} · DRC: ${ownText}`, doneAt }
		return { key, label: BUILD_LABEL[key], state: "error", detail: `${rev} · DRC ${drc.errors} errors${drc.unconnected ? `, ${drc.unconnected} unconnected` : ""}${ownCount ? ` (${ownText})` : ""}`, doneAt }
	}
	if (boot) return { key, label: BUILD_LABEL[key], state: boot.booted ? "ok" : "error", detail: boot.booted ? `rev ${done.payload.revision} · boots in QEMU` : `rev ${done.payload.revision} · did not boot`, doneAt }
	return { key, label: BUILD_LABEL[key], state: "ok", detail: `rev ${done.payload.revision} built`, doneAt }
}

// On a bench run, the change followed onto the board: the firmware built from it flashed, booted, and its LED
// measured against the contract's behavior (bench.blink).
function benchCheck(source, events, changes) {
	const label = source === "real" ? "Real board" : `Bench (${String(source).toUpperCase()})`
	const need = Math.max(...changes.filter((c) => BUILD_INPUTS["build:firmware"].includes(c.field)).map((c) => c.revision))
	const last = (type) => events.filter((e) => e.type === type && e.payload.revision >= need).at(-1)?.payload
	const blink = last("bench.blink"), flashed = last("bench.flashed"), flashing = last("bench.flashing")
	if (blink) {
		const what = typeof blink.tiltBlinkMs === "number" ? `tilted ${blink.tiltBlinkMs} ms` : `blink ${blink.blinkMs} ms`
		if (!blink.pass) return { key: "bench", label, state: "error", detail: `rev ${blink.revision} · ${blink.detail}`, short: `${what} ✗` }
		return { key: "bench", label, state: "ok", detail: `rev ${blink.revision} running · ${what} measured`, short: `${what} ✓` }
	}
	if (flashed) return flashed.ok ? { key: "bench", label, state: "running", detail: `rev ${flashed.revision} running · measuring the blink`, short: "running · measuring" } : { key: "bench", label, state: "error", detail: `rev ${flashed.revision} flash failed: ${flashed.error}`, short: "flash failed" }
	if (flashing) return { key: "bench", label, state: "running", detail: `flashing rev ${flashing.revision} · ${flashing.stage} ${flashing.pct} %`, short: `flashing ${flashing.pct} %` }
	return { key: "bench", label, state: "running", detail: `waiting to flash rev ${need}`, short: "waiting to flash" }
}

function groundingCheck(events) {
	const last = events.filter((e) => e.type === "grounding.checked").at(-1)
	if (!last) return { key: "grounding", label: "Datasheets", state: "running", detail: "checking" }
	const n = (last.payload.findings ?? []).length
	return { key: "grounding", label: "Datasheets", state: n ? "warn" : "ok", detail: n ? `${n} ungrounded` : "every pin grounded" }
}

// ripples.json (times in ms from run.started) over the live view: the runner's answer wins once it has one.
export function mergeRipples(live, file, t0) {
	const byId = new Map((file?.requests ?? []).map((f) => [f.id, f]))
	const abs = (v) => (typeof v === "number" ? t0 + v : null)
	return live.map((r) => {
		const f = byId.get(r.id)
		if (!f) return r
		const out = { ...r, atMs: abs(f.atMs) ?? r.atMs, fieldsChanged: f.fieldsChanged ?? r.fieldsChanged, woke: f.woke ?? r.woke, checked: f.checked ?? r.checked, stayedIdle: f.stayedIdle ?? r.stayedIdle, violationsPeak: f.violationsPeak ?? r.violationsPeak, reviewFollowUps: f.reviewFollowUps ?? r.reviewFollowUps }
		// The file has no "reading": a live reader stays one until the file says it woke.
		out.reading = typeof f.consistentAtMs === "number" ? [] : r.reading.filter((k) => !(f.woke ?? []).includes(k))
		out.checked = out.checked.filter((k) => !out.reading.includes(k))
		if (typeof f.consistentAtMs === "number") Object.assign(out, { consistentAtMs: abs(f.consistentAtMs), durationMs: f.durationMs, state: "consistent", working: [] })
		return out
	})
}

const secs = (ms) => {
	if (ms < 1000) return "under 1 s"
	const s = Math.max(0, Math.round(ms / 1000))
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}


// ── Before → after ────────────────────────────────────────────────────────────────────────────────

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// What moved between two contracts' values: the outline, connectors (edge and offset), pins (GPIO) and parts (MPN).
export function whatMoved(before, after) {
	const none = { outline: null, connectors: [], pins: [], parts: [], count: 0 }
	if (!before || !after) return none
	const bo = before.outline, ao = after.outline
	const outline = bo && ao && (bo.widthMm !== ao.widthMm || bo.heightMm !== ao.heightMm) ? { before: { w: bo.widthMm, h: bo.heightMm }, after: { w: ao.widthMm, h: ao.heightMm } } : null
	const place = (c) => (c ? { edge: c.edge, offsetMm: c.offsetMm, widthMm: c.widthMm } : null)
	const bc = new Map((before.connectors ?? []).map((c) => [c.ref, c]))
	const ac = new Map((after.connectors ?? []).map((c) => [c.ref, c]))
	const connectors = []
	for (const ref of new Set([...bc.keys(), ...ac.keys()])) {
		const b = place(bc.get(ref)), a = place(ac.get(ref))
		if (!same(b, a)) connectors.push({ ref, kind: (ac.get(ref) ?? bc.get(ref)).kind, before: b, after: a })
	}
	const bp = new Map((before.pins ?? []).map((p) => [p.signal, p.gpio]))
	const ap = new Map((after.pins ?? []).map((p) => [p.signal, p.gpio]))
	const pins = []
	for (const signal of new Set([...bp.keys(), ...ap.keys()])) if (bp.get(signal) !== ap.get(signal)) pins.push({ signal, before: bp.get(signal) ?? null, after: ap.get(signal) ?? null })
	const bm = new Map((before.parts ?? []).map((p) => [p.ref, p.mpn]))
	const am = new Map((after.parts ?? []).map((p) => [p.ref, p.mpn]))
	const parts = []
	for (const ref of new Set([...bm.keys(), ...am.keys()])) if (bm.get(ref) !== am.get(ref)) parts.push({ ref, before: bm.get(ref) ?? null, after: am.get(ref) ?? null })
	return { outline, connectors, pins, parts, count: (outline ? 1 : 0) + connectors.length + pins.length + parts.length }
}

// ── The 04 Result banner as a live status line ──────────────────────────────────────────────────────────────────
// What is happening now, in plain words (who is rebuilding for what, what doesn't line up yet, what the bench is
// doing), then how the change ended. Everything comes from the ripple and the latest consistency check.

// The latest check's violations in words: the domains that disagree.
export const PROBLEM = {
	"outline-mismatch": "board and case outlines differ",
	"cutout-misaligned": "the case's cutouts don't line up with the board",
	"cutout-missing": "the case is missing a cutout for a connector",
	"standoff-mismatch": "the case's standoffs don't meet the board's holes",
	"pin-mismatch": "the firmware's pins don't match the board",
	"net-missing": "the board is missing a connection",
	"part-mismatch": "the board's parts don't match the parts list",
	"sensor-mismatch": "the firmware drives a different sensor than the board has",
	"firmware-build-failed": "the firmware doesn't build",
	"history-overflow": "the history doesn't fit in flash",
}
const WHO_SHORT = { architect: "architect", parts: "parts", firmware: "firmware agent", reviewer: "reviewer", "build:board": "board", "build:enclosure": "case", "build:firmware": "firmware", grounding: "datasheet check", consistency: "consistency check" }
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
const and = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`)
const mismatches = (n) => `${n} mismatch${n === 1 ? "" : "es"}`

// The change in a few words: a width, a file edit, or the request itself in quotes.
function changeLabel(r) {
	if (r.file) return `${r.file.name} edit (${r.file.items.join("; ")})`
	const w = /(\d+(?:\.\d+)?)\s*mm wide/i.exec(r.text)
	return w ? `${w[1]} mm wide` : `“${r.text}”`
}
function problem(violations, n) {
	const kinds = [...new Set((violations ?? []).map((v) => v.kind))]
	return kinds.length && PROBLEM[kinds[0]] ? PROBLEM[kinds[0]] : null
}

export function statusLine({ ripple: r, now = Date.now(), stubbed = false, violations = [], settled = null, revision = 0, firstAtMs = null, endAtMs = null, workingCount = 0, open = true, benchAsk = null }) {
	if (!r) {
		if (firstAtMs === null) return { state: "initial", headline: "Starting up", detail: "" }
		if (!settled) return { state: "rippling", headline: "Designing from the brief", detail: `${workingCount} agent${workingCount === 1 ? "" : "s"} working · rev ${revision} · ${secs(now - firstAtMs)}` }
		if (settled.settled) return { state: "consistent", headline: `First design consistent at rev ${settled.revision}`, detail: `${secs((endAtMs ?? now) - firstAtMs)} from the brief · ${open ? "now change one thing ↑" : "this run has ended"}` }
		return { state: "unsettled", headline: `Stopped: not consistent at rev ${settled.revision}`, detail: problem(violations) ?? "see the Consistency tile" }
	}
	const label = changeLabel(r)
	const bench = r.checks?.find((c) => c.key === "bench")
	if (r.state === "consistent" && bench) {
		const board = bench.label === "Real board" ? "the real board" : bench.label.toLowerCase()
		const done = `${label} · consistent in ${secs(r.durationMs)}`
		if (bench.state === "ok") return { state: "consistent", headline: `Measured on ${board}: ${bench.short}`, detail: `${done} · ${bench.detail.split(" · ")[0]}` }
		if (bench.state === "error") return { state: "unsettled", headline: `${cap(board.replace(/^the /, ""))}: ${bench.detail.replace(/^rev \d+ · /, "").replace(/^rev \d+ /, "")}`, detail: `${label} · the design is consistent, the board disagrees` }
		const headline = benchAsk === "tilt" ? "Your turn: tilt the board"
			: bench.short === "waiting to flash" ? `Flashing ${board} next`
			: bench.short.startsWith("flashing") ? `Flashing ${board} · ${bench.short.replace(/^flashing /, "")}`
			: `Measuring the blink on ${board}`
		return { state: "rippling", headline, detail: `${done} · now on ${board}` }
	}
	const acted = `${r.woke.length} of ${KEYS.length} agents had to act`
	switch (r.state) {
		case "sent": return { state: "sent", headline: `Agents reading ${label}`, detail: "deciding which fields it touches" }
		case "consistent": return { state: "consistent", headline: `${label}: board, case and firmware agree`, detail: `in ${secs(r.durationMs)}${stubbed ? " · hardware stubbed" : ""} · ${acted}` }
		case "no-change": return { state: "no-change", headline: `Nothing to change for ${label}`, detail: `${r.checked?.length ?? 0} agent${r.checked?.length === 1 ? "" : "s"} checked it · no field moved` }
		case "unsettled": {
			const n = r.violations.at(-1) ?? r.violationsPeak
			return { state: "unsettled", headline: `Stopped: ${mismatches(n)} left after ${label}`, detail: problem(violations) ?? "see the Consistency tile" }
		}
	}
	// Rippling: a mismatch in words if there is one, else who is working on it.
	const n = r.violations.at(-1) ?? 0
	const took = secs(now - r.atMs)
	if (n > 0) return { state: "rippling", headline: cap(problem(violations) ?? `${mismatches(n)} to fix`), detail: `${label} · ${mismatches(n)} · the agents are fixing it · ${took}` }
	const builders = r.working.filter((k) => k.startsWith("build:")).map((k) => WHO_SHORT[k])
	const agents = r.working.filter((k) => !k.startsWith("build:")).map((k) => WHO_SHORT[k] ?? k)
	const headline = builders.length ? `${cap(and(builders))} rebuilding for ${label}` : agents.length ? `${cap(and(agents))} working on ${label}` : `Checking ${label}`
	return { state: "rippling", headline, detail: `${r.fieldsChanged.join(", ") || "no field"} changed · ${r.stayedIdle.length} agent${r.stayedIdle.length === 1 ? "" : "s"} not affected · ${took}` }
}
