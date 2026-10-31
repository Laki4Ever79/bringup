// Pure view-model helpers for the dashboard (docs/design/dashboard.md): the revision scrubber, pull-request
// cards with before→after diffs, the changed refs that glow on the PCB, the three check pills, the battery gauge.
// Plain ES module with no dependencies: the page imports it from /model.js and the tests import it in Node.

// One accent per participant (the spec's agent colours). Keys are agent roles and lane keys.
export const AGENT_COLORS = {
	architect: "#3b82f6",
	parts: "#a855f7",
	firmware: "#14b8a6",
	reviewer: "#f59e0b",
	"build:board": "#22c55e",
	"build:enclosure": "#ec4899",
	"build:firmware": "#06b6d4",
	grounding: "#eab308",
	consistency: "#f97316",
	engineer: "#e5e7eb",
}

// Who owns each contract field (src/contract/types.ts OWNERS).
const OWNERS = { requirements: "architect", outline: "architect", connectors: "architect", rails: "architect", parts: "parts", pins: "architect" }

// ── Revision scrubber ────────────────────────────────────────────────────────────────────────────

// Every contract revision as a dot (its first change), coloured by its author, and the revisions that have a board.
export function scrubberModel(events) {
	const dots = []
	const seen = new Set()
	const boards = []
	for (const e of events) {
		const p = e.payload ?? {}
		if (e.type === "contract.changed" && !seen.has(p.revision)) {
			seen.add(p.revision)
			dots.push({ revision: p.revision, field: p.field, version: p.version, by: p.by, color: AGENT_COLORS[p.by] ?? AGENT_COLORS.engineer, at: e.at, board: false })
		}
		if (e.type === "artifact.ready" && p.kind === "board" && !boards.includes(p.revision)) boards.push(p.revision)
	}
	boards.sort((a, b) => a - b)
	for (const d of dots) d.board = boards.includes(d.revision)
	return { dots, boards }
}

// The board to show for a revision: the newest one built at or before it.
export function boardFor(model, revision) {
	let best = null
	for (const b of model.boards) if (b <= revision) best = b
	return best
}

// ── Contract diffs ───────────────────────────────────────────────────────────────────────────────

const LIST_KEY = { pins: "signal", parts: "ref", connectors: "ref", rails: "name" }
const LABEL = {
	pins: (p) => `${p.signal} → GPIO${p.gpio} (${p.partRef}.${p.partPin})`,
	parts: (p) => `${p.ref} ${p.mpn}`,
	connectors: (c) => `${c.ref} ${c.kind} ${c.edge} @ ${c.offsetMm} mm`,
	rails: (r) => `${r.name} ${r.voltageV} V ${r.loadMa}/${r.regulatorMaxMa} mA`,
}
// What a changed list entry shows after its key: the part of LABEL that can differ.
const CHANGE = {
	pins: (a, b) => (a.gpio !== b.gpio ? `GPIO${a.gpio} → GPIO${b.gpio}` : `${a.partRef}.${a.partPin} → ${b.partRef}.${b.partPin}`),
	// Same MPN and footprint: name what did change (pins, LCSC number, role…), not "SOT-23-5 → SOT-23-5".
	parts: (a, b) => (a.mpn !== b.mpn ? `${a.mpn} → ${b.mpn}` : a.footprint !== b.footprint ? `${a.footprint} → ${b.footprint}` : `${b.mpn}: ${Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort().join(", ")} changed`),
	connectors: (a, b) => `${a.kind} ${a.edge} @ ${a.offsetMm} mm → ${b.kind} ${b.edge} @ ${b.offsetMm} mm`,
	rails: (a, b) => `${a.voltageV} V ${a.loadMa}/${a.regulatorMaxMa} mA → ${b.voltageV} V ${b.loadMa}/${b.regulatorMaxMa} mA`,
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const show = (v) => (typeof v === "string" ? v : JSON.stringify(v))

// Compact before→after lines for one field: "+ added", "− removed", "~ changed".
export function contractDiff(field, before, after) {
	const key = LIST_KEY[field]
	if (key) {
		const b = new Map((before ?? []).map((x) => [x[key], x]))
		const a = new Map((after ?? []).map((x) => [x[key], x]))
		const out = []
		for (const [k, x] of a) if (b.has(k) && !same(b.get(k), x)) out.push(`~ ${k} ${CHANGE[field](b.get(k), x)}`)
		for (const [k, x] of b) if (!a.has(k)) out.push(`− ${LABEL[field](x)}`)
		for (const [k, x] of a) if (!b.has(k)) out.push(`+ ${LABEL[field](x)}`)
		return out
	}
	const b = before ?? {}
	const a = after ?? {}
	const out = []
	for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (!same(b[k], a[k])) out.push(`~ ${k} ${show(b[k] ?? "—")} → ${show(a[k] ?? "—")}`)
	return out
}

// Refs to glow on the PCB after a revision: parts whose entry changed, plus both ends of changed pins.
export function changedRefs(before, after) {
	if (!before || !after) return []
	const refs = new Set()
	const b = new Map((before.parts ?? []).map((p) => [p.ref, p]))
	for (const p of after.parts ?? []) if (!same(b.get(p.ref), p)) refs.add(p.ref)
	const mcu = (after.parts ?? []).find((p) => p.role === "mcu")?.ref
	const pb = new Map((before.pins ?? []).map((p) => [p.signal, p]))
	const pa = new Map((after.pins ?? []).map((p) => [p.signal, p]))
	for (const [sig, p] of pa) {
		if (same(pb.get(sig), p)) continue
		refs.add(p.partRef)
		if (mcu) refs.add(mcu)
		if (pb.get(sig)) refs.add(pb.get(sig).partRef)
	}
	for (const [sig, p] of pb) if (!pa.has(sig)) refs.add(p.partRef)
	return [...refs].sort()
}

// ── Pull-request cards ───────────────────────────────────────────────────────────────────────────

function nearest(snapshots, revision, below) {
	let best = null
	for (const [r, s] of snapshots) {
		if (below ? r < revision && (best === null || r > best[0]) : r >= revision && (best === null || r < best[0])) best = [r, s]
	}
	return best ? best[1] : null
}

// Held changes as pull requests. change.decided is one vote (an owner agent or the engineer); change.resolved is
// the outcome. Traces from before change.resolved existed fall back to the first vote, unless the engineer's vote
// was required. The diff compares the contract just before and at the revision the approved
// change was applied (the requester's next contract.changed on that field), from snapshots kept as they stream.
export function prCards(events, snapshots) {
	const cards = new Map()
	for (const e of events) {
		const p = e.payload ?? {}
		if (e.type === "change.proposed") {
			const needsEngineer = p.needsEngineer === true
			cards.set(p.proposalId, { id: p.proposalId, field: p.field, requester: p.by, owner: OWNERS[p.field] ?? "architect", reason: p.reason, needsEngineer, status: needsEngineer ? "waiting" : "pending", resolved: false, votes: [], decidedBy: null, why: null, revision: null, diff: [], at: e.at })
		} else if (e.type === "change.decided" && cards.has(p.proposalId)) {
			const c = cards.get(p.proposalId)
			c.votes.push({ by: p.by, approved: p.approved, reason: p.reason })
			if (!c.resolved && !c.needsEngineer) Object.assign(c, { status: p.approved ? "approved" : "rejected", decidedBy: [p.by], why: p.reason })
		} else if (e.type === "change.resolved" && cards.has(p.proposalId)) {
			Object.assign(cards.get(p.proposalId), { resolved: true, status: p.approved ? "approved" : "rejected", decidedBy: p.decidedBy ?? [], why: p.reason })
		} else if (e.type === "contract.changed") {
			for (const c of cards.values()) if (c.status === "approved" && c.revision === null && c.field === p.field && c.requester === p.by) c.revision = p.revision
		}
	}
	for (const c of cards.values()) {
		if (c.revision === null) continue
		const before = nearest(snapshots, c.revision, true)
		const after = nearest(snapshots, c.revision, false)
		if (after) c.diff = contractDiff(c.field, before?.values?.[c.field], after.values?.[c.field])
	}
	return [...cards.values()]
}

// ── Check pills ──────────────────────────────────────────────────────────────────────────────────

// The three checks for the top bar: state pending | running | ok | warn | error, a count and the popover lines.
export function checkPills(events) {
	let consistency = null
	let grounding = null
	let ready = null
	let review = null
	let board = null
	let started = null
	for (const e of events) {
		if (e.type === "consistency.checked") consistency = e.payload
		if (e.type === "grounding.checked") grounding = e.payload
		if (e.type === "design.ready") ready = e.payload
		if (e.type === "review.completed") review = e.payload
		if (e.type === "artifact.ready" && e.payload.kind === "board") board = e.payload
		if (e.type === "run.started") started = e.payload
	}
	const v = consistency?.violations ?? []
	const f = grounding?.findings ?? []
	const rf = review?.findings ?? []
	const reviewRunning = ready && (!review || review.revision < ready.revision)
	const pills = [
		{ key: "consistency", label: "Consistency", state: !consistency ? "pending" : v.length ? "error" : "ok", count: v.length, revision: consistency?.revision ?? null, items: v.map((x) => `${x.kind}: ${x.message}`) },
		{ key: "grounding", label: "Grounding", state: !grounding ? "pending" : f.length ? "warn" : "ok", count: f.length, revision: grounding?.revision ?? null, items: f.map((x) => `${x.kind} on ${x.partRef}: ${x.detail}`) },
		{
			key: "review",
			label: "Review",
			state: started?.review === false ? "off" : reviewRunning ? "running" : !review ? "pending" : review.verdict === "pass" ? "ok" : "error",
			count: rf.length,
			revision: review?.revision ?? ready?.revision ?? null,
			items: started?.review === false ? ["the brief review is off for this run (--no-review)"] : rf.map((x) => `${x.severity} · ${(x.fields ?? []).join(", ")}: ${x.issue}`),
		},
	]
	// KiCad's DRC of the newest board build, against the fab's rules. Unconnected nets count as errors.
	const drc = board?.drc
	if (drc) {
		const bad = drc.errors + drc.unconnected
		// Errors inside one part's own footprint: amber with the reason. Any other error, or an unconnected net, is red.
		const own = Object.entries(drc.ownFootprint ?? {})
		const ownCount = own.reduce((n, [, c]) => n + c, 0)
		const ownOnly = drc.errors > 0 && ownCount === drc.errors && drc.unconnected === 0
		pills.push({
			key: "drc",
			label: "DRC",
			// KiCad's warnings (silkscreen over copper, library notes, text height) don't stop the fab: no errors is clean.
			state: ownOnly ? "warn" : bad > 0 ? "error" : "ok",
			count: bad > 0 ? bad : drc.warnings,
			revision: board.revision,
			items: [
				...(bad === 0 && drc.exemptions?.length ? [`DRC clean · ${drc.exemptions.length} rule${drc.exemptions.length === 1 ? "" : "s"}: ${drc.exemptions.join("; ")}`] : []),
				...(ownCount ? [`${own.map(([ref, n]) => `${n} inside ${ref}'s own footprint`).join(", ")}: the part's vendor land pattern against the fab's generic rule, not the layout`] : []),
				`${drc.errors} errors · ${drc.warnings} warnings · ${drc.unconnected} unconnected (${drc.rules})`,
				...Object.entries(drc.byType ?? {}).map(([type, n]) => `${type} × ${n}`),
				...(drc.firstError ? [`first: ${drc.firstError}`] : []),
			],
		})
	}
	const bench = benchState(events)
	if (bench) {
		const failed = bench.verdict ? bench.verdict.checks.filter((c) => !c.pass) : []
		const flashing = bench.flash && bench.flash.ok === null
		pills.push({
			key: "bench",
			label: bench.source === "real" ? "Bench" : `Bench · ${bench.source.toUpperCase()}`,
			state: flashing ? "running" : !bench.verdict ? "pending" : bench.verdict.pass ? "ok" : "error",
			count: failed.length,
			revision: bench.verdict?.revision ?? bench.flash?.revision ?? null,
			items: [
				...(bench.verdict ? bench.verdict.checks.map((c) => `${c.skipped ? "–" : c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`) : []),
				...(bench.meter ? [] : ["battery life: estimated only, no meter on this bench"]),
			],
		})
	}
	return pills
}

// ── Bench (bring-up on the desk) ──────────────────────────────────────────────────────────────────

// The bench as the page shows it, from the bench.* events; null until the bridge connects.
export function benchState(events) {
	let state = null
	for (const e of events) {
		const p = e.payload
		switch (e.type) {
			case "bench.connected":
				state = { source: p.source, meter: p.meter, ports: p.ports, flash: null, verdict: null, measured: null, instruction: null, blink: null }
				break
			case "bench.flashing":
				if (!state) break
				state.flash = { revision: p.revision, stage: p.stage, pct: p.pct, ok: null, error: null }
				break
			case "bench.flashed":
				if (!state) break
				// The board has spoken (or the flash failed): no step is waiting for the person any more.
				state.instruction = null
				state.flash = { revision: p.revision, stage: p.ok ? "boot" : (p.stage ?? "write"), pct: p.ok ? 100 : (state.flash?.revision === p.revision ? state.flash.pct : 0), ok: p.ok, error: p.error ?? null, ...(p.simulated ? { simulated: true } : {}) }
				break
			case "bench.verdict":
				if (state) state.verdict = p
				break
			case "bench.instruction":
				if (state) state.instruction = p.state === "waiting" ? { revision: p.revision, action: p.action, text: p.text } : null
				break
			case "bench.measured":
				if (state) state.measured = p
				break
			// The LED periods measured on the board against the contract's behavior (Act 3).
			case "bench.blink":
				if (state) state.blink = p
				break
		}
	}
	return state
}

const FLASH_STEPS = ["build", "connect", "write", "boot"]
// Where a failure lands on the bar: the bridge's failure stages, and the bench's own refusal (pins) before the build.
const FAIL_STEP = { pins: "build", build: "build", permission: "connect", connect: "connect", timeout: "write", write: "write", boot: "boot" }

// The flash bar: build → connect → write % → boot rev N.
export function flashSteps(flash) {
	const at = flash.ok === false ? FLASH_STEPS.indexOf(FAIL_STEP[flash.stage] ?? "build") : FLASH_STEPS.indexOf(flash.stage)
	return FLASH_STEPS.map((key, i) => ({
		key,
		label: key === "write" && flash.stage === "write" && flash.ok === null ? `write ${flash.pct} %` : key === "boot" ? `boot rev ${flash.revision}` : key,
		state: flash.ok === true || i < at ? "done" : i === at ? (flash.ok === false ? "failed" : "active") : "todo",
	}))
}

// Board attitude from gravity: roll = atan2(ay, az), pitch = atan2(−ax, √(ay² + az²)). No yaw (no gyro).
export function attitude(ax, ay, az) {
	return { pitch: Math.atan2(-ax, Math.hypot(ay, az)), roll: Math.atan2(ay, az) }
}

export function lowPass(prev, next, k) {
	return { pitch: prev.pitch + (next.pitch - prev.pitch) * k, roll: prev.roll + (next.roll - prev.roll) * k }
}

// The live chart's window of bench.telemetry samples, kept out of the event list (they arrive 4 times a second).
export class TelemetryBuffer {
	constructor(windowMs = 30_000) {
		this.windowMs = windowMs
		this.current = []
		this.tilt = []
		this.led = []
		this.lastImu = null
		// null until a sample says; false when the accel reads zero (no IMU fitted), so there is no tilt to show.
		this.imu = null
		// Whether the board is being shaken right now (null before a sample says).
		this.shake = null
	}
	add(samples) {
		for (const s of samples) {
			if (typeof s.mA === "number") this.current.push({ at: s.at, mA: s.mA })
			const accel = typeof s.ax === "number" && typeof s.ay === "number" && typeof s.az === "number"
			if (accel) this.imu = Math.hypot(s.ax, s.ay, s.az) > 0.3
			if (typeof s.tilt === "number" && (!accel || this.imu)) this.tilt.push({ at: s.at, tilt: s.tilt })
			if (typeof s.led === "number") this.led.push(typeof s.shake === "number" ? { at: s.at, led: s.led, shake: s.shake } : { at: s.at, led: s.led })
			if (typeof s.shake === "number") this.shake = s.shake === 1
			if (accel && this.imu) this.lastImu = { ax: s.ax, ay: s.ay, az: s.az, at: s.at }
		}
		const end = Math.max(this.current.at(-1)?.at ?? -Infinity, this.tilt.at(-1)?.at ?? -Infinity, this.led.at(-1)?.at ?? -Infinity)
		const from = end - this.windowMs
		const keep = (xs) => (xs.length && xs[0].at < from ? xs.filter((x) => x.at >= from) : xs)
		this.current = keep(this.current)
		this.tilt = keep(this.tilt)
		this.led = keep(this.led)
	}
}

// ── Battery gauge ────────────────────────────────────────────────────────────────────────────────

// "Estimated battery life: … = 198 days vs target 180 days" from report.md → {days, targetDays}.
export function parseBattery(reportText) {
	const line = /Estimated battery life:[^\n]*/.exec(reportText ?? "")?.[0]
	if (!line) return null
	const m = /(\d+(?:\.\d+)?) days(?: vs target (\d+(?:\.\d+)?) days)?\s*$/.exec(line)
	return m ? { days: Number(m[1]), targetDays: m[2] ? Number(m[2]) : null } : null
}

// ── Sourcing (bom.json items[i].sources / alternatives) ───────────────────────────────────────────

// Only absolute http(s) URLs may become an href.
export function safeUrl(url) {
	return typeof url === "string" && /^https?:\/\/[^/]/i.test(url) ? url : null
}

const stockText = (n) => (typeof n !== "number" ? "not checked" : n === 0 ? "out of stock" : `${n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : n} in stock`)
const priceText = (p) => (typeof p !== "number" ? "not checked" : `$${p.toFixed(p < 0.1 ? 3 : 2)}`)

// The part's sourcing popover rows: live numbers where known, "not checked" where not, never an invented one.
export function sourcingRows(item) {
	return {
		sources: (item.sources ?? []).map((s) => ({ supplier: s.supplier, url: safeUrl(s.url), stock: stockText(s.stock), price: priceText(s.priceUsd), note: s.note ?? null })),
		alternatives: (item.alternatives ?? []).map((a) => ({ mpn: a.mpn, lcsc: a.lcsc ?? null, stock: stockText(a.stock), price: priceText(a.priceUsd) })),
	}
}

// The line under the parts total: "18/18 listed at LCSC/JLCPCB", plus the lines that block the order, if any.
// The full summary (stock confirmed / unknown) stays in the tooltip and the per-part popover.
export function readinessShort(readiness) {
	if (!readiness) return ""
	const blocking = (readiness.lines ?? []).filter((l) => l.status === "out of stock" || l.status === "not listed").map((l) => `${l.ref} ${l.status}`)
	const c = readiness.counts
	// Stock not looked up (a scripted run, or offline): the parts that have an LCSC number, and say so; never "0/18 listed".
	if (c.notChecked) {
		const at = `${c.listed + c.notChecked}/${readiness.total} at ${readiness.supplier}`
		return [at, c.notChecked === c.listed + c.notChecked ? "stock not checked" : `${c.notChecked} not checked`, ...blocking].join(" · ")
	}
	return [`${c.listed}/${readiness.total} listed at ${readiness.supplier}`, ...blocking].join(" · ")
}

// One part's line in bom.json's order readiness. Amber only when the part can't be ordered as listed.
export function readinessLine(readiness, ref) {
	const line = (readiness?.lines ?? []).find((l) => l.ref === ref)
	return line ? { status: line.status, warn: line.status === "out of stock" || line.status === "not listed" } : null
}

// ── The bench LED mirrored on the design ──────────────────────────────────────────────────────────

// The part the firmware's status LED drives (the pins field's STATUS_LED → partRef), or null.
export function statusLedRef(contract) {
	return (contract?.values?.pins ?? []).find((p) => p.signal === "STATUS_LED")?.partRef ?? null
}

const MIRROR_LABEL = {
	real: (ref) => `${ref} mirrors the bench LED (S3 onboard GPIO48 stands in)`,
	replay: (ref) => `${ref} mirrors the recorded LED (REPLAY)`,
	fake: (ref) => `${ref} mirrors the simulated LED (FAKE bench)`,
}

// Whether the design's status LED should glow in the preview: on as the bench's LED last reported. Null when there
// is no bench, no LED reading yet, or no STATUS_LED in the design.
export function ledMirror({ contract, bench, led }) {
	const ref = statusLedRef(contract)
	const last = (led ?? []).at(-1)
	if (!bench || !ref || !last) return null
	// The onboard LED blinks red while the board is shaken, green otherwise (firmware fcb507c).
	return { ref, on: Boolean(last.led), color: last.shake === 1 ? "red" : "green", label: (MIRROR_LABEL[bench.source] ?? MIRROR_LABEL.fake)(ref) }
}

// Gravity as seen from the board's pose at boot: the rotation that takes the boot reading g0 to straight up, applied
// to g. At rest it is (0, 0, 1) however the IMU is mounted (the bench's MPU sits at 126° from vertical).
export function relativeGravity(g0, g) {
	const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
	const a = unit(g0), b = unit(g)
	// Rodrigues: v = a × z, c = a · z.
	const v = [a[1], -a[0], 0], c = a[2], s2 = v[0] * v[0] + v[1] * v[1]
	if (s2 < 1e-18) return c > 0 ? b : [b[0], -b[1], -b[2]]
	const k = (1 - c) / s2
	const vx = [[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]]
	const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) + vx[i][j] + k * [0, 1, 2].reduce((sum, m) => sum + vx[i][m] * vx[m][j], 0)))
	return R.map((row) => row[0] * b[0] + row[1] * b[1] + row[2] * b[2])
}

// Which part's sourcing popover is open after a click on a row (null: Esc, a click outside, or the × button).
export function toggleOpen(open, clicked) {
	return clicked === null || clicked === open ? null : clicked
}

// ── Run phase: the composer and the state pill ───────────────────────────────────────────────────

// Whether the composer takes a change, and what the state pill says. `stay`: the run keeps taking change requests
// after settling (run.started.stay); `alive`: no run.ended yet; `benchLive`: the bench is streaming.
export function runPhase({ settled, stay, alive, benchLive, stopped }) {
	const word = settled ? (settled.settled ? "SETTLED" : "UNSETTLED") : "LIVE"
	if (!settled) return { bar: "live", pill: "LIVE", open: true }
	if (stopped) return { bar: "stopped", pill: word, open: false }
	if (benchLive) return { bar: "bench", pill: `${word} · bench live`, open: true }
	// "open": it still takes changes (the composer says so at length; the header stays compact).
	if (stay && alive) return { bar: "waiting", pill: `${word} · open`, open: true }
	return { bar: "settled", pill: word, open: false }
}

// The composer's placeholder for the run's phase (runPhase().bar), honest about an unsettled design.
// Scripted agents act on a sensor ("add a … sensor"), a width ("make it N mm wide") and the blink; anything else is "no change".
const SCRIPTED_ASK = "“add a temperature/humidity sensor”, “make it 40 mm wide” or “blink faster when tilted”"

export function composerPrompt(bar, settled, { scripted = false } = {}) {
	if (scripted && bar === "waiting" && settled?.settled !== false) return `Settled. Change one thing: ${SCRIPTED_ASK}`
	if (scripted && bar === "live") return `Change one thing: ${SCRIPTED_ASK}`
	if (bar === "bench") return "Bring-up: ask for a change; a firmware change reflashes the board (try “blink faster when tilted”)"
	if (bar === "waiting") return settled?.settled === false ? "Not consistent yet: ask for a change that fixes it (the checks say what is wrong), or try another…" : "Settled. Now change one thing: make it 40 mm wide, swap a part, move a connector…"
	if (bar === "stopped") return "The run was stopped. Start a new design to change it."
	if (bar === "settled") return "This run has ended. Start a new design to change it."
	return "Make it 40 mm wide, swap a part, move a connector… while the agents work"
}

// ── Folds: the parts list and the revisions strip, collapsed by default, remembered per browser ──────────────────

export function foldHeader(kind, { count = 0, totalUsd = null, added = 0, changed = 0 } = {}) {
	if (kind === "revisions") return `Revisions · ${count}`
	if (kind === "register") return `Drawing register · ${count} run${count === 1 ? "" : "s"}`
	if (!count) return "Parts"
	return `Parts · ${count}${typeof totalUsd === "number" ? ` · $${totalUsd.toFixed(2)}` : ""}${added ? ` · ${added} new` : ""}${changed ? ` · ${changed} changed` : ""}`
}

const foldKey = (kind) => `bringup.fold.${kind}`
export function foldOpen(storage, kind) {
	try { return storage?.getItem(foldKey(kind)) === "open" } catch { return false }
}
export function setFold(storage, kind, open) {
	try { storage?.setItem(foldKey(kind), open ? "open" : "closed") } catch {}
}


// ── Drift: saved edits outside the contract (drift.json, owned by the run), with Adopt / Revert ──────────────────
const DRIFT_KIND = { "not-in-contract": "not in the design", stale: "stale save", adopted: "adopted" }
export function driftView(drift) {
	if (!drift) return { open: 0, rows: [], live: false }
	const live = drift.live === true
	const rows = [...(drift.entries ?? [])]
		.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))
		.map((e) => {
			const open = e.status === "open"
			const message = e.status === "adopted" ? `became change request #${String(e.requestId ?? "").replace(/^req-/, "") || "?"}`
				: e.status === "reverted" ? "reverted to the generated file"
				: e.kind === "stale" ? `saved against rev ${e.savedRevision}, the design is at rev ${e.designRevision}`
				: "not in the design contract; the next rebuild will overwrite it"
			const off = (reason) => ({ enabled: false, reason })
			const act = !open ? off("") : !live ? off("the run has ended") : null
			return {
				id: e.id, name: e.path.split("/").pop(), path: e.path, at: e.savedAt, items: e.items ?? [],
				kind: DRIFT_KIND[e.kind] ?? e.kind, message, status: e.status,
				revert: act ?? { enabled: true, reason: "" },
				adopt: act ?? (e.adoptable ? { enabled: true, reason: "" } : off(e.note ?? "this edit isn't in the design contract: nothing to adopt")),
				requestId: e.requestId ?? null,
			}
		})
	return { open: rows.filter((r) => r.status === "open").length, rows, live }
}

// ── What a ripple added or changed on the board: new refs glow as NEW, changed ones (moved pins, a swap) as CHANGED ──
export function rippleMarks(before, after) {
	if (!before || !after) return { added: [], changed: [] }
	const had = new Set((before.parts ?? []).map((p) => p.ref))
	const added = (after.parts ?? []).map((p) => p.ref).filter((r) => !had.has(r)).sort()
	return { added, changed: changedRefs(before, after).filter((r) => !added.includes(r)) }
}

// ── Scripted mode's briefs: the scripted models build one of two fixed designs, chosen by the brief ─────────────────
const SCRIPTED = [["beacon.md", "beacon.md (then add a sensor)"], ["logger.md", "logger.md"]]
export function scriptedBriefs(briefs) {
	return SCRIPTED.flatMap(([name, label]) => { const b = (briefs ?? []).find((x) => x.name === name); return b ? [{ name, label, text: b.text }] : [] })
}

// The battery estimate on the stage bar; short (below 1366px) as "103 d / 90 d".
export function batteryLabel({ days, targetDays = null, measured = false, source = "real", short = false }) {
	const d = Math.round(days)
	if (short) return targetDays !== null ? `${d} d / ${targetDays} d` : `${d} d${measured ? "" : " est."}`
	return `${d} days${measured ? ` measured${source !== "real" ? ` (${source})` : ""}` : ""}${targetDays !== null ? ` vs ${targetDays} target` : measured ? "" : " estimated"}`
}

// ── Files: the linked folder, your edits in plain words (one action each) and the design's git history ───────────────
// From GET /api/runs/:id/files ({linked, entries}) plus drift.json's `live`. Shows only with a folder or edits.
const SOURCE_LABEL = { brief: "the brief", typed: "typed", file: "file edit" }
const reqNo = (id) => `#${String(id ?? "").replace(/^req-/, "") || "?"}`
function editSays(e) {
	if (e.status === "open") return e.kind === "stale" ? `saved against rev ${e.savedRevision}, the design is at rev ${e.designRevision}` : "not in the design: the next rebuild will overwrite it"
	if (e.status === "re-saved") return "re-saved, no design change"
	if (e.status === "reverted") return "reverted to the generated file"
	if (e.status === "rebased") return `applied on top of the current design: change request ${reqNo(e.requestId)}`
	const clash = /^conflict: .*?sent to the owner of (\w+)/.exec(e.note ?? "")
	if (clash) return `clashes with a newer change: waiting for the owner of ${clash[1]}`
	return `adopted: change request ${reqNo(e.requestId)}`
}
export function filesView(files) {
	const linked = files?.linked ?? null
	const entries = files?.entries ?? []
	if (!linked && entries.length === 0) return { show: false, chip: "", folder: null, git: false, dirty: false, edits: [], history: [], open: 0 }
	const live = files.live !== false
	const edits = [...entries]
		.sort((a, b) => (a.status === "open") - (b.status === "open") || Date.parse(a.savedAt) - Date.parse(b.savedAt))
		.reverse()
		.map((e) => {
			const open = e.status === "open"
			const action = !open || !live ? null : e.adoptable ? "adopt" : "revert"
			return { id: e.id, name: e.path.split("/").pop(), path: e.path, at: e.savedAt, items: e.items ?? [], says: editSays(e), action, open, folded: e.status === "re-saved", requestId: e.requestId ?? null }
		})
	const open = edits.filter((e) => e.open).length
	const name = linked ? linked.dir.split("/").filter(Boolean).pop() : "files"
	const history = (linked?.commits ?? []).map((c) => ({ id: c.id, revision: c.revision, at: c.at, subject: c.subject.replace(/^Bringup rev \d+: /, ""), source: c.source, sourceLabel: SOURCE_LABEL[c.source] ?? c.source, requestId: c.requestId }))
	return { show: true, chip: `${name}${linked?.git ? " · git" : ""} · ${open ? `${open} edit${open === 1 ? "" : "s"}` : "clean"}`, folder: linked?.dir ?? null, git: Boolean(linked?.git), dirty: Boolean(linked?.dirty), edits, history, open }
}
