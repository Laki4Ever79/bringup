/// <reference lib="dom" />
// The system page in a real browser (headless Chromium, as npm run perf finds it): what a person sees when a board
// opens over the 3D stage and closes again. Needs a recorded system run in out/ and Playwright's Chromium; skipped
// otherwise, with the reason.
import { test } from "node:test"
import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, type Page } from "playwright"
import { serveHub } from "../src/dashboard/server.ts"

const ROOT = resolve(import.meta.dirname, "..")
const SYSTEM = ["system-real-2", "system-real-5", "system-real-1"].find((s) => existsSync(join(ROOT, "out", s, "system.json")))
function chromiumPath(): string | null {
	if (existsSync(chromium.executablePath())) return chromium.executablePath()
	const cache = join(homedir(), ".cache", "ms-playwright")
	return (existsSync(cache) ? readdirSync(cache) : []).filter((d) => /^chromium-\d+$/.test(d)).map((d) => join(cache, d, "chrome-linux64", "chrome")).find((p) => existsSync(p)) ?? null
}
const ROBOT = existsSync(join(ROOT, "out", "robot-2", "system.json")) ? "robot-2" : undefined
const SINGLE = existsSync(join(ROOT, "out", "rover-fresh", "trace.jsonl")) ? "rover-fresh" : undefined
const exe = chromiumPath()
const skip = !SYSTEM ? "no recorded system run in out/" : !exe ? "no Playwright Chromium" : false

async function withPage(fn: (page: Page) => Promise<void>, system = SYSTEM, query = "") {
	const hub = await serveHub({ outRoot: join(ROOT, "out"), port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		await page.goto(`${hub.url}/system?id=${system}${query}`)
		await page.waitForFunction(() => Boolean((window as unknown as { openBoard?: unknown }).openBoard) && document.querySelector("#stage canvas, #stage-top svg"), null, { timeout: 30_000 })
		await fn(page)
	} finally {
		await browser.close()
		await hub.close()
	}
}

// The user saw a strip of the system page while a board was open: its header (with Report, Cable…) stayed above the
// board page, and its own scrollbar beside the board page's. Now (the page map, 11 Nov) the shared bar stays on top,
// with the design's levels marking the open board, and the board page fills everything under it.
test("an open board fills the window under the shared bar: no strip of the overview, no second scrollbar, the page behind locked", { skip, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.waitForSelector("[data-open]", { timeout: 30_000 })
		const board = await page.evaluate(() => (document.querySelector("[data-open]") as HTMLElement).dataset.open!)
		await page.evaluate((b) => (window as unknown as { openBoard: (n: string) => Promise<void> }).openBoard(b), board)
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 30_000 })
		const g = await page.evaluate(() => {
			const r = document.getElementById("board-view")!.getBoundingClientRect()
			const nav = document.getElementById("site-nav")!.getBoundingClientRect()
			const on = document.querySelector("#site-nav .nv-levels [aria-current]")?.textContent
			return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, navBottom: nav.bottom, on, w: innerWidth, h: innerHeight, scrolls: document.documentElement.scrollHeight > innerHeight && getComputedStyle(document.documentElement).overflowY !== "hidden" }
		})
		assert.equal(g.top, g.navBottom, `the board view starts at ${g.top}, the bar ends at ${g.navBottom}`)
		assert.equal(g.left, 0)
		assert.equal(g.bottom, g.h)
		assert.equal(g.right, g.w, "full width: no system scrollbar beside it")
		assert.equal(g.scrolls, false, "the system page behind can't scroll while a board is open")
		assert.equal(g.on, board, "the bar's levels mark the open board")
		// Closing gives the page its scrolling back, and the bar marks the Overview again.
		await page.keyboard.press("Escape")
		await page.waitForFunction(() => !document.getElementById("board-view")?.classList.contains("on"))
		assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), "hidden")
		await page.waitForFunction(() => document.querySelector("#site-nav .nv-levels [aria-current]")?.textContent === "Overview")
	})
})

test("the bar's board tabs switch boards in place, and Overview goes back to the 3D view", { skip, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.waitForSelector("#site-nav .nv-levels [data-board]:not([data-board=''])", { timeout: 30_000 })
		const tabs = await page.$$eval("#site-nav .nv-levels [data-board]:not([data-board=''])", (els) => els.map((e) => e.textContent))
		const start = new URL(page.url()).pathname
		for (const name of tabs) {
			await page.click(`#site-nav .nv-levels [data-board="${name}"]`)
			await page.waitForFunction((n) => document.getElementById("board-view")?.classList.contains("on") && document.querySelector("#site-nav .nv-levels [aria-current]")?.textContent === n, name, { timeout: 15_000 })
			assert.equal(new URL(page.url()).pathname, start, "stays on the design's page")
		}
		await page.click('#site-nav .nv-levels [data-board=""]')
		await page.waitForFunction(() => !document.getElementById("board-view")?.classList.contains("on"))
	})
})

// The camera flies to a board before its page opens, but the stage draws (and so flies) only while it is on screen:
// with the page scrolled down to the board cards, "Open board" waited for a fly that never ran.
test("a board opens from a scrolled-down page, where the 3D stage is out of view", { skip, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.waitForSelector("[data-open]", { timeout: 30_000 })
		const board = await page.evaluate(() => (document.querySelector("[data-open]") as HTMLElement).dataset.open!)
		await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
		await page.waitForFunction(() => document.getElementById("stage")!.getBoundingClientRect().bottom < 0)
		await page.evaluate((b) => void (window as unknown as { openBoard: (n: string) => Promise<void> }).openBoard(b), board)
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 3_000 })
	})
})

test("a board card's Open board opens the board over the system page, not as a new page", { skip, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.waitForSelector("[data-open]", { timeout: 30_000 })
		const start = page.url()
		await page.locator("[data-open]").last().click()
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 5_000 })
		assert.ok(new URL(page.url()).pathname === new URL(start).pathname, `navigated to ${page.url()}`)
	})
})

// At phone width the header wrapped inside a fixed 56 px: its rule ran through the title, its buttons were cut off.
test("at phone width the header grows to fit: nothing crosses its rule or leaves the screen", { skip, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await page.waitForTimeout(300)
		// Every header on the page (the shared bar and the design's own row), each against its own rule.
		const headers = await page.evaluate(() =>
			[...document.querySelectorAll("header, #site-nav")].map((h) => ({
				id: h.id,
				bottom: h.getBoundingClientRect().bottom,
				w: innerWidth,
				kids: [...h.children].filter((e) => getComputedStyle(e).display !== "none" && (e as HTMLElement).offsetWidth > 0).map((e) => ({ id: e.id || e.className || e.tagName, ...e.getBoundingClientRect().toJSON() })),
			})),
		)
		assert.ok(headers.length >= 2, "the shared bar and the design's own row")
		for (const r of headers)
			for (const k of r.kids) {
				assert.ok(k.bottom <= r.bottom + 0.5, `${r.id}: ${k.id} reaches ${k.bottom}, below the header's rule at ${r.bottom}`)
				assert.ok(k.right <= r.w + 0.5 && k.left >= -0.5, `${r.id}: ${k.id} spans ${k.left}–${k.right}, off a ${r.w} px screen`)
			}
	})
})

// The user, 11 Nov: the PCB view "is a bit on the smaller side, and it is the one that is perhaps the most interesting".
// The board page keeps everything (the status band, agents, timeline, case), and the PCB gets most of the window.
test("the board page gives the PCB most of the window: at least 3/4 of its height and 3/5 of its width", { skip, timeout: 120_000 }, async () => {
	const hub = await serveHub({ outRoot: join(ROOT, "out"), port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		await page.goto(`${hub.url}/?run=${SYSTEM}.logger&standalone=1`)
		await page.waitForSelector("#pcb-host", { timeout: 30_000 })
		await page.waitForTimeout(1500)
		const r = await page.evaluate(() => {
			const b = document.getElementById("stage-body")!.getBoundingClientRect()
			return { w: b.width, h: b.height, vw: innerWidth, vh: innerHeight, ripple: Boolean(document.getElementById("ripple")?.offsetHeight), agents: Boolean(document.getElementById("agents")?.offsetHeight), scene: Boolean(document.getElementById("scene-panel")?.offsetHeight) }
		})
		assert.ok(r.h >= 0.75 * r.vh, `the PCB view is ${Math.round(r.h)} px high in a ${r.vh} px window`)
		assert.ok(r.w >= 0.6 * r.vw, `the PCB view is ${Math.round(r.w)} px wide in a ${r.vw} px window`)
		assert.ok(r.ripple && r.agents && r.scene, "the status band, the agents and the case view are all still there")
	} finally {
		await browser.close()
		await hub.close()
	}
})

// pending-fixes: world3d's dispose() left its GL program and context behind; browsers cap live contexts (~16).
test("disposing a 3D world releases its GL context", { skip, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		const lost = await page.evaluate(async () => {
			// The page's own module (served by the hub), not a file TypeScript can resolve.
			const { mountWorld } = await import(String("/world3d.js"))
			const host = document.createElement("div")
			host.style.cssText = "width:300px;height:200px"
			document.body.append(host)
			const w = mountWorld(host, {})
			const gl = host.querySelector("canvas")!.getContext("webgl2")!
			w.dispose()
			return { lost: gl.isContextLost(), canvasGone: !host.querySelector("canvas") }
		})
		assert.deepEqual(lost, { lost: true, canvasGone: true })
	})
})

// The firmware viewer (user, 11 Nov): the board's firmware source, revision by revision, what changed since the one
// before; generated files marked.
test("the board page's Firmware tab lists the newest revision's files, marks the generated ones and shows what changed", { skip, timeout: 120_000 }, async () => {
	const hub = await serveHub({ outRoot: join(ROOT, "out"), port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		await page.goto(`${hub.url}/?run=${SYSTEM}.logger&standalone=1`)
		await page.click('#tabs [data-tab="firmware"]')
		await page.waitForSelector("#fw-files li", { timeout: 15_000 })
		const v = await page.evaluate(() => ({
			revs: [...document.querySelectorAll("#fw-rev option")].map((o) => (o as HTMLOptionElement).value),
			rev: (document.getElementById("fw-rev") as HTMLSelectElement).value,
			base: (document.getElementById("fw-base") as HTMLSelectElement).value,
			files: [...document.querySelectorAll("#fw-files li")].map((li) => ({ path: (li as HTMLElement).dataset.path, gen: Boolean(li.querySelector(".gen")), status: li.className.split(" ")[0] })),
			sum: document.getElementById("fw-sum")!.textContent,
		}))
		assert.ok(v.revs.length >= 2, `revisions: ${v.revs}`)
		assert.equal(v.rev, v.revs.at(-1), "opens on the newest revision")
		assert.equal(v.base, v.revs.at(-2), "compared with the one before")
		assert.ok(v.files.some((f) => f.path === "src/main.cpp" && !f.gen), "the template's main.cpp, not marked generated")
		assert.ok(v.files.some((f) => f.path === "include/pins.h" && f.gen), "pins.h, marked generated")
		assert.match(v.sum!, /since rev \d+/)
		// Whole file shows every line of the open file.
		await page.click('#fw-view .fw-mode [data-mode="whole"]')
		await page.waitForFunction(() => document.querySelectorAll("#fw-code tr").length > 5)
	} finally {
		await browser.close()
		await hub.close()
	}
})

// At phone width the boards-and-cables drawing shrank to unreadable text (an 880-wide drawing at 38 %): it keeps a
// readable size and scrolls sideways in its own box, never the page.
test("at phone width the boards-and-cables drawing stays readable and scrolls inside its box", { skip, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await page.waitForSelector("#topology svg", { timeout: 30_000 })
		const r = await page.evaluate(() => {
			const svg = document.querySelector("#topology svg")!.getBoundingClientRect()
			const box = document.querySelector("#topology .topo-scroll") as HTMLElement | null
			return { svgW: svg.width, scrolls: box ? box.scrollWidth > box.clientWidth : false, pageOver: document.documentElement.scrollWidth - innerWidth }
		})
		assert.ok(r.svgW >= 600, `the drawing is ${Math.round(r.svgW)} px wide`)
		assert.equal(r.scrolls, true, "it scrolls inside its own box")
		assert.ok(r.pageOver <= 0, `the page itself scrolls sideways by ${r.pageOver} px`)
	})
})

// ── 3D · Top: the same design page with a switch; the Top view zooms onto a board and opens its page in place ──
const SECOND: string = ROBOT ? JSON.parse(readFileSync(join(ROOT, "out", "robot-2", "system.json"), "utf8")).boards[1].name : ""
const skipRobot = !ROBOT ? "no recorded out/robot-2" : !exe ? "no Playwright Chromium" : false
const skipSingle = !SINGLE ? "no recorded out/rover-fresh" : !exe ? "no Playwright Chromium" : false
const topUp = (page: Page) => page.waitForFunction(() => document.querySelector("#stage-top svg [data-board]"), null, { timeout: 30_000 })
const boardBox = async (page: Page, name: string) => {
	const loc = page.locator(`#stage-top [data-board="${name}"] [data-outline]`)
	await loc.waitFor({ state: "visible", timeout: 10_000 })
	const box = await loc.boundingBox()
	assert.ok(box, `board ${name} drawn in Top`)
	return box
}
const clickBoard = async (page: Page, name: string) => {
	const box = await boardBox(page, name)
	await page.mouse.move(box.x + 3, box.y + 3)
	await page.mouse.down()
	await page.mouse.up()
}
const visible = (page: Page, sel: string) => page.evaluate((s) => { const e = document.querySelector(s) as HTMLElement | null; return Boolean(e && e.offsetWidth > 0 && getComputedStyle(e).display !== "none") }, sel)

test("the switch shows 3D by default and Top on click, and the URL keeps it", { skip: skipRobot, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		assert.equal(await visible(page, "#stage"), true)
		assert.equal(await visible(page, "#stage-top"), false)
		assert.equal(new URL(page.url()).searchParams.get("view"), null)
		await page.click('#view-switch [data-view="top"]')
		await topUp(page)
		assert.equal(await visible(page, "#stage"), false)
		assert.equal(await visible(page, "#stage-top"), true)
		assert.equal(new URL(page.url()).searchParams.get("view"), "top")
		await page.click('#view-switch [data-view="3d"]')
		assert.equal(await visible(page, "#stage"), true)
		assert.equal(new URL(page.url()).searchParams.get("view"), null)
	}, ROBOT)
})

test("clicking a board in Top zooms onto it and opens its page in place", { skip: skipRobot, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.click('#view-switch [data-view="top"]')
		await topUp(page)
		const name = await page.evaluate(() => (document.querySelector("#stage-top [data-board]") as HTMLElement).dataset.board!)
		await clickBoard(page, name)
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 15_000 })
		const u = new URL(page.url())
		assert.equal(u.searchParams.get("board"), name)
		assert.equal(u.searchParams.get("view"), "top", "the view stays in the URL")
		assert.equal(await page.evaluate(() => document.querySelector("#site-nav .nv-levels [aria-current]")?.textContent), name)
		assert.equal(await visible(page, "#back-system"), true)
	}, ROBOT)
})

test("← system and Esc zoom back out in Top", { skip: skipRobot, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.click('#view-switch [data-view="top"]')
		await topUp(page)
		const name = await page.evaluate(() => (document.querySelector("#stage-top [data-board]") as HTMLElement).dataset.board!)
		const vb = () => page.evaluate(() => document.querySelector("#stage-top svg")!.getAttribute("viewBox"))
		const home = await vb()
		for (const how of ["button", "esc"]) {
			await clickBoard(page, name)
			await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 15_000 })
			assert.notEqual(await vb(), home, "zoomed onto the board")
			if (how === "button") await page.click("#back-system")
			else await page.keyboard.press("Escape")
			await page.waitForFunction(() => !document.getElementById("board-view")?.classList.contains("on"))
			await page.waitForFunction((h) => document.querySelector("#stage-top svg")!.getAttribute("viewBox") === h, home, { timeout: 10_000 })
			const u = new URL(page.url())
			assert.equal(u.searchParams.get("board"), null)
			assert.equal(u.searchParams.get("view"), "top")
		}
	}, ROBOT)
})

test("a board deep link opens in Top view too", { skip: skipRobot, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 30_000 })
		assert.equal(await visible(page, "#stage-top"), true)
		assert.equal(await page.evaluate(() => document.querySelector("#site-nav .nv-levels [aria-current]")?.textContent), SECOND)
		await page.keyboard.press("Escape")
		await page.waitForFunction(() => !document.getElementById("board-view")?.classList.contains("on"))
		assert.equal(new URL(page.url()).searchParams.get("view"), "top")
	}, ROBOT, `&view=top&board=${SECOND}`)
})

test("a single-board design has the switch and opens its board from Top", { skip: skipSingle, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.click('#view-switch [data-view="top"]')
		await topUp(page)
		const name = await page.evaluate(() => (document.querySelector("#stage-top [data-board]") as HTMLElement).dataset.board!)
		await clickBoard(page, name)
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 15_000 })
		assert.equal(new URL(page.url()).searchParams.get("board"), name)
	}, SINGLE)
})

// Final review, Important 5: a one-board design in its own case (the logger) shows the case's outer footprint around
// the board in Top, from the run's enclosure spec (the board's outline plus clearance and walls on each side).
const LOGGER = existsSync(join(ROOT, "out", "logger-single", "trace.jsonl")) ? "logger-single" : undefined
test("a one-board logger's Top view draws its case outline around the board, and the board still opens", { skip: !LOGGER ? "no recorded out/logger-single" : !exe ? "no Playwright Chromium" : false, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await topUp(page)
		await page.waitForSelector("#stage-top [data-case]", { state: "attached", timeout: 30_000 })
		const name = await page.evaluate(() => (document.querySelector("#stage-top [data-board]") as HTMLElement).dataset.board!)
		const board = await boardBox(page, name)
		const kase = (await page.locator("#stage-top [data-case]").boundingBox())!
		assert.ok(kase.width > board.width && kase.height > board.height, `case ${kase.width}×${kase.height} px around board ${board.width}×${board.height} px`)
		assert.ok(kase.x < board.x && kase.y < board.y && kase.x + kase.width > board.x + board.width && kase.y + kase.height > board.y + board.height, "the case surrounds the board")
		// 50 × 30 mm board, 2 mm clearance and 2 mm walls: a 58 × 38 mm case.
		assert.ok(Math.abs(kase.width / board.width - 58 / 50) < 0.02, `width ratio ${kase.width / board.width}`)
		assert.ok(Math.abs(kase.height / board.height - 38 / 30) < 0.02, `height ratio ${kase.height / board.height}`)
		await clickBoard(page, name)
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 15_000 })
	}, LOGGER, "&view=top")
})

test("the timeline drives the Top view: scrubbing to the start shows boards as unbuilt boxes", { skip: skipRobot, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.click('#view-switch [data-view="top"]')
		await topUp(page)
		await page.waitForFunction(() => document.querySelector("#stage-top [data-part]"), null, { timeout: 30_000 })
		await page.evaluate(() => { const r = document.getElementById("scrub") as HTMLInputElement; r.value = "0"; r.dispatchEvent(new Event("input")) })
		await page.waitForFunction(() => !document.querySelector("#stage-top [data-part]") && document.querySelector("#stage-top [data-board]"), null, { timeout: 15_000 })
		// Every board at the start is its estimate box: dashed, marked unbuilt, the planned 40 × 30 mm (no outline yet).
		const boxes = () => page.$$eval("#stage-top [data-board]", (gs) => gs.map((g) => ({ built: (g as HTMLElement).dataset.built, dash: g.querySelector("[data-outline]")!.getAttribute("stroke-dasharray"), size: g.querySelectorAll("tspan")[1]?.textContent ?? null })))
		const start = await boxes()
		assert.ok(start.length >= 2)
		for (const b of start) assert.deepEqual(b, { built: "false", dash: "2 1.5", size: "40 × 30 mm" })
		// Live again: built, solid, the real outline.
		await page.evaluate(() => { const r = document.getElementById("scrub") as HTMLInputElement; r.value = "1000"; r.dispatchEvent(new Event("input")) })
		await page.waitForFunction(() => document.querySelector("#stage-top [data-part]"), null, { timeout: 15_000 })
		for (const b of await boxes()) assert.deepEqual({ built: b.built, dash: b.dash }, { built: "true", dash: null })
	}, ROBOT)
})

test("under view=top there is no 3D canvas until 3D is chosen, and a board opens with only Top", { skip: skipRobot, timeout: 120_000 }, async () => {
	const hub = await serveHub({ outRoot: join(ROOT, "out"), port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		await page.goto(`${hub.url}/system?id=${ROBOT}&view=top`)
		await topUp(page)
		await page.waitForSelector("#stage-top [data-board] [data-outline]", { state: "visible", timeout: 15_000 })
		assert.equal(await page.evaluate(() => document.querySelectorAll("#stage canvas").length), 0, "no WebGL canvas yet")
		const name = await page.evaluate(() => (document.querySelector("#stage-top [data-board]") as HTMLElement).dataset.board!)
		await clickBoard(page, name)
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 15_000 })
		await page.keyboard.press("Escape")
		await page.waitForFunction(() => !document.getElementById("board-view")?.classList.contains("on"))
		assert.equal(await page.evaluate(() => document.querySelectorAll("#stage canvas").length), 0)
		// Pressed inside the close flight: queued, and applied when the flight ends.
		await page.click('#view-switch [data-view="3d"]')
		await page.waitForSelector("#stage canvas", { state: "attached", timeout: 30_000 })
		assert.equal(await visible(page, "#stage-top"), false)
		assert.equal(await visible(page, "#stage"), true)
	} finally {
		await browser.close()
		await hub.close()
	}
})

test("the switch is ignored while a board opens, and open then close stay consistent; no file is fetched twice", { skip: skipRobot, timeout: 120_000 }, async () => {
	const hub = await serveHub({ outRoot: join(ROOT, "out"), port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		const seen: string[] = []
		page.on("request", (r) => { if (r.frame() === page.mainFrame() && r.url().includes("circuit.json")) seen.push(r.url()) })
		await page.goto(`${hub.url}/system?id=${ROBOT}`)
		await page.waitForSelector("#stage canvas", { timeout: 30_000 })
		await page.click('#view-switch [data-view="top"]')
		await topUp(page)
		const name = await page.evaluate(() => (document.querySelector("#stage-top [data-board]") as HTMLElement).dataset.board!)
		const vb = () => page.evaluate(() => document.querySelector("#stage-top svg")!.getAttribute("viewBox"))
		const home = await vb()
		await clickBoard(page, name)
		await page.click('#view-switch [data-view="3d"]', { force: true }).catch(() => {})
		await page.evaluate(() => (window as any).setView("3d"))
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 15_000 })
		assert.equal(await visible(page, "#stage-top"), true, "still in Top")
		await page.keyboard.press("Escape")
		await page.waitForFunction((h) => document.querySelector("#stage-top svg")!.getAttribute("viewBox") === h, home, { timeout: 10_000 })
		assert.equal(new URL(page.url()).searchParams.get("view"), "top")
		assert.equal(new Set(seen).size, seen.length, `circuit.json fetched twice: ${seen.join(" ")}`)
	} finally {
		await browser.close()
		await hub.close()
	}
})

test("a board reopened during the close flight keeps its view zoomed, and Esc then zooms it out", { skip: skipRobot, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.click('#view-switch [data-view="top"]')
		await topUp(page)
		await page.waitForSelector("#stage-top [data-board] [data-outline]", { state: "visible", timeout: 15_000 })
		const name = await page.evaluate(() => (document.querySelector("#stage-top [data-board]") as HTMLElement).dataset.board!)
		const vb = () => page.evaluate(() => document.querySelector("#stage-top svg")!.getAttribute("viewBox"))
		const home = await vb()
		await clickBoard(page, name)
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 15_000 })
		await page.keyboard.press("Escape")
		await page.waitForFunction(() => !document.getElementById("board-view")?.classList.contains("on"))
		await page.evaluate((n) => void (window as any).openBoard(n), name) // inside the close flight
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 15_000 })
		await page.keyboard.press("Escape")
		await page.waitForFunction((h) => !document.getElementById("board-view")?.classList.contains("on") && document.querySelector("#stage-top svg")!.getAttribute("viewBox") === h, home, { timeout: 10_000 })
	}, ROBOT)
})

test("hovering a board in either view shows its facts card; clicking a cable in Top shows the cable card; Esc and empty space close it", { skip: skipRobot, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		const card = () => page.evaluate(() => { const e = document.getElementById("facts")!; return { shown: e.offsetWidth > 0 && getComputedStyle(e).display !== "none", text: e.textContent ?? "" } })
		await page.click('#view-switch [data-view="top"]')
		await topUp(page)
		await page.waitForSelector("#stage-top [data-board] [data-outline]", { state: "visible", timeout: 15_000 })
		const name = await page.evaluate(() => (document.querySelector("#stage-top [data-board]") as HTMLElement).dataset.board!)
		const box = await boardBox(page, name)
		await page.mouse.move(box.x + 3, box.y + 3)
		await page.waitForFunction(() => document.getElementById("facts")!.offsetWidth > 0, null, { timeout: 5000 })
		let c = await card()
		assert.ok(c.text.includes(name), "the board's name")
		assert.match(c.text, /Size\d+(\.\d)? × \d+(\.\d)? mm|Size≈/, "its size")
		assert.match(c.text, /Chip/, "its chip row")
		assert.doesNotMatch(c.text, /undefined/)
		await page.mouse.move(2, 2)
		await page.waitForFunction(() => document.getElementById("facts")!.offsetWidth === 0)
		// A cable: click it, the card stays; Esc closes it and the board page stays shut.
		const cable = page.locator("#stage-top [data-cable]").first()
		await cable.waitFor({ state: "attached" })
		const cb = (await cable.boundingBox())!
		await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2)
		await page.mouse.down()
		await page.mouse.up()
		await page.waitForFunction(() => document.getElementById("facts")!.offsetWidth > 0)
		c = await card()
		assert.match(c.text, /Kind/)
		assert.match(c.text, /Length/)
		assert.equal(await page.evaluate(() => document.getElementById("board-view")!.classList.contains("on")), false)
		await page.keyboard.press("Escape")
		assert.equal((await card()).shown, false, "Esc closes the card")
		// Empty space closes a pinned card too.
		await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2)
		await page.mouse.down()
		await page.mouse.up()
		await page.waitForFunction(() => document.getElementById("facts")!.offsetWidth > 0)
		const stageBox = (await page.locator("#stage-top").boundingBox())!
		await page.mouse.click(stageBox.x + stageBox.width - 6, stageBox.y + stageBox.height - 6)
		assert.equal((await card()).shown, false, "a click on empty space closes it")
		// A board click in Top clears an open cable card.
		await page.click('#view-switch [data-view="3d"]')
		await page.click('#view-switch [data-view="top"]')
		await page.waitForSelector("#stage-top [data-cable]", { state: "attached" })
		const cb2 = (await page.locator("#stage-top [data-cable]").first().boundingBox())!
		await page.mouse.click(cb2.x + cb2.width / 2, cb2.y + cb2.height / 2)
		await page.waitForFunction(() => /Kind/.test(document.getElementById("facts")!.textContent ?? "") && document.getElementById("facts")!.offsetWidth > 0)
		await clickBoard(page, name)
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 15_000 })
		assert.equal((await card()).shown, false, "a board click clears the cable card")
		await page.keyboard.press("Escape")
		await page.waitForFunction(() => !document.getElementById("board-view")?.classList.contains("on"))
		assert.equal((await card()).shown, false, "the cable card stays closed after the board closes")
		// 3D, pressed inside the close flight: queued, not dropped. Then sweep the canvas until a board's card shows.
		await page.click('#view-switch [data-view="3d"]')
		await page.waitForSelector("#stage canvas", { state: "visible" })
		const sb = (await page.locator("#stage canvas").boundingBox())!
		let found = false
		for (let gy = 0.2; gy < 0.85 && !found; gy += 0.05) for (let gx = 0.15; gx < 0.9 && !found; gx += 0.05) {
			await page.mouse.move(sb.x + sb.width * gx, sb.y + sb.height * gy)
			found = (await card()).shown
		}
		assert.ok(found, "hovering a board in 3D shows the card")
		assert.match((await card()).text, /Size/)
		// 3D: a cable label opens the cable card.
		await page.mouse.move(2, 2)
		const label = page.locator("#stage [data-cable]").first()
		await label.waitFor({ state: "attached" })
		await label.click({ force: true })
		await page.waitForFunction(() => /Kind/.test(document.getElementById("facts")!.textContent ?? ""))
	}, ROBOT)
})

// ── Plan and design are one page (Task 7): before a build the design page has the plan's boxes, editing and side panel;
// Build turns it into the built design in place. Needs only Chromium: the plan is made in a fresh out/ by the scripted
// architect, and the build's launch is a stub that writes the plan's system.json.
const ROVER_SENTENCE = "a rover with a climate sensor on a separate board joined by a cable"
async function withPlanHub(fn: (h: { url: string; root: string; page: Page; id: string }) => Promise<void>, launch?: Parameters<typeof serveHub>[0]["launch"], sentence = ROVER_SENTENCE) {
	const root = mkdtempSync(join(tmpdir(), "bringup-plan-page-"))
	// A stub model key, so the real Build is offered (the launch is a stub: nothing calls a model).
	const hub = await serveHub({ outRoot: root, port: 0, launch, planEnv: { OPENAI_API_KEY: "test-key" } })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const r = await fetch(`${hub.url}/api/plans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sentence, mock: true }) })
		assert.equal(r.status, 201)
		const { id } = (await r.json()) as { id: string }
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		await fn({ url: hub.url, root, page, id })
	} finally {
		await browser.close()
		await hub.close()
		rmSync(root, { recursive: true, force: true })
	}
}
const skipChromium = !exe ? "no Playwright Chromium" : false

test("every section of today's plan page is on the design page before a build", { skip: skipChromium, timeout: 120_000 }, async () => {
	await withPlanHub(async ({ url, page, id }) => {
		await page.goto(`${url}/system?id=${id}`)
		await page.waitForSelector('#stage-top .card[data-name="main"]', { timeout: 30_000 })
		const seen = await page.evaluate(() => ({
			boards: [...document.querySelectorAll("#stage-top .card")].map((c) => (c as HTMLElement).dataset.name),
			add: document.querySelector("#stage-top #add")?.textContent,
			handles: document.querySelectorAll("#stage-top .card .handle").length,
			side: document.getElementById("plan-side")?.textContent ?? "",
			go: document.querySelector("#plan-side #go")?.textContent,
			goShown: (document.querySelector("#plan-side #go") as HTMLElement | null)?.offsetWidth ?? 0,
			three: (document.querySelector('#view-switch [data-view="3d"]') as HTMLElement).offsetWidth,
			top: document.querySelector('#view-switch [data-view="top"]')?.getAttribute("aria-pressed"),
			canvas: document.querySelector("#stage canvas") !== null,
		}))
		assert.deepEqual(seen.boards.sort(), ["climate", "main"], "each board box")
		assert.equal(seen.add, "+ board")
		assert.ok(seen.handles >= 2, "a dot to drag a cable from")
		for (const h of ["Why split it this way", "Can't build yet", "Parts Bringup is learning", "Before you build", "Change the plan in words"]) assert.ok(seen.side.includes(h), `the side panel has "${h}"`)
		// The sections this plan has are on screen (this plan has no can't-build lines and no parts to learn: those two
		// stay hidden here, and show in the next test).
		const shown = await page.evaluate(() => [...document.querySelectorAll("#plan-side h4")].filter((h) => (h as HTMLElement).offsetHeight > 0).map((h) => h.textContent))
		assert.deepEqual(shown, ["Why split it this way", "Before you build", "Change the plan in words"])
		// The panel stays beside the stage: it scrolls inside the stage's height, nothing hangs below it.
		const fit = await page.evaluate(() => ({ side: document.getElementById("plan-side")!.getBoundingClientRect().bottom, stage: document.getElementById("stage-top")!.getBoundingClientRect().bottom }))
		assert.ok(fit.side <= fit.stage + 1, `the side panel ends at ${fit.side}, the stage at ${fit.stage}`)
		assert.equal(seen.go, "Build 2 boards")
		assert.ok(seen.goShown > 0, "the Build button shows")
		assert.equal(seen.three, 0, "no 3D before a build")
		assert.equal(seen.top, "true", "Top is the shown view")
		assert.equal(seen.canvas, false, "no 3D canvas is made before a build")
		// Its editing works here: + board opens the brief editor, and saving it saves the plan.
		await page.click("#stage-top #add")
		await page.waitForSelector("#brief.on")
		await page.click("#brief-save")
		await page.waitForFunction(async (pid) => ((await (await fetch(`/api/plans/${pid}`)).json()).plan.spec.boards.length === 3), id, { timeout: 10_000, polling: 300 })
		await page.waitForFunction(() => document.querySelector("#plan-side #go")?.textContent === "Build 3 boards")
		// The old address lands on the same page.
		await page.goto(`${url}/plan/${id}`)
		assert.equal(new URL(page.url()).pathname, "/system")
		assert.equal(new URL(page.url()).searchParams.get("id"), id)
		await page.waitForSelector('#stage-top .card[data-name="main"]', { timeout: 30_000 })
	})
})

test("building from the design page turns it into the built design in place", { skip: skipChromium, timeout: 120_000 }, async () => {
	// A stub launch: the "system process" writes system.json a moment later and keeps running.
	const launch = (args: { outDir: string; extraArgs?: string[] }) => {
		setTimeout(() => copyFileSync(args.extraArgs![0], join(args.outDir, "system.json")), 1200)
		return { done: new Promise<{ code: number; stderr: string }>(() => {}), kill: () => {} }
	}
	await withPlanHub(async ({ url, page, id }) => {
		await page.goto(`${url}/system?id=${id}`)
		await page.waitForSelector("#plan-side #go", { timeout: 30_000 })
		await page.evaluate(() => ((window as unknown as { samePage: number }).samePage = 1))
		await page.click("#plan-side #go")
		await page.click("#plan-side #go-yes")
		await page.waitForFunction(() => {
			const three = document.querySelector('#view-switch [data-view="3d"]') as HTMLElement
			return three.offsetWidth > 0 && (document.getElementById("live")?.textContent ?? "") !== "" && document.querySelector("#stage canvas")
		}, null, { timeout: 30_000 })
		const after = await page.evaluate(() => ({
			same: (window as unknown as { samePage?: number }).samePage,
			cards: document.querySelectorAll("#stage-top .card").length,
			side: document.getElementById("plan-side")?.offsetWidth ?? 0,
			pressed: document.querySelector('#view-switch [data-view="3d"]')?.getAttribute("aria-pressed"),
			status: document.getElementById("status")?.textContent,
		}))
		assert.equal(after.same, 1, "no reload")
		assert.equal(new URL(page.url()).searchParams.get("id"), id, "the same address")
		assert.equal(after.cards, 0, "the plan's boxes leave")
		assert.equal(after.side, 0, "the plan's side panel leaves")
		assert.equal(after.pressed, "true", "3D is the default view once built")
		assert.notEqual(after.status, "plan")
		// Top is now the millimetre view.
		await page.click('#view-switch [data-view="top"]')
		await page.waitForSelector("#stage-top svg", { state: "visible" })
	}, launch)
})

// Final review, Important 3: a free try is its own design (<id>-free); the plan stays a plan, buildable for real.
test("Try for free opens its own design and leaves the plan buildable", { skip: skipChromium, timeout: 120_000 }, async () => {
	const outDirs: string[] = []
	const launch = (args: { outDir: string; extraArgs?: string[] }) => {
		outDirs.push(args.outDir)
		setTimeout(() => copyFileSync(args.extraArgs![0], join(args.outDir, "system.json")), 300)
		return { done: new Promise<{ code: number; stderr: string }>(() => {}), kill: () => {} }
	}
	await withPlanHub(async ({ url, root, page, id }) => {
		await page.goto(`${url}/system?id=${id}`)
		await page.waitForSelector("#plan-side #free", { timeout: 30_000 })
		await page.click("#plan-side #free")
		await page.waitForURL((u) => u.searchParams.get("id") === `${id}-free`, { timeout: 15_000 })
		assert.deepEqual(outDirs, [join(root, `${id}-free`)])
		await page.goto(`${url}/system?id=${id}`)
		await page.waitForSelector('#stage-top .card[data-name="main"]', { timeout: 30_000 })
		assert.equal(await page.isDisabled("#plan-side #go"), false, "the plan can still be built for real")
		assert.equal(await page.textContent("#status"), "plan")
	}, launch)
})

test("a plan's can't-build lines and the parts being learned show on the design page", { skip: skipChromium, timeout: 120_000 }, async () => {
	await withPlanHub(async ({ url, page, id }) => {
		await page.goto(`${url}/system?id=${id}`)
		await page.waitForSelector("#plan-side #cant-sec:not([hidden])", { timeout: 30_000 })
		assert.match((await page.textContent("#plan-side #cant")) ?? "", /a camera/)
		await page.waitForSelector("#plan-side #learn-sec:not([hidden])")
		// The scripted learner finishes: each need ends learned (the moved poll ran on this page).
		await page.waitForFunction(() => document.querySelectorAll("#plan-side .learn .st.learned").length === 2, null, { timeout: 30_000 })
		assert.match((await page.textContent("#plan-side #learn")) ?? "", /speaker[\s\S]*amplifier/)
	}, undefined, "a talking clock with a speaker and a camera")
})

test("a build that dies before writing the design gives the plan back: editable, buildable, no more polling", { skip: skipChromium, timeout: 120_000 }, async () => {
	let launches = 0
	const launch = () => { launches++; return { done: new Promise<{ code: number; stderr: string }>((r) => setTimeout(() => r({ code: 1, stderr: "boom" }), 300)), kill: () => {} } }
	await withPlanHub(async ({ url, page, id }) => {
		await page.goto(`${url}/system?id=${id}`)
		await page.waitForSelector("#plan-side #go", { timeout: 30_000 })
		await page.click("#plan-side #go")
		await page.click("#plan-side #go-yes")
		await page.waitForFunction(() => /did not start/.test(document.querySelector("#plan-side #msg")?.textContent ?? ""), null, { timeout: 15_000 })
		const st = await page.evaluate(() => ({ free: (document.querySelector("#plan-side #go") as HTMLButtonElement).disabled, building: document.getElementById("stage-wrap")!.classList.contains("building"), status: document.getElementById("status")!.textContent }))
		assert.deepEqual(st, { free: false, building: false, status: "plan" })
		// Polling stopped.
		let polls = 0
		page.on("request", (r) => { if (r.url().includes(`/api/systems/${id}`)) polls++ })
		await page.waitForTimeout(2500)
		assert.equal(polls, 0, "no more polling")
		// Editable again (a drag moves a board and is saved), and Build starts again.
		const box = (await page.locator('#stage-top .card[data-name="main"]').boundingBox())!
		await page.mouse.move(box.x + 30, box.y + 20)
		await page.mouse.down()
		await page.mouse.move(box.x + 30, box.y + 120, { steps: 5 })
		await page.mouse.up()
		await page.waitForFunction(async ([pid, y]) => ((await (await fetch(`/api/plans/${pid}`)).json()).plan.layout.main.y > y), [id, 150] as const, { timeout: 10_000, polling: 300 })
		await page.click("#plan-side #go")
		await page.click("#plan-side #go-yes")
		for (let i = 0; i < 50 && launches < 2; i++) await page.waitForTimeout(100)
		assert.equal(launches, 2, "Build started again")
		await page.waitForFunction(() => /did not start/.test(document.querySelector("#plan-side #msg")?.textContent ?? "") && !document.getElementById("stage-wrap")!.classList.contains("building"), null, { timeout: 15_000 })
		assert.equal(launches, 2)
	}, launch)
})

test("while a build starts the drawing takes no edits: the brief editor closes and Delete does nothing", { skip: skipChromium, timeout: 120_000 }, async () => {
	const launch = () => ({ done: new Promise<{ code: number; stderr: string }>(() => {}), kill: () => {} })
	await withPlanHub(async ({ url, page, id }) => {
		await page.goto(`${url}/system?id=${id}`)
		await page.waitForSelector('#stage-top .card[data-name="main"]', { timeout: 30_000 })
		await page.click('#stage-top .card[data-name="main"]')
		await page.waitForSelector("#brief.on")
		await page.evaluate(() => { (document.querySelector("#plan-side #go") as HTMLElement).click(); (document.querySelector("#plan-side #go-yes") as HTMLElement).click() })
		await page.waitForFunction(() => document.getElementById("stage-wrap")!.classList.contains("building"))
		await page.waitForFunction(() => !document.querySelector("#brief")!.classList.contains("on"))
		await page.keyboard.press("Delete")
		await page.waitForTimeout(500)
		assert.equal(await page.locator("#stage-top .card").count(), 2)
		assert.equal((await (await fetch(`${url}/api/plans/${id}`)).json() as { plan: { spec: { boards: unknown[] } } }).plan.spec.boards.length, 2)
	}, launch)
})

test("a stale save whose reload fails says so and stops saving", { skip: skipChromium, timeout: 120_000 }, async () => {
	await withPlanHub(async ({ url, page, id }) => {
		await page.goto(`${url}/system?id=${id}`)
		await page.waitForSelector('#stage-top .card[data-name="main"]', { timeout: 30_000 })
		// The plan moves on elsewhere, and the plan can't be read again.
		const { plan } = (await (await fetch(`${url}/api/plans/${id}`)).json()) as { plan: { layout: Record<string, unknown> } }
		assert.equal((await fetch(`${url}/api/plans/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: { ...plan, layout: { ...plan.layout, main: { x: 5, y: 5 } } } }) })).status, 200)
		await page.route(`**/api/plans/${id}`, (r) => (r.request().method() === "GET" ? r.fulfill({ status: 500, body: "{}" }) : r.continue()))
		let puts = 0
		page.on("request", (r) => { if (r.method() === "PUT") puts++ })
		await page.click("#stage-top #add")
		await page.click("#brief-save")
		await page.waitForFunction(() => /Couldn't reload the plan; refresh the page/.test(document.querySelector("#plan-side #msg")?.textContent ?? ""), null, { timeout: 10_000 })
		const before = puts
		await page.click("#stage-top #add")
		await page.click("#brief-save")
		await page.waitForTimeout(800)
		assert.equal(puts, before, "no save after the failed reload")
	})
})

// Today's design overview must survive the Top view: every section is there in both views, and the run links still work.
test("every section of today's design overview is still there in both views", { skip: skipRobot, timeout: 120_000 }, async () => {
	const boards: string[] = JSON.parse(readFileSync(join(ROOT, "out", "robot-2", "system.json"), "utf8")).boards.map((b: { name: string }) => b.name)
	await withPage(async (page) => {
		const sections = async (view: string) => {
			for (const sel of ["#timeline", "#topology", "[data-open]"]) assert.equal(await visible(page, sel), true, `${sel} in ${view}`)
			const pills = await page.$$eval("#file-links a.pill", (els) => els.map((e) => e.textContent))
			for (const n of ["Report", "Cable", "WireViz", "Bench test"]) assert.ok(pills.includes(n), `${n} pill in ${view}: ${pills.join(",")}`)
			const cards = await page.$$eval(".board .name", (els) => els.map((e) => e.textContent))
			for (const b of boards) assert.ok(cards.includes(b), `board card ${b} in ${view}`)
			const opens = await page.$$eval("[data-open]", (els) => els.map((e) => (e as HTMLElement).dataset.open))
			for (const b of boards) assert.ok(opens.includes(b), `[data-open=${b}] in ${view}`)
		}
		await sections("3D")
		await page.click('#view-switch [data-view="top"]')
		await topUp(page)
		await sections("Top")
	}, ROBOT)
	const hub = await serveHub({ outRoot: join(ROOT, "out"), port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		await page.goto(`${hub.url}/?run=robot-2.${SECOND}`)
		await page.waitForURL(new RegExp(`/system\\?id=robot-2&board=${SECOND}`), { timeout: 30_000 })
		await page.waitForFunction(() => document.getElementById("board-view")?.classList.contains("on"), null, { timeout: 30_000 })
		await page.goto(`${hub.url}/?run=robot-2.${SECOND}&standalone=1`)
		await page.waitForSelector("#pcb-host", { timeout: 30_000 })
		assert.equal(new URL(page.url()).pathname, "/", "the plain board page, not redirected")
		// The plain board page: its own trail ending at this board's run and its brief as the title, no design levels.
		await page.waitForFunction(() => Boolean(document.querySelector("#site-nav .nv-trail b")) && /^Bringup · ./.test(document.title) && document.title !== "Bringup · new design", null, { timeout: 30_000 })
		assert.equal(await page.locator("#site-nav .nv-levels").count(), 0, "no design levels on the plain board page")
		assert.equal(await page.locator("#site-nav .nv-trail b").textContent(), `robot-2.${SECOND}`, "the trail names this board's run")
	} finally {
		await browser.close()
		await hub.close()
	}
})
