// Layout audit of the dashboard's pages at phone to wide-screen widths (after bringup-studio/out/audit.mts):
// for each page and width, a screenshot and the elements that are covered, clipped, off-screen or (on touch) under
// 44 px, in every frame, plus any request that failed. Needs a running hub: npx tsx src/dashboard/cli.ts
//
//   npx tsx scripts/ui-audit.mts <hub-url> <out-dir> [page-label-filter] [widths, e.g. 320,1440] [label=path,label=path]
// (the last: other pages than the built-in list, e.g. preview=/preview on a hub opened on one run)
import { chromium, type Page } from "playwright"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const [BASE, OUT, FILTER = "", WIDTHS = "", EXTRA = ""] = process.argv.slice(2)
if (!BASE || !OUT) throw new Error("usage: ui-audit.mts <hub-url> <out-dir> [filter] [widths]")
mkdirSync(OUT, { recursive: true })

const CHECK = (touch: boolean) => {
	const vis = (e: Element) => {
		const s = getComputedStyle(e)
		const r = e.getBoundingClientRect()
		if (!(r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none")) return false
		// Inside a closed <details> (its summary aside) is not on screen.
		const d = e.closest("details:not([open])")
		if (d && !e.closest("summary")) return false
		// Faded out with an ancestor (an overlay at opacity 0) counts as hidden.
		for (let a: Element | null = e; a; a = a.parentElement) if (+getComputedStyle(a).opacity <= 0.05) return false
		return true
	}
	const name = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} "${(e.textContent || (e as HTMLInputElement).placeholder || (e as HTMLElement).title || "").trim().replace(/\s+/g, " ").slice(0, 40)}"`
	const hasText = (e: Element) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())
	const targets = [...document.querySelectorAll("body *")].filter((e) => vis(e) && !e.closest("svg,canvas") && (hasText(e) || /^(BUTTON|A|INPUT|SELECT|TEXTAREA|IMG|SUMMARY)$/.test(e.tagName)))
	const out: string[] = []
	const W = innerWidth
	const H = innerHeight
	// Hidden inside a scroller that clips it (a horizontally scrolling tab strip): not a layout fault.
	const inScroller = (e: Element) => {
		for (let p = e.parentElement; p; p = p.parentElement) {
			const s = getComputedStyle(p)
			if (/auto|scroll/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return true
		}
		return false
	}
	for (const e of targets) {
		const r = e.getBoundingClientRect()
		// A label drawn over a canvas that lets clicks through (pointer-events: none) is meant to sit on it.
		if (r.bottom > 0 && r.top < H && r.right > 0 && r.left < W && getComputedStyle(e).pointerEvents !== "none") {
			let bad = 0
			let by: Element | null = null
			for (const fx of [0.2, 0.5, 0.8]) {
				const x = r.left + r.width * fx
				const y = r.top + r.height / 2
				if (x < 0 || x >= W || y < 0 || y >= H) continue
				const t = document.elementFromPoint(x, y)
				if (t && t !== e && !e.contains(t) && !t.contains(e) && !(t.tagName === "LABEL" && t.contains(e))) {
					bad++
					by = t
				}
			}
			// Under the open board's page (the system page's board overlay) is where the overview is meant to be.
			if (bad >= 2 && by && !inScroller(e) && !(by.tagName === "IFRAME" && by.closest("#board-view"))) out.push(`COVERED ${name(e)} by ${name(by)} @${Math.round(r.left)},${Math.round(r.top)}`)
		}
		const s = getComputedStyle(e)
		if (hasText(e) && s.textOverflow !== "ellipsis" && (e.scrollWidth > e.clientWidth + 2 || e.scrollHeight > e.clientHeight + 4) && /hidden|clip/.test(s.overflow + s.overflowX + s.overflowY) && e.clientWidth > 0)
			out.push(`CLIPPED ${name(e)} ${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight}`)
		if (r.right > W + 1 && r.left < W && s.position !== "fixed" && !inScroller(e)) out.push(`OFFSCREEN ${name(e)} right=${Math.round(r.right)} > ${W}`)
		// Touch targets: controls under 44 px on a touch screen; a link inside running text is exempt (WCAG 2.5.8).
		if (touch && /^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(e.tagName) && !(e as HTMLInputElement).disabled && (e as HTMLInputElement).type !== "hidden") {
			const inline = e.tagName === "A" && e.parentElement && [...e.parentElement.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim().length > 2)
			const box = e.tagName === "INPUT" && /checkbox|radio/.test((e as HTMLInputElement).type) ? (e.closest("label") ?? e).getBoundingClientRect() : r
			if (!inline && (box.height < 43.5 || box.width < 43.5)) out.push(`SMALL-TARGET ${name(e)} ${Math.round(box.width)}x${Math.round(box.height)}`)
		}
	}
	if (document.documentElement.scrollWidth > W + 1) out.push(`PAGE-HSCROLL ${document.documentElement.scrollWidth} > ${W}`)
	return [...new Set(out)]
}

async function audit(p: Page, label: string, touch: boolean) {
	await p.waitForTimeout(1500)
	const lines: string[] = []
	for (const f of p.frames()) {
		// The board run page inside the system page is the lead's (page.html); only its frame's own faults are skipped.
		if (f !== p.mainFrame() && f.url().includes("embed=1")) continue
		await f.evaluate("window.__name = (f) => f").catch(() => {})
		const r = await f.evaluate(CHECK, touch).catch((e: Error) => [`(frame error ${e.message.slice(0, 80)})`])
		if (r.length) lines.push(`  [frame ${f.url().replace(BASE, "")}]`, ...r.map((s) => "    " + s))
	}
	// The rendered page as static HTML (scripts out, addresses against the hub): for scanners that wait for the network
	// to go quiet, which a page with a live event stream never does.
	if (process.env.UI_AUDIT_SNAPSHOT) {
		const html = await p.evaluate((base) => {
			const d = document.documentElement.cloneNode(true) as HTMLElement
			for (const s of d.querySelectorAll("script, iframe")) s.remove()
			const b = document.createElement("base")
			b.href = base
			d.querySelector("head")?.prepend(b)
			return "<!doctype html>" + d.outerHTML
		}, BASE + "/").catch(() => null)
		if (html) writeFileSync(`${OUT}/${label}.html`, html)
	}
	await p.screenshot({ path: `${OUT}/${label}.png`, timeout: 20000, fullPage: true }).catch(() => lines.push("  (screenshot timed out)"))
	return `== ${label}\n${lines.join("\n") || "  ok"}`
}

const SINGLE = "20261120-235130"
const MULTI = "system-20261120-223755"
const PAGES: [string, string, number?][] = EXTRA ? EXTRA.split(",").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1), 4000] as [string, string, number]) : [
	["home", "/"],
	["designs", "/designs"],
	["docs", "/docs"],
	["docs-page", "/docs/system"],
	["stage", "/stage"],
	["system-list", "/system"],
	["plan-missing", "/plan/plan-00000000000000-000000"],
	["board", `/board?run=${SINGLE}`],
	["single-overview", `/system?id=${SINGLE}`],
	["single-top", `/system?id=${SINGLE}&view=top`],
	["multi-overview", `/system?id=${MULTI}`],
	["multi-top", `/system?id=${MULTI}&view=top`],
	["multi-board", `/system?id=${MULTI}&board=main`, 4000],
]
const SIZES: [number, number][] = [[320, 640], [390, 844], [768, 1024], [1024, 768], [1440, 900], [2560, 1440]]
const widths = WIDTHS ? WIDTHS.split(",").map(Number) : SIZES.map(([w]) => w)

function chromiumPath(): string | undefined {
	if (existsSync(chromium.executablePath())) return chromium.executablePath()
	const cache = join(homedir(), ".cache", "ms-playwright")
	return (existsSync(cache) ? readdirSync(cache) : []).filter((d) => /^chromium-\d+$/.test(d)).map((d) => join(cache, d, "chrome-linux64", "chrome")).find((p) => existsSync(p))
}
const b = await chromium.launch({ executablePath: chromiumPath(), args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] })
const report: string[] = []
const errors: string[] = []
for (const [w, h] of SIZES.filter(([w]) => widths.includes(w))) {
	const touch = w <= 1024
	const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: w <= 390, deviceScaleFactor: 1 })
	const p = await ctx.newPage()
	p.on("pageerror", (e) => errors.push(`${w} pageerror ${p.url().replace(BASE, "")}: ${e.message.slice(0, 160)}`))
	p.on("response", (r) => {
		if (r.status() >= 400) errors.push(`${w} http ${r.status()} ${r.url().replace(BASE, "")} (on ${p.url().replace(BASE, "")})`)
	})
	for (const [label, path, wait] of PAGES.filter(([l]) => l.includes(FILTER))) {
		await p.goto(BASE + path, { waitUntil: "load" }).catch(() => {})
		if (wait) await p.waitForTimeout(wait)
		report.push(await audit(p, `${w}-${label}`, touch))
	}
	await ctx.close()
}
await b.close()
writeFileSync(`${OUT}/report.txt`, report.join("\n") + "\n\nERRORS\n" + [...new Set(errors)].join("\n") + "\n")
console.log(`${report.length} states; report at ${OUT}/report.txt`)
