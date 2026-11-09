// npm run perf: holds the viewer to its speed budget (spec §5) in a real, visible Chromium using this machine's GPU
// (headless Chromium draws WebGL in software and would mis-measure). Scripted pages only; no model is called.
// Chromium: PERF_CHROMIUM, else Playwright's own if installed, else the newest Chromium another Playwright already put in
// ~/.cache/ms-playwright (so no ~150 MB download is needed).
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, type Page } from "playwright"
import { serveHub } from "../src/dashboard/server.ts"

const ROOT = resolve(import.meta.dirname, "..")
const SYSTEM = "system-real-5" // a recorded real system run, when this machine has it
const BUDGET = { startDomMs: 1000, start3dMs: 2000, maxFrameMs: 33, p50FrameMs: 17.5, idleDraws: 0, boardPageMs: 2500 }

// The hub reads out/ (it resolves run folders inside its root, so a symlinked copy would be refused); it starts nothing.
const recorded = join(ROOT, "out", SYSTEM)
const hub = await serveHub({ outRoot: existsSync(recorded) ? join(ROOT, "out") : mkdtempSync(join(tmpdir(), "bringup-perf-")), port: 0 })
// Playwright's defaults let Chromium fall back to SwiftShader (software WebGL), which mis-measures by 10–20×; this
// laptop's AMD GPU is on Chromium's blocklist, so the list is ignored here and a software renderer stops the test.
function chromiumPath(): string | undefined {
	if (process.env.PERF_CHROMIUM) return process.env.PERF_CHROMIUM
	if (existsSync(chromium.executablePath())) return undefined
	const cache = join(homedir(), ".cache", "ms-playwright")
	const found = (existsSync(cache) ? readdirSync(cache) : []).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))).map((d) => join(cache, d, "chrome-linux64", "chrome")).find((p) => existsSync(p))
	if (!found) throw new Error("no Chromium: run `npx playwright install chromium`, or set PERF_CHROMIUM")
	return found
}
const browser = await chromium.launch({ headless: false, executablePath: chromiumPath(), args: ["--ignore-gpu-blocklist"], ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] })
const rows: [string, number, number, boolean][] = []
const check = (what: string, value: number, limit: number) => rows.push([what, Math.round(value * 10) / 10, limit, value <= limit])

// Frame times (ms) while `act` runs: one requestAnimationFrame chain in the page.
async function frames(page: Page, act: () => Promise<void>): Promise<number[]> {
	// Page code as strings: tsx wraps named functions in a helper the page doesn't have.
	await page.evaluate(`(() => {
		window.__ft = []; window.__on = true
		let last = performance.now()
		const tick = (t) => { window.__ft.push(t - last); last = t; if (window.__on) requestAnimationFrame(tick) }
		requestAnimationFrame(tick)
	})()`)
	await act()
	return page.evaluate(`(() => { window.__on = false; return window.__ft.slice(1) })()`)
}
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

try {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
	const renderer = (await page.evaluate(`(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl && gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "none" })()`)) as string
	console.log(`WebGL: ${renderer}`)
	if (/swiftshader|llvmpipe|software|^none$/i.test(renderer)) throw new Error("WebGL is drawing in software here; frame times would mean nothing")
	const t0 = Date.now()
	await page.goto(`${hub.url}/`)
	await page.waitForSelector("#sentence")
	check("start screen: text and prompt (ms)", Date.now() - t0, BUDGET.startDomMs)
	await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>("#stage canvas")?.style.opacity === "1")
	check("start screen: first 3D frame (ms)", Date.now() - t0, BUDGET.start3dMs)

	// Interaction is measured once the page has settled (its thumbnails and fonts load in the first second).
	await page.waitForTimeout(1000)
	const box = (await page.locator("#stage canvas").boundingBox())!
	const orbit = await frames(page, async () => {
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
		await page.mouse.down()
		for (let i = 0; i < 150; i++) await page.mouse.move(box.x + box.width / 2 + Math.sin(i / 10) * 300, box.y + box.height / 2 + Math.cos(i / 15) * 60)
		await page.mouse.up()
	})
	check("start screen: orbit, slowest frame (ms)", Math.max(...orbit), BUDGET.maxFrameMs)
	check("start screen: orbit, median frame (ms)", p50(orbit), BUDGET.p50FrameMs)

	const fly = await frames(page, async () => {
		for (let i = 0; i < 3; i++) {
			await page.click('.row.board[data-board="beacon"]')
			await page.waitForTimeout(700)
			await page.keyboard.press("Escape")
			await page.waitForTimeout(700)
		}
	})
	check("start screen: 3 zooms in and out, slowest frame (ms)", Math.max(...fly), BUDGET.maxFrameMs)

	// Idle: turntable off, nothing moving → the scene draws nothing.
	const idle: number = await page.evaluate(`(async () => {
		const w = window.__start.world
		w.setTurntable(false)
		await new Promise((r) => setTimeout(r, 500))
		const before = w.stats().draws
		await new Promise((r) => setTimeout(r, 3000))
		return w.stats().draws - before
	})()`)
	check("start screen: draws in 3 s idle", idle, BUDGET.idleDraws)

	if (existsSync(recorded)) {
		await page.goto(`${hub.url}/system?id=${SYSTEM}`)
		await page.waitForFunction(() => document.getElementById("live")?.textContent?.includes("2 of 2"), null, { timeout: 20_000 })
		await page.waitForTimeout(1500)
		// The fly in (until the "Opening…" panel shows), the board page load behind it, and the fly out, apart: the load
		// is a page load on the same thread, not an animation. Frames and marks are recorded in the page and cut there,
		// so a blocked thread can't smear one window into the next.
		await page.evaluate(`(() => {
			window.__ft = []; window.__m = []; window.__on = true
			let last = performance.now()
			const tick = (t) => { window.__ft.push([t - last, t]); last = t; if (window.__on) requestAnimationFrame(tick) }
			requestAnimationFrame(tick)
			const v = document.getElementById("board-view")
			new MutationObserver(() => window.__m.push([v.classList.contains("on") ? "on" : "off", performance.now()])).observe(v, { attributes: true, attributeFilter: ["class"] })
		})()`)
		const mark = (label: string) => page.evaluate(`window.__m.push(["${label}", performance.now()])`)
		const loads: number[] = []
		for (let i = 0; i < 3; i++) {
			const started = Date.now()
			await mark("open")
			await page.evaluate(`window.openBoard("beacon")`)
			await page.waitForFunction(() => [...document.querySelectorAll<HTMLIFrameElement>("#board-view iframe")].some((f) => f.style.display === "block" && f.style.opacity === "1"), null, { timeout: 10_000 })
			loads.push(Date.now() - started)
			// Someone reads the board page before going back; its own first load settles meanwhile.
			await page.waitForTimeout(2500)
			await page.keyboard.press("Escape")
			await page.waitForTimeout(900)
		}
		const rec = (await page.evaluate(`(() => { window.__on = false; return { ft: window.__ft, m: window.__m } })()`)) as { ft: [number, number][]; m: [string, number][] }
		const inWindow = (from: number, to: number) => rec.ft.filter(([, t]) => t > from && t <= to).map(([d]) => d)
		const flyIn: number[] = [], flyOut: number[] = []
		for (let k = 0; k < rec.m.length; k++) {
			const [label, t] = rec.m[k]
			const next = rec.m.slice(k + 1).find(([l]) => (label === "open" ? l === "on" : true))
			if (label === "open" && next) flyIn.push(...inWindow(t, next[1]))
			if (label === "off") flyOut.push(...inWindow(t, t + 550))
		}
		check("system page: fly into a board, slowest frame (ms)", Math.max(...flyIn), BUDGET.maxFrameMs)
		check("system page: board page shown after click, slowest of 3 (ms)", Math.max(...loads), BUDGET.boardPageMs)
		check("system page: fly back out, slowest frame (ms)", Math.max(...flyOut), BUDGET.maxFrameMs)
	} else console.log(`(no out/${SYSTEM} on this machine: the system page case is skipped)`)
} finally {
	await browser.close()
	await hub.close()
}

const w = Math.max(...rows.map((r) => r[0].length))
for (const [what, v, limit, ok] of rows) console.log(`${ok ? "ok  " : "MISS"}  ${what.padEnd(w)}  ${String(v).padStart(7)}  ≤ ${limit}`)
const misses = rows.filter((r) => !r[3]).length
console.log(misses ? `${misses} over budget` : "all within budget")
process.exit(misses ? 1 : 0)
