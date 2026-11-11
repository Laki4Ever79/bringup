/// <reference lib="dom" />
// The system page in a real browser (headless Chromium, as npm run perf finds it): what a person sees when a board
// opens over the 3D stage and closes again. Needs a recorded system run in out/ and Playwright's Chromium; skipped
// otherwise, with the reason.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
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
const exe = chromiumPath()
const skip = !SYSTEM ? "no recorded system run in out/" : !exe ? "no Playwright Chromium" : false

async function withPage(fn: (page: Page) => Promise<void>) {
	const hub = await serveHub({ outRoot: join(ROOT, "out"), port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		await page.goto(`${hub.url}/system?id=${SYSTEM}`)
		await page.waitForFunction(() => Boolean((window as unknown as { openBoard?: unknown }).openBoard) && document.querySelector("#stage canvas"), null, { timeout: 30_000 })
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
