// The one bar on every dashboard page (the page map, 11 Nov 2026): Home · Designs · Docs, the section you're in
// marked, a trail of where you are (each step a link back up), and inside a design its levels: Overview (the device)
// and, after a divider, its boards. Pages keep their own controls on a row under it.

const DOCS = "https://github.com/Laki4Ever79/bringup#readme"
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const here = (on) => (on ? ' aria-current="page"' : "")

// section: "home" | "designs" | "docs"; trail: [{label, href?}] (the last is where you are);
// levels: {overview: href, boards: [{name, href}], on: null (Overview) | board name}.
export function navHtml({ section, trail = [], levels = null }) {
	const places = [
		["home", "/", "Home"],
		["designs", "/designs", "Designs"],
	]
	const links = places.map(([k, href, label]) => `<a href="${href}"${here(section === k)}>${label}</a>`).join("") + `<a href="${DOCS}" target="_blank" rel="noopener">Docs</a>`
	const steps = trail.map((t, i) => (i < trail.length - 1 && t.href ? `<a href="${esc(t.href)}">${esc(t.label)}</a>` : i === trail.length - 1 ? `<b>${esc(t.label)}</b>` : esc(t.label))).join('<span class="nv-gt">›</span>')
	const top = `<div class="nv-top"><a class="nv-logo" href="/"><i></i>Bringup</a><nav class="nv-places">${links}</nav>${steps ? `<div class="nv-trail">${steps}</div>` : ""}</div>`
	if (!levels) return top
	const boards = levels.boards.map((b) => `<a href="${esc(b.href)}"${here(levels.on === b.name)} data-board="${esc(b.name)}">${esc(b.name)}</a>`).join("")
	const row = `<div class="nv-levels"><a href="${esc(levels.overview)}"${here(!levels.on)} data-board="">Overview</a><span class="nv-sep"></span><span class="nv-lbl">${levels.boards.length === 1 ? "Board" : "Boards"}</span>${boards}</div>`
	return top + row
}

const CSS = `
.nv { position: relative; z-index: 50; background: #fff; color: #111; font: 14px/1.3 "Instrument", "Instrument Sans", system-ui, sans-serif; border-bottom: 1.5px solid #111; }
.nv a { color: inherit; text-decoration: none; }
.nv-top { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 22px; min-height: 48px; padding: 6px max(16px, env(safe-area-inset-left, 0px)) 6px max(16px, env(safe-area-inset-left, 0px)); box-sizing: border-box; }
.nv-logo { display: flex; align-items: center; gap: 8px; font: 700 21px/1 "Shoulders", "Big Shoulders Display", "Arial Narrow", sans-serif; letter-spacing: .02em; text-transform: uppercase; }
.nv-logo i { width: 13px; height: 13px; background: #ff4a17; display: inline-block; }
.nv-places { display: flex; gap: 18px; flex-wrap: wrap; }
.nv-places a { color: #55555d; padding: 4px 0; border-bottom: 2px solid transparent; }
.nv-places a:hover { color: #111; }
.nv-places a[aria-current] { color: #111; font-weight: 600; border-color: #ff4a17; }
.nv-trail { margin-left: auto; color: #55555d; font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
.nv-trail a:hover { color: #111; text-decoration: underline; }
.nv-trail b { color: #111; font-weight: 600; }
.nv-gt { margin: 0 6px; color: #9a9aa2; }
.nv-levels { display: flex; align-items: flex-end; flex-wrap: wrap; padding: 0 max(16px, env(safe-area-inset-left, 0px)); border-top: 1px solid #e3e1da; background: #fbfaf7; }
.nv-levels a { padding: 9px 14px 8px; color: #55555d; border-bottom: 3px solid transparent; }
.nv-levels a:hover { color: #111; }
.nv-levels a[aria-current] { color: #111; font-weight: 600; border-color: #ff4a17; }
.nv-sep { width: 1px; align-self: stretch; background: #d6d4cc; margin: 7px 10px; }
.nv-lbl { font: 600 11px/1 "JBMono", "JetBrains Mono", ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; color: #8a8a92; padding: 0 4px 12px 0; }
.nv a:focus-visible { outline: 2px solid #ff4a17; outline-offset: 2px; }
`

// Puts the bar at the top of the page (once), or redraws it. Returns the element.
export function mountNav(opts) {
	if (!document.getElementById("nv-style")) {
		const s = document.createElement("style")
		s.id = "nv-style"
		s.textContent = CSS
		document.head.append(s)
	}
	let el = document.getElementById("site-nav")
	if (!el) {
		// A div, not a header: the pages style their own <header> rows, which would restyle the bar.
		el = document.createElement("div")
		el.setAttribute("role", "navigation")
		el.id = "site-nav"
		el.className = "nv"
		document.body.prepend(el)
	}
	el.innerHTML = navHtml(opts)
	return el
}
