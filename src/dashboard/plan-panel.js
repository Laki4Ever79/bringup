// The plan's side panel, moved out of plan.html unchanged (Task 7): Why split it this way, Can't build yet, Parts
// Bringup is learning (polled while a part is still being learned), Before you build (the estimate), Change the plan in
// words, and Build (confirm for real models, free with scripted agents, the hardware and review options). It works on
// the plan drawing (plan-canvas.js) it is given: a change or a build saves the drawing's pending edit first.
// plan.html and the design page before a build (system.html) both mount it; its styles are scoped to .plan-panel.
import { addStyle, esc } from "./plan-canvas.js"

const STYLE = `
	.plan-panel h4 { margin: 4px 0 7px; font: 600 11px/1 "Instrument", sans-serif; letter-spacing: .09em; color: var(--ink-3); text-transform: uppercase; }
	.plan-panel section { margin-bottom: 16px; }
	.plan-panel button { font: inherit; }
	.plan-panel .btn { border: 1px solid var(--ink); background: #fff; border-radius: 8px; padding: 4px 11px; cursor: pointer; font-size: 13px; }
	.plan-panel .btn:disabled { opacity: .4; cursor: default; }
	.plan-panel .primary { background: var(--ink); color: #fff; border-color: var(--ink); }
	.plan-panel .why { font-size: 13.5px; color: var(--ink-2); background: #faf9f6; border-radius: 9px; padding: 10px 12px; white-space: pre-line; }
	.plan-panel .est { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
	.plan-panel .est div { border: 1px solid var(--line, #e6e3dc); border-radius: 9px; padding: 8px 10px; }
	.plan-panel .est b { display: block; font-size: 18px; }
	.plan-panel .est span, .plan-panel .basis { font-size: 12px; color: var(--ink-3); }
	.plan-panel .cant { font-size: 13px; padding: 5px 0; border-bottom: 1px solid var(--line, #e6e3dc); }
	.plan-panel .cant span { color: var(--ink-3); }
	.plan-panel .learn { font-size: 13px; padding: 5px 0; border-bottom: 1px solid var(--line, #e6e3dc); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
	.plan-panel .learn b { font-weight: 600; }
	.plan-panel .learn .st { font: 600 11px var(--mono, ui-monospace, monospace); text-transform: uppercase; letter-spacing: .04em; }
	.plan-panel .learn .st.learning { color: var(--ink-3); } .plan-panel .learn .st.learned { color: #1d7a3e; } .plan-panel .learn .st.unavailable { color: #b3261e; }
	.plan-panel .learn .red { color: #b3261e; } .plan-panel .learn span.why { color: var(--ink-3); }
	.plan-panel .change { display: flex; gap: 6px; }
	.plan-panel .change input { flex: 1; border: 1.5px solid var(--ink); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 14px; }
	.plan-panel #go { display: block; width: 100%; background: var(--signal); color: #fff; border: 0; border-radius: 10px; padding: 11px; font-weight: 600; font-size: 16px; cursor: pointer; }
	.plan-panel #go:disabled, .plan-panel #free:disabled { opacity: .5; cursor: not-allowed; }
	.plan-panel #free { display: block; width: 100%; margin-top: 8px; border: 1px solid var(--line, #e6e3dc); background: #fff; border-radius: 10px; padding: 8px; font-size: 13.5px; color: var(--ink-2); cursor: pointer; }
	.plan-panel .opts { display: flex; gap: 14px; font-size: 12.5px; color: var(--ink-2); margin: 8px 0 0; }
	.plan-panel #confirm { display: none; margin-top: 8px; font-size: 13px; border: 1px solid var(--signal); border-radius: 9px; padding: 9px 10px; }
	.plan-panel #confirm.on { display: block; }
	.plan-panel #msg { font-size: 13px; min-height: 1.2em; margin-top: 6px; }
	.plan-panel #msg.err { color: #b42318; }
`
const HTML = `
	<section><h4>Why split it this way</h4><div class="why" id="why"></div></section>
	<section id="cant-sec" hidden><h4>Can't build yet</h4><div id="cant"></div></section>
	<section id="learn-sec" hidden><h4>Parts Bringup is learning</h4><div id="learn"></div></section>
	<section><h4>Before you build</h4>
		<div class="est"><div><b id="usd">–</b><span>model cost (estimate)</span></div><div><b id="min">–</b><span>build time (estimate)</span></div></div>
		<p class="basis" id="basis"></p>
	</section>
	<section><h4>Change the plan in words</h4>
		<form class="change" id="change"><input id="instruction" placeholder="e.g. remove the beacon" autocomplete="off"><button class="btn">Change</button></form>
		<label class="opts" style="margin-top:6px"><span><input type="checkbox" id="change-free" checked> scripted (free)</span></label>
	</section>
	<section>
		<button id="go">Build</button>
		<div id="confirm">Real models cost money (see the estimate); a board takes minutes, longer when the agents disagree. <button class="btn primary" id="go-yes">Build with real models</button> <button class="btn" id="go-no">Cancel</button></div>
		<button id="free">Try for free with scripted agents</button>
		<div class="opts"><label><input type="checkbox" id="hw" checked> Hardware tools</label><label><input type="checkbox" id="review" checked> Review</label></div>
		<p id="msg"></p>
	</section>`

// `canvas`: the plan drawing's handle (mountPlanCanvas). `onBuild(result)`: the build started ({systemId} or {runId}).
// `onView(v)`: every plan view the panel shows (the page's own lines: what was said, what planning spent).
export function mountPlanPanel(host, { id, view, canvas, onBuild, onView } = {}) {
	addStyle("plan-panel", STYLE)
	const root = document.createElement("aside")
	root.className = "plan-panel"
	root.innerHTML = HTML
	host.append(root)
	const $ = (x) => root.querySelector(`#${x}`)
	let plan = null, issues = [], disposed = false

	const msg = (text, err = false) => { $("msg").textContent = text; $("msg").className = err ? "err" : "" }

	// The part learner's progress (learning.json): one line per need; polled while any part is still being learned.
	let learnPoll = null
	function renderLearning(learning) {
		const needs = (canvas?.plan ?? plan).needs ?? []
		$("learn-sec").hidden = !needs.length
		$("learn").innerHTML = needs
			.map((n) => {
				const l = learning.find((x) => x.need === n.id) ?? { status: "learning" }
				const detail =
					l.status === "learned"
						? `<b>${esc(l.mpn)}</b>${l.reused ? " <span class=\"why\">(already in the catalog)</span>" : ""}${l.reds ? ` <span class="red">· ${l.reds} default value${l.reds === 1 ? "" : "s"}, not from a datasheet</span>` : ""}`
						: l.status === "unavailable"
							? `<span class="why">${esc((l.reasons ?? []).map((r) => (r.mpn ? `${r.mpn}: ${r.reason}` : r.reason)).join("; "))}</span>`
							: `<span class="why">${esc(n.requirements)}</span>`
				return `<div class="learn"><span class="st ${l.status}">${l.status === "learning" ? "learning…" : l.status}</span> ${esc(n.role)} ${detail}</div>`
			})
			.join("")
		const busy = needs.some((n) => (learning.find((x) => x.need === n.id)?.status ?? "learning") === "learning")
		if (busy && !learnPoll && !disposed)
			learnPoll = setInterval(async () => {
				const r = await fetch(`/api/plans/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null)
				if (r?.ok && !disposed) renderLearning((await r.json()).learning ?? [])
			}, 1500)
		if (!busy && learnPoll) {
			clearInterval(learnPoll)
			learnPoll = null
		}
	}

	function apply(v) {
		plan = v.plan
		issues = v.issues ?? []
		$("why").textContent = plan.why || "–"
		$("cant-sec").hidden = !plan.cantBuild?.length
		$("cant").innerHTML = (plan.cantBuild ?? []).map((c) => `<div class="cant">${esc(c.what)} <span>· ${esc(c.reason)}</span></div>`).join("")
		renderLearning(v.learning ?? [])
		if (v.estimate) {
			const e = v.estimate
			$("min").textContent = e.minutes ? (e.minutes[0] === e.minutes[1] ? `~${e.minutes[0]} min` : `${e.minutes[0]}–${e.minutes[1]} min`) : "unknown"
			$("usd").textContent = e.usd ? `$${e.usd[0].toFixed(2)}–${e.usd[1].toFixed(2)}` : "unknown"
			$("basis").textContent = e.basis
		}
		const n = plan.spec.boards.length
		$("go").textContent = `Build ${n} board${n === 1 ? "" : "s"}`
		$("go").disabled = $("free").disabled = issues.length > 0
		$("go").title = issues.length ? "Fix the problems marked on the drawing first" : ""
		onView?.(v)
	}
	// A view for the drawing and the panel together (a change in words, or a reload after one).
	const applyAll = (v) => { canvas?.apply(v); apply(v) }

	// ── Change in words ──
	$("change").addEventListener("submit", async (e) => {
		e.preventDefault()
		const instruction = $("instruction").value.trim()
		if (!instruction) return
		await canvas?.flush()
		msg($("change-free").checked ? "Changing (scripted)…" : "Changing with a real model: one call…")
		const r = await fetch(`/api/plans/${encodeURIComponent(id)}/change`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction, mock: $("change-free").checked, version: (canvas?.plan ?? plan).version }) })
		const v = await r.json()
		if (r.status === 409) { msg("The plan changed meanwhile; reloaded. Ask again if it still applies."); return canvas?.reload() }
		if (!r.ok) return msg(v.code === "NO_KEY" ? "No model key on this machine: keep “scripted (free)” ticked, or add a key to .env." : v.error ?? "The change failed.", true)
		$("instruction").value = ""
		applyAll(v)
		const d = v.diff
		msg([d.added.length && `added ${d.added.join(", ")}`, d.removed.length && `removed ${d.removed.join(", ")}`, d.changed.length && `changed ${d.changed.join(", ")}`].filter(Boolean).join("; ") || "Nothing changed.")
		canvas?.flash(new Set([...d.added, ...d.changed]))
	})

	// ── Build ──
	async function build(mock) {
		await canvas?.flush()
		$("go").disabled = $("free").disabled = true
		msg(mock ? "Starting the scripted build…" : "Starting the build…")
		const r = await fetch(`/api/plans/${encodeURIComponent(id)}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mock, hardware: $("hw").checked, review: $("review").checked }) })
		const v = await r.json()
		if (!r.ok) { $("go").disabled = $("free").disabled = false; return msg(v.code === "NO_KEY" ? "No model key on this machine: use “Try for free with scripted agents”, or add a key to .env." : v.error ?? "Build failed to start.", true) }
		onBuild?.(v)
	}
	$("go").addEventListener("click", () => $("confirm").classList.add("on"))
	$("go-no").addEventListener("click", () => $("confirm").classList.remove("on"))
	$("go-yes").addEventListener("click", () => { $("confirm").classList.remove("on"); build(false) })
	$("free").addEventListener("click", () => build(true))

	// A build already under way (the design page opened while it starts): Build stays off.
	function building(text) {
		$("go").disabled = $("free").disabled = true
		msg(text)
	}

	function dispose() {
		disposed = true
		if (learnPoll) clearInterval(learnPoll)
		learnPoll = null
		root.remove()
	}

	apply(view)
	return { apply, msg, building, dispose }
}
