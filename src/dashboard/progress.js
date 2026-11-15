// Live progress of a system run (the lines of <out>/system-trace.jsonl, streamed by GET /api/systems/:id/stream):
// progressState folds them into where every board is; mountProgress draws that as a strip of chips under the stage.
// Nothing here runs between lines: the strip redraws once per animation frame after a line arrives.
export const STEPS = ["contract", "board", "case", "chassis", "firmware", "boot", "drive", "testkit", "link", "assembly", "request", "settled"]

// The last line per board (and per step), the highest round seen, and the system's own last line.
export function progressState(lines) {
	const state = { round: 0, boards: {}, system: { step: null, status: null } }
	for (const l of lines) {
		if (typeof l?.round === "number" && l.round > state.round) state.round = l.round
		const one = { status: l.status, ...(l.detail ? { detail: l.detail } : {}), ...(l.revision != null && !Number.isNaN(l.revision) ? { revision: l.revision } : {}) }
		if (l.board === "system") { state.system = { step: l.step, status: l.status, ...(l.detail ? { detail: l.detail } : {}) }; continue }
		const b = (state.boards[l.board] ??= { step: l.step, status: l.status, steps: {} })
		b.step = l.step; b.status = l.status; b.detail = l.detail; b.revision = l.revision
		if (l.detail === undefined) delete b.detail
		if (l.revision === undefined) delete b.revision
		// A new request starts the board over: the chips of the last round are history now.
		if (l.step === "request" && l.status === "started") b.steps = {}
		b.steps[l.step] = one
	}
	return state
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
.pg-head { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; color: var(--ink-3, #807865); }
.pg-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; cursor: pointer; padding: 2px 0; }
.pg-row:hover { background: var(--paper-2, #faf9f6); }
.pg-name { font-weight: 700; min-width: 84px; color: var(--ink, #16140f); }
.pg-chip { padding: 1px 7px; border: 1px solid var(--ink-3, #807865); color: var(--ink-2, #4b463c); background: var(--paper, #fff); }
.pg-chip.ok { border-color: var(--ok, #11804a); color: var(--ok, #11804a); background: var(--ok-wash, rgba(17,128,74,.13)); }
.pg-chip.failed { border-color: var(--error, #c8231a); color: var(--error, #c8231a); background: var(--error-wash, rgba(200,35,26,.12)); }
.pg-chip.notrun { border-style: dashed; color: var(--ink-3, #807865); }
.pg-chip.started { border-color: var(--signal, #ff4a17); color: var(--signal, #ff4a17); animation: pg-pulse 1.1s ease-in-out infinite; }
@keyframes pg-pulse { 50% { background: var(--signal-wash, rgba(255,74,23,.12)); } }
@media (prefers-reduced-motion: reduce) { .pg-chip.started { animation: none; } }
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
		const rows = Object.entries(st.boards).map(([name, b]) => {
			const chips = STEPS.filter((s) => b.steps[s]).map((s) => {
				const x = b.steps[s], cls = x.status === "not run" ? "notrun" : x.status
				return `<span class="pg-chip ${cls}" data-step="${s}" data-status="${x.status}" title="${esc(x.detail ?? `${s}: ${x.status}`)}">${s}${x.status === "failed" ? " ✗" : x.status === "ok" ? " ✓" : ""}</span>`
			}).join("")
			return `<div class="pg-row" data-board="${esc(name)}"><span class="pg-name">${esc(name)}</span>${chips}</div>`
		}).join("")
		const sys = st.system.step ? `system: ${st.system.step} ${st.system.status}${st.system.detail ? ` · ${esc(st.system.detail)}` : ""}` : ""
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
