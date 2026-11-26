// Live progress of a system run (the lines of <out>/system-trace.jsonl, streamed by GET /api/systems/:id/stream):
// progressState folds them into where every board is; mountProgress draws that as a strip of chips under the stage.
// Nothing here runs between lines: the strip redraws once per animation frame after a line arrives.
export const STEPS = ["contract", "board", "case", "chassis", "firmware", "boot", "drive", "testkit", "link", "assembly", "request", "settled"]

// The last line per board (and per step), the highest round seen, and the system's own steps. A step from an earlier
// round stays as a chip flagged `prev` until its new line replaces it, so history is never cleared, only greyed.
export function progressState(lines) {
	const state = { round: 0, boards: {}, system: { step: null, status: null }, systemSteps: {} }
	const rounds = {}
	for (const l of lines) {
		if (typeof l?.round === "number" && l.round > state.round) state.round = l.round
		const one = { status: l.status, ...(l.detail ? { detail: l.detail } : {}), ...(l.revision != null && !Number.isNaN(l.revision) ? { revision: l.revision } : {}) }
		const own = l.board === "system"
		const steps = own ? state.systemSteps : (state.boards[l.board] ??= { step: l.step, status: l.status, steps: {} }).steps
		const newRound = (l.round ?? 0) > (rounds[l.board] ?? 0) || (l.step === "request" && l.status === "started")
		rounds[l.board] = Math.max(rounds[l.board] ?? 0, l.round ?? 0)
		if (newRound) for (const x of Object.values(steps)) x.prev = true
		steps[l.step] = one
		if (own) { state.system = { step: l.step, status: l.status, ...(l.detail ? { detail: l.detail } : {}) }; continue }
		const b = state.boards[l.board]
		b.step = l.step; b.status = l.status; b.detail = l.detail; b.revision = l.revision
		if (l.detail === undefined) delete b.detail
		if (l.revision === undefined) delete b.revision
	}
	return state
}

// A board trace event (the run's own events) as a progress step: the browser's copy of stepOf in src/system/trace.ts,
// so a one-board design shows the same strip. Returns null for events the strip does not show.
const KIND_STEP = { board: "board", enclosure: "case", chassis: "chassis", firmware: "firmware", drive: "drive", testkit: "testkit" }
export function stepOfEvent(event) {
	const p = event?.payload ?? {}
	if (event?.type === "artifact.ready") {
		const step = KIND_STEP[String(p.kind)]
		if (!step) return null
		const summary = p[String(p.kind)]
		const skipped = typeof p.skipped === "string" ? p.skipped : undefined
		const notRun = Boolean(skipped) || summary?.result === "not run"
		const drcErrors = step === "board" && (p.drc?.errors ?? 0) > 0
		const failed = summary?.result === "fail" || drcErrors
		const detail = skipped ?? (summary?.result === "not run" && summary.reason ? summary.reason : undefined) ?? (drcErrors ? `DRC: ${p.drc.errors} error(s)${p.drc.firstError ? `, first: ${p.drc.firstError}` : ""}` : failed && summary?.failed ? `failed at ${summary.failed}` : undefined)
		return { step, status: notRun ? "not run" : failed ? "failed" : "ok", revision: Number(p.revision), ...(detail ? { detail } : {}) }
	}
	if (event?.type === "artifact.failed") {
		const step = KIND_STEP[String(p.kind)]
		return step ? { step, status: "failed", revision: Number(p.revision), detail: String(p.error ?? "").split("\n")[0].slice(0, 200) } : null
	}
	if (event?.type === "firmware.booted") return { step: "boot", status: p.booted ? "ok" : "failed", revision: Number(p.revision) }
	if (event?.type === "design.settled") return { step: "settled", status: p.settled ? "ok" : "failed", revision: Number(p.revision) }
	if (event?.type === "contract.changed") return { step: "contract", status: "ok", revision: Number(p.revision ?? p.version ?? 0), detail: String(p.field ?? "") }
	return null
}

// The small badge a board wears in the Top and 3D views: its current step, a tick once settled.
export function badgeOf(b) {
	if (!b) return null
	if (b.step === "settled" && b.status === "ok") return { text: "✓", kind: "ok", title: "settled" }
	const bad = b.status === "failed"
	return { text: `${bad ? "✗ " : ""}${b.step}`, kind: bad ? "bad" : b.status === "started" ? "run" : "idle", title: `${b.step}: ${b.status}${b.detail ? ` (${b.detail})` : ""}` }
}

const CSS = `
.pg { border: 1.5px solid var(--ink, #16140f); background: var(--paper, #fff); margin-top: 10px; padding: 8px 10px; display: grid; gap: 6px; font: 12px/1.3 var(--mono, ui-monospace, monospace); }
.pg[hidden] { display: none; }
.pg-head { display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: baseline; justify-content: space-between; color: var(--ink-3, #6b6455); }
.pg-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; cursor: pointer; padding: 2px 0; }
.pg-row:hover { background: var(--paper-2, #faf9f6); }
.pg-name { font-weight: 700; min-width: 84px; color: var(--ink, #16140f); }
.pg-chip { padding: 1px 7px; border: 1px solid var(--ink-3, #6b6455); color: var(--ink-2, #4b463c); background: var(--paper, #fff); }
.pg-chip.ok { border-color: var(--ok, #0d6e3f); color: var(--ok, #0d6e3f); background: var(--ok-wash, rgba(17,128,74,.13)); }
.pg-chip.failed { border-color: var(--error, #c8231a); color: var(--error, #c8231a); background: var(--error-wash, rgba(200,35,26,.12)); }
.pg-chip.prev { animation: none; color: var(--ink-3, #6b6455); border-style: dotted; background: var(--paper, #fff); }
.pg-chip.notrun { border-style: dashed; color: var(--ink-3, #6b6455); }
.pg-chip.started { border-color: var(--signal, #ff4a17); color: var(--signal-ink, #c2330a); animation: pg-pulse 1.1s ease-in-out infinite; }
@keyframes pg-pulse { 50% { background: var(--signal-wash, rgba(255,74,23,.12)); } }
@media (prefers-reduced-motion: reduce) { .pg-chip.started { animation: none; } }
@media (pointer: coarse) { .pg-row { min-height: 44px; } }
`

export function mountProgress(host, opts = {}) {
	if (!document.getElementById("pg-css")) { const s = document.createElement("style"); s.id = "pg-css"; s.textContent = CSS; document.head.append(s) }
	const root = document.createElement("div")
	root.className = "pg"
	root.id = "progress"
	root.hidden = true
	host.append(root)
	const lines = []
	let st = progressState(lines), raf = 0, disposed = false
	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
	function draw() {
		raf = 0
		if (disposed) return
		st = progressState(lines)
		root.hidden = lines.length === 0
		const chipsOf = (steps) => STEPS.filter((k) => steps[k]).map((k) => {
			const x = steps[k], cls = x.status === "not run" ? "notrun" : esc(x.status)
			return `<span class="pg-chip ${cls}${x.prev ? " prev" : ""}" data-step="${k}" data-status="${esc(x.status)}"${x.prev ? " data-prev" : ""} title="${esc(x.detail ?? `${k}: ${x.status}`)}">${k}${x.status === "failed" ? " ✗" : x.status === "ok" ? " ✓" : ""}</span>`
		}).join("")
		const rows = Object.entries(st.boards).map(([name, b]) => `<div class="pg-row" data-board="${esc(name)}"><span class="pg-name">${esc(name)}</span>${chipsOf(b.steps)}</div>`).join("")
			+ (Object.keys(st.systemSteps).length ? `<div class="pg-row" data-system-row style="cursor:default"><span class="pg-name">system</span>${chipsOf(st.systemSteps)}</div>` : "")
		const sys = st.system.step ? `system: ${esc(st.system.step)} ${esc(st.system.status)}${st.system.detail ? ` · ${esc(st.system.detail)}` : ""}` : ""
		root.innerHTML = `<div class="pg-head"><span>Progress · round <b data-round>${st.round}</b></span><span data-system>${sys}</span></div>${rows}`
		opts.onChange?.(st)
	}
	const schedule = () => { if (!raf && !disposed) raf = requestAnimationFrame(draw) }
	root.addEventListener("click", (e) => {
		const row = e.target.closest?.("[data-board]")
		if (row) opts.onPick?.(row.dataset.board)
	})
	return {
		push(line) { lines.push(line); schedule() },
		state: () => st,
		dispose() { disposed = true; if (raf) cancelAnimationFrame(raf); root.remove() },
	}
}
