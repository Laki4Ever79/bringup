// The plan drawing, moved out of plan.html unchanged (Task 7): the board boxes at the plan's pixel layout, the cables
// between them, "+ board", a cable made by dragging a board's dot onto another (the picker asks UART or I²C), Delete,
// and the brief editor. Every edit shows at once and is saved 150 ms later, in order (plan-edit.js does the edits).
// plan.html and the design page before a build (system.html) both mount it; its styles are scoped to .plan-canvas.
import { addBoard, afterSave, connect, moveBoard, removeBoard, removeLink, setBrief } from "./plan-edit.js"

const STYLE = `
	.plan-canvas #draw { position: relative; height: 470px; border: 1px solid var(--line, #e6e3dc); border-radius: 14px; overflow: hidden; background: radial-gradient(circle, #e9e6df 1px, transparent 1px) 0 0 / 18px 18px; user-select: none; }
	.plan-canvas #draw svg { position: absolute; inset: 0; width: 100%; height: 100%; }
	.plan-canvas #draw .tools { position: absolute; right: 10px; top: 10px; display: flex; gap: 6px; z-index: 3; }
	.plan-canvas #draw .help { position: absolute; left: 12px; bottom: 9px; font-size: 12px; color: var(--ink-3); pointer-events: none; }
	.plan-canvas button { font: inherit; }
	.plan-canvas .btn { border: 1px solid var(--ink); background: #fff; border-radius: 8px; padding: 4px 11px; cursor: pointer; font-size: 13px; }
	.plan-canvas .btn:disabled { opacity: .4; cursor: default; }
	.plan-canvas .card { position: absolute; width: 178px; background: #fff; border: 2px solid var(--signal); border-radius: 10px; padding: 8px 10px; cursor: grab; box-shadow: 0 4px 14px rgba(0, 0, 0, .06); z-index: 2; }
	.plan-canvas .card.optional { border-style: dashed; }
	.plan-canvas .card.sel { box-shadow: 0 0 0 4px var(--wash, rgba(255, 74, 23, .1)), 0 4px 14px rgba(0, 0, 0, .08); }
	.plan-canvas .card.flash, .plan-canvas .lbl.flash { animation: plan-flash 1s ease-in-out 2; }
	@keyframes plan-flash { 50% { background: #ffe1d6; } }
	.plan-canvas .card b { display: block; }
	.plan-canvas .card span { font-size: 12px; color: var(--ink-3); }
	.plan-canvas .card .handle { position: absolute; right: -8px; top: 50%; width: 14px; height: 14px; margin-top: -7px; border-radius: 50%; background: var(--signal); border: 2px solid #fff; cursor: crosshair; }
	.plan-canvas .card .issue, .plan-canvas .lbl .issue { display: block; margin-top: 5px; font-size: 11.5px; color: #b42318; line-height: 1.3; }
	.plan-canvas .card.bad { border-color: #b42318; }
	.plan-canvas .bought { position: absolute; border: 1.5px solid #c8c4bb; border-radius: 8px; padding: 4px 9px; font-size: 12px; color: var(--ink-2); background: #fff; z-index: 1; }
	.plan-canvas .lbl { position: absolute; transform: translate(-50%, -50%); font-size: 11.5px; background: #fff; border: 1px solid var(--line, #e6e3dc); border-radius: 6px; padding: 1px 7px; cursor: pointer; z-index: 2; white-space: nowrap; }
	.plan-canvas .lbl.sel { border-color: var(--ink); }
	.plan-canvas .lbl.bad { border-color: #b42318; }
	.plan-canvas .lbl .issue { white-space: normal; width: 220px; }
	.plan-canvas #picker { position: absolute; z-index: 5; display: none; background: #fff; border: 1px solid var(--ink); border-radius: 8px; padding: 6px; gap: 6px; }
	.plan-canvas #picker.on { display: flex; }
	.plan-canvas #brief { position: fixed; right: 0; top: 0; bottom: 0; width: min(560px, 92vw); background: #fff; border-left: 1px solid var(--ink); padding: 18px; display: none; flex-direction: column; gap: 10px; z-index: 10; box-shadow: -10px 0 40px rgba(0, 0, 0, .08); }
	.plan-canvas #brief.on { display: flex; }
	.plan-canvas #brief textarea { flex: 1; font: 13px/1.5 "JBMono", monospace; border: 1px solid var(--line, #e6e3dc); border-radius: 8px; padding: 10px; resize: none; }
	.plan-canvas #brief .row { display: flex; gap: 8px; justify-content: flex-end; }
	.plan-canvas .primary { background: var(--ink); color: #fff; border-color: var(--ink); }
`
const HTML = `
	<div id="draw">
		<svg id="wires"></svg>
		<div class="tools"><button class="btn" id="add">+ board</button><button class="btn" id="del" disabled title="Delete the selected board or cable (Delete key)">Delete</button></div>
		<div id="picker"><span style="font-size:12px;align-self:center">Cable:</span><button class="btn" data-kind="uart">UART</button><button class="btn" data-kind="i2c">I²C</button><button class="btn" data-kind="">×</button></div>
		<div class="help">Drag a board to move it · drag its orange dot onto another board for a cable · click a board to read or edit its brief</div>
	</div>
	<div id="brief"><b id="brief-title"></b><textarea id="brief-text" spellcheck="false"></textarea><div class="row"><button class="btn" id="brief-cancel">Cancel</button><button class="btn primary" id="brief-save">Save brief</button></div></div>`

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
// A module's styles, once per page.
export function addStyle(key, css) {
	if (document.querySelector(`style[data-style="${key}"]`)) return
	const s = document.createElement("style")
	s.dataset.style = key
	s.textContent = css
	document.head.append(s)
}
const KIND_LABEL = { uart: "UART", i2c: "I²C", spi: "SPI", i2s: "I²S", espnow: "ESP-NOW", ble: "Bluetooth LE" }
const linkLabel = (l) => `${l.id} · ${KIND_LABEL[l.kind] ?? l.kind}${l.kind === "uart" ? ` · ${(l.baud ?? 115200) / 1000}k` : ""}${l.cable ? ` · ${l.cable.lengthMm / 10} cm` : ""}`

export function mountPlanCanvas(host, { id, view, onChange, onView, onMsg } = {}) {
	addStyle("plan-canvas", STYLE)
	const root = document.createElement("div")
	root.className = "plan-canvas"
	root.innerHTML = HTML
	host.append(root)
	const $ = (x) => root.querySelector(`#${x}`)
	const msg = (text, err = false) => onMsg?.(text, err)
	let plan = null, issues = [], selected = null, saveTimer = 0, saving = Promise.resolve(), disposed = false

	// A plan view from the hub (GET, a save's answer, a change): the drawing follows it.
	function apply(v) {
		plan = v.plan
		issues = v.issues ?? []
		draw()
	}
	async function reload() {
		const r = await fetch(`/api/plans/${encodeURIComponent(id)}`)
		if (!r.ok || disposed) return
		const v = await r.json()
		apply(v)
		onView?.(v)
	}

	// ── The drawing ──
	const cardW = 178
	const centre = (name) => { const el = root.querySelector(`.card[data-name="${CSS.escape(name)}"]`); const l = plan.layout[name] ?? { x: 40, y: 40 }; return { x: l.x + cardW / 2, y: l.y + (el?.offsetHeight ?? 60) / 2 } }
	const issuesFor = (t) => issues.filter((i) => (t.board && i.target.board === t.board) || (t.link && i.target.link === t.link))

	function draw() {
		const host = $("draw")
		for (const el of host.querySelectorAll(".card, .lbl, .bought")) el.remove()
		for (const b of plan.spec.boards) {
			const l = plan.layout[b.name] ?? { x: 40, y: 40 }
			const title = (plan.briefs[b.name] ?? "").split("\n").find((x) => x.trim())?.replace(/^#+\s*/, "").replace(/^Brief:\s*/i, "") ?? ""
			const bad = issuesFor({ board: b.name })
			const el = document.createElement("div")
			el.className = `card${plan.optional?.includes(b.name) ? " optional" : ""}${selected?.board === b.name ? " sel" : ""}${bad.length ? " bad" : ""}`
			el.dataset.name = b.name
			el.style.left = `${l.x}px`; el.style.top = `${l.y}px`
			el.innerHTML = `<b>${esc(b.name)}</b><span>${esc(title)}</span>${bad.map((i) => `<span class="issue">${esc(i.message)}</span>`).join("")}<i class="handle" title="Drag onto another board to connect them"></i>`
			host.append(el)
			dragCard(el, b.name)
		}
		for (const [i, o] of (plan.offBoard ?? []).entries()) {
			const at = plan.layout[o.attachesTo]
			if (!at) continue
			const el = document.createElement("div")
			el.className = "bought"
			el.textContent = o.name
			el.style.left = `${at.x + 10 + i * 6}px`; el.style.top = `${at.y + 110 + i * 30}px`
			el.title = `Bought part, attached to ${o.attachesTo}`
			host.append(el)
		}
		wires()
	}

	function wires() {
		const host = $("draw")
		for (const el of host.querySelectorAll(".lbl")) el.remove()
		const paths = []
		for (const l of plan.spec.links) {
			const a = centre(l.a.board), b = centre(l.b.board)
			const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 18
			paths.push(`<path d="M${a.x} ${a.y} Q${mx} ${my - 30} ${b.x} ${b.y}" stroke="#16140f" stroke-width="2" fill="none"/>`)
			const bad = issuesFor({ link: l.id })
			const el = document.createElement("div")
			el.className = `lbl${selected?.link === l.id ? " sel" : ""}${bad.length ? " bad" : ""}`
			el.dataset.link = l.id
			el.style.left = `${mx}px`; el.style.top = `${my}px`
			el.innerHTML = `${esc(linkLabel(l))}${bad.map((i) => `<span class="issue">${esc(i.message)}</span>`).join("")}`
			el.addEventListener("click", (e) => { e.stopPropagation(); select({ link: l.id }) })
			host.append(el)
		}
		$("wires").innerHTML = paths.join("")
	}

	function select(s) {
		selected = s
		$("del").disabled = !s
		for (const c of root.querySelectorAll(".card")) c.classList.toggle("sel", s?.board === c.dataset.name)
		for (const c of root.querySelectorAll(".lbl")) c.classList.toggle("sel", s?.link === c.dataset.link)
	}

	function dragCard(el, name) {
		el.addEventListener("pointerdown", (e) => {
			if (e.target.classList.contains("handle")) return startWire(e, name)
			e.preventDefault()
			const start = { x: e.clientX, y: e.clientY, l: { ...(plan.layout[name] ?? { x: 0, y: 0 }) } }
			let moved = false
			el.setPointerCapture(e.pointerId)
			const move = (ev) => {
				const dx = ev.clientX - start.x, dy = ev.clientY - start.y
				if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
				const box = $("draw").getBoundingClientRect()
				const x = Math.max(0, Math.min(box.width - cardW, start.l.x + dx)), y = Math.max(0, Math.min(box.height - el.offsetHeight, start.l.y + dy))
				plan.layout[name] = { x, y }
				el.style.left = `${x}px`; el.style.top = `${y}px`
				wires()
			}
			const up = () => {
				el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up)
				if (moved) edit(moveBoard(plan, name, plan.layout[name].x, plan.layout[name].y))
				else { select({ board: name }); openBrief(name) }
			}
			el.addEventListener("pointermove", move); el.addEventListener("pointerup", up)
		})
	}

	function startWire(e, from) {
		e.preventDefault(); e.stopPropagation()
		const box = $("draw").getBoundingClientRect()
		const a = centre(from)
		const temp = document.createElementNS("http://www.w3.org/2000/svg", "path")
		temp.setAttribute("stroke", "#ff4a17"); temp.setAttribute("stroke-width", "2"); temp.setAttribute("stroke-dasharray", "5 4"); temp.setAttribute("fill", "none")
		$("wires").append(temp)
		const move = (ev) => temp.setAttribute("d", `M${a.x} ${a.y} L${ev.clientX - box.left} ${ev.clientY - box.top}`)
		const up = (ev) => {
			removeEventListener("pointermove", move); removeEventListener("pointerup", up)
			temp.remove()
			const target = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el.classList?.contains("card"))?.dataset.name
			if (!target || target === from) return
			const p = $("picker")
			p.style.left = `${ev.clientX - box.left}px`; p.style.top = `${ev.clientY - box.top}px`
			p.classList.add("on")
			p.onclick = (ce) => {
				const kind = ce.target.dataset?.kind
				if (kind === undefined) return
				p.classList.remove("on")
				if (kind) edit(connect(plan, from, target, kind))
			}
		}
		addEventListener("pointermove", move); addEventListener("pointerup", up)
	}

	$("draw").addEventListener("pointerdown", (e) => { if (e.target === $("draw") || e.target.id === "wires") { select(null); $("picker").classList.remove("on") } })
	$("del").addEventListener("click", () => deleteSelected())
	const onKey = (e) => {
		if (e.target.closest?.("input, textarea")) return
		if (e.key === "Delete" || e.key === "Backspace") deleteSelected()
		if (e.key === "Escape") { select(null); closeBrief() }
	}
	addEventListener("keydown", onKey)
	function deleteSelected() {
		if (!selected) return
		edit(selected.board ? removeBoard(plan, selected.board) : removeLink(plan, selected.link))
		select(null)
	}
	$("add").addEventListener("click", () => {
		const p = addBoard(plan, "board", "# Brief: new board\n\n## What we want\nWhat this board does, where it sits.\n\n## Must have\n- \n")
		const name = p.spec.boards.at(-1).name
		edit(p)
		select({ board: name })
		openBrief(name)
	})

	// ── Brief editor ──
	let briefFor = null
	function openBrief(name) { briefFor = name; $("brief-title").textContent = `Brief: ${name}`; $("brief-text").value = plan.briefs[name] ?? ""; $("brief").classList.add("on") }
	function closeBrief() { briefFor = null; $("brief").classList.remove("on") }
	$("brief-cancel").addEventListener("click", closeBrief)
	$("brief-save").addEventListener("click", () => { if (briefFor) edit(setBrief(plan, briefFor, $("brief-text").value)); closeBrief() })

	// ── Saving: every edit shows at once, saved 150 ms later in order; a stale save reloads ──
	let edits = 0 // counts edits, so a save's answer can tell whether the screen changed while it was in flight
	function edit(next) {
		edits++
		plan = next
		draw()
		onChange?.(plan)
		clearTimeout(saveTimer)
		saveTimer = setTimeout(save, 150)
	}
	function save() {
		saving = saving.then(async () => {
			const sentAt = edits
			const r = await fetch(`/api/plans/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan }) })
			if (r.status === 409) { msg("Updated elsewhere; reloaded."); return reload() }
			if (!r.ok) return msg((await r.json().catch(() => ({}))).error ?? "Saving failed.", true)
			const v = await r.json()
			const merged = { ...v, plan: afterSave(plan, v.plan, edits !== sentAt) }
			apply(merged)
			onView?.(merged)
		})
	}
	// Before a change in words or a build: the pending edit is saved first (as plan.html always did, even with none).
	function flush() {
		clearTimeout(saveTimer)
		save()
		return saving
	}

	// The boards and cables a change in words added or changed blink twice.
	function flash(names) {
		for (const el of root.querySelectorAll(".card, .lbl")) if (names.has(el.dataset.name ?? el.dataset.link)) el.classList.add("flash")
	}

	function dispose() {
		disposed = true
		clearTimeout(saveTimer)
		removeEventListener("keydown", onKey)
		root.remove()
	}

	apply(view)
	return {
		apply,
		reload,
		flush,
		flash,
		dispose,
		get plan() { return plan },
	}
}
