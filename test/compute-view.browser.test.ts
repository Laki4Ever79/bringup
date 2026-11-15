/// <reference lib="dom" />
// A bought board on the design page, in headless Chromium: the Top view draws the Raspberry Pi 5 dark, from its record's
// outline, holes and header, labelled "bought", raised over its carrier; the 3D view stands it on the carrier; its facts
// card says where it comes from, its peak with the source and its bridge device. Fed a hand-made system
// (test/fixtures/compute-pi), no recorded run. Skipped without Playwright's Chromium.
import { test } from "node:test"
import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, type Page } from "playwright"
import { serveHub } from "../src/dashboard/server.ts"
import { tempDir } from "./helpers.ts"

const ROOT = resolve(import.meta.dirname, "..")
function chromiumPath(): string | null {
	if (existsSync(chromium.executablePath())) return chromium.executablePath()
	const cache = join(homedir(), ".cache", "ms-playwright")
	return (existsSync(cache) ? readdirSync(cache) : []).filter((d) => /^chromium-\d+$/.test(d)).map((d) => join(cache, d, "chrome-linux64", "chrome")).find((p) => existsSync(p)) ?? null
}
const exe = chromiumPath()
const skip = !exe ? "no Playwright Chromium" : false

async function withPage(fn: (page: Page) => Promise<void>, view = "top") {
	const out = tempDir()
	mkdirSync(join(out, "compute-pi"))
	copyFileSync(join(ROOT, "test", "fixtures", "compute-pi", "system.json"), join(out, "compute-pi", "system.json"))
	const hub = await serveHub({ outRoot: out, port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		await page.addInitScript("window.__name = (f) => f")
		await page.goto(`${hub.url}/system?id=compute-pi&view=${view}`)
		await page.waitForFunction(() => document.querySelector("#stage canvas, #stage-top svg"), null, { timeout: 30_000 })
		await fn(page)
	} finally {
		await browser.close()
		await hub.close()
	}
}

test("Top: the Pi is a dark board labelled bought, with its record's four holes and header, raised over its carrier", { skip, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.waitForSelector('#stage-top [data-board="brain"][data-bought="rpi-5"]', { timeout: 30_000 })
		const g = await page.evaluate(() => {
			const pi = document.querySelector('#stage-top [data-board="brain"]')!
			const boards = [...document.querySelectorAll("#stage-top [data-board]")].map((e) => (e as HTMLElement).dataset.board)
			const outline = pi.querySelector("[data-outline]")!
			return {
				boards,
				fill: outline.getAttribute("fill"),
				size: [Number(outline.getAttribute("width")), Number(outline.getAttribute("height"))],
				holes: [...pi.querySelectorAll('[data-hole="bought"]')].map((h) => [Number(h.getAttribute("cx")), Number(h.getAttribute("cy"))]),
				header: Boolean(pi.querySelector("[data-header]")),
				label: pi.querySelector("[data-bought-label]")?.textContent,
				raised: Number(pi.querySelector("[data-raised]")?.getAttribute("data-raised") ?? 0),
				badge: document.querySelector('#stage-top [data-badge="brain"]')?.textContent,
				carrier: (() => { const o = document.querySelector('#stage-top [data-board="rpi-5-carrier"] [data-outline]')!; return [Number(o.getAttribute("width")), Number(o.getAttribute("height"))] })(),
			}
		})
		assert.deepEqual(g.size, [85, 56])
		assert.equal(g.fill, "#222428", "dark: bought, not designed here")
		assert.deepEqual(g.holes, [[3.5, 52.5], [61.5, 52.5], [3.5, 3.5], [61.5, 3.5]], "the record's holes, its y up turned to SVG's y down")
		assert.equal(g.header, true)
		assert.equal(g.label, "bought")
		assert.ok(g.raised > 0, "drawn raised over the carrier")
		assert.deepEqual(g.carrier, [85, 56], "the carrier, not built yet, is the Pi's outline (it stacks under it)")
		assert.ok(g.boards.indexOf("rpi-5-carrier") < g.boards.indexOf("brain"), "the carrier is drawn first, under the Pi")
		assert.match(g.badge ?? "", /bought/)
	})
})

test("the facts card of the Pi: where it comes from, its peak with the source, its carrier and bridge device; a click pins it, no board page opens", { skip, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.waitForSelector('#stage-top [data-board="brain"] [data-outline]', { timeout: 30_000 })
		await page.click('#stage-top [data-board="brain"] [data-outline]', { position: { x: 20, y: 20 } })
		await page.waitForFunction(() => !document.getElementById("facts")!.classList.contains("hidden"), null, { timeout: 10_000 })
		const text = await page.evaluate(() => document.getElementById("facts")!.textContent ?? "")
		assert.match(text, /brain · bought/)
		assert.match(text, /FromRaspberry Pi 5 \(bought\), on a generated carrier/)
		assert.match(text, /Peak5 A at 5\.1 V: https:\/\/github\.com\/raspberrypi\/documentation\/.*power-supplies\.adoc/)
		assert.match(text, /Carrierrpi-5-carrier/)
		assert.match(text, /Bridge\/dev\/ttyACM0/)
		assert.equal(await page.evaluate(() => document.getElementById("board-view")?.classList.contains("on") ?? false), false, "a bought board has no board page")
	})
})

test("3D: the Pi is labelled bought over its place (the stacking itself: stackPlaces in test/world3d.test.ts)", { skip, timeout: 120_000 }, async () => {
	await withPage(async (page) => {
		await page.waitForFunction(() => document.querySelector('#stage [data-badge="brain"]')?.textContent === "bought", null, { timeout: 30_000 })
		// Placed over the board on a drawn frame (its opacity fades in), not left hidden.
		await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#stage [data-badge="brain"]')!).opacity) > 0.5, null, { timeout: 15_000 })
	}, "3d")
})
