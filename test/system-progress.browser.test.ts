/// <reference lib="dom" />
// Live progress on the design page, in a real browser: a system-trace.jsonl written into a temp copy of a recorded
// robot while the page is open shows as a strip and as badges in both views, with no reload and no drawing at rest.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, cpSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, type Page } from "playwright"
import { serveHub } from "../src/dashboard/server.ts"

const ROOT = resolve(import.meta.dirname, "..")
function chromiumPath(): string | null {
	if (existsSync(chromium.executablePath())) return chromium.executablePath()
	const cache = join(homedir(), ".cache", "ms-playwright")
	return (existsSync(cache) ? readdirSync(cache) : []).filter((d) => /^chromium-\d+$/.test(d)).map((d) => join(cache, d, "chrome-linux64", "chrome")).find((p) => existsSync(p)) ?? null
}
const exe = chromiumPath()
const skip = !existsSync(join(ROOT, "out", "robot-2", "system.json")) ? "no recorded robot-2 in out/" : !exe ? "no Playwright Chromium" : false

const line = (round: number, board: string, step: string, status: string, extra = {}) => JSON.stringify({ at: new Date().toISOString(), round, board, step, status, ...extra }) + "\n"

async function withCopy(fn: (page: Page, dir: string, url: string, errors: string[]) => Promise<void>, trace?: string, source = "robot-2") {
	const name = `robot-live-${Math.random().toString(36).slice(2, 8)}`
	const dir = join(ROOT, "out", name)
	cpSync(join(ROOT, "out", source), dir, { recursive: true })
	rmSync(join(dir, "system-trace.jsonl"), { force: true })
	if (trace !== undefined) writeFileSync(join(dir, "system-trace.jsonl"), trace)
	const hub = await serveHub({ outRoot: join(ROOT, "out"), port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		const errors: string[] = []
		page.on("pageerror", (e) => errors.push(e.message))
		page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`) })
		await page.goto(`${hub.url}/system?id=${name}&view=top`)
		await page.waitForFunction(() => Boolean((window as unknown as { openBoard?: unknown }).openBoard) && document.querySelector("#stage-top svg"), null, { timeout: 30_000 })
		await fn(page, dir, hub.url, errors)
	} finally {
		await browser.close()
		await hub.close()
		rmSync(dir, { recursive: true, force: true })
	}
}

test("the strip and the badges follow lines appended while the page is open", { skip, timeout: 120_000 }, async () => {
	await withCopy(async (page, dir, _u, errors) => {
		await page.waitForSelector("#stage-top [data-board]", { timeout: 20_000 })
		const boards = await page.evaluate(() => [...document.querySelectorAll("#stage-top [data-board]")].map((e) => (e as HTMLElement).dataset.board!))
		assert.ok(boards.length >= 2, "a robot with boards")
		const [a, b] = boards
		// Replay first: the lines already in the file show at once.
		assert.equal(await page.locator("#progress").isHidden(), true, "no trace yet: no strip")
		appendFileSync(join(dir, "system-trace.jsonl"), line(0, a, "board", "ok") + line(0, a, "firmware", "started"))
		await page.waitForSelector("#progress .pg-row", { timeout: 10_000 })
		await page.waitForFunction((n) => document.querySelector(`#progress [data-board="${n}"] [data-step=firmware].started`), a)
		assert.equal(await page.locator(`#stage-top [data-badge="${a}"]`).count(), 1)
		assert.match((await page.locator(`#stage-top [data-badge="${a}"] text`).textContent())!, /firmware/)
		// A failure shows red with its detail on hover; a settle is a tick; a new round counts up.
		appendFileSync(join(dir, "system-trace.jsonl"), line(0, a, "firmware", "failed", { detail: "pin 99 is not on the part" }) + line(1, "system", "request", "started", { detail: "make it 50 mm wide" }) + line(1, a, "request", "started") + line(1, b, "settled", "ok"))
		await page.waitForFunction(() => document.querySelector("#progress [data-round]")?.textContent === "1")
		assert.equal(await page.locator(`#progress [data-board="${a}"] [data-step=firmware]`).getAttribute("title"), "pin 99 is not on the part")
		assert.equal(await page.locator(`#progress [data-board="${a}"] [data-step=board]`).getAttribute("data-prev"), "", "the old round's chip stays, greyed")
		assert.match(await page.locator("#progress [data-system]").textContent() ?? "", /request started/)
		await page.waitForFunction((n) => document.querySelector(`#stage-top [data-badge="${n}"] text`)?.textContent === "✓", b)
		assert.match((await page.locator(`#stage-top [data-badge="${a}"] text`).textContent())!, /request/)
		assert.match((await page.locator(`#progress [data-board="${a}"] [data-step=firmware]`).textContent())!, /✗/, "the failed chip is still there, greyed")
		// The 3D view gets the same badges when switched to.
		await page.evaluate(() => (window as unknown as { setView: (v: string) => Promise<void> }).setView("3d"))
		await page.waitForSelector(`#stage [data-badge="${b}"]`, { timeout: 10_000 })
		assert.equal(await page.locator(`#stage [data-badge="${b}"]`).textContent(), "✓")
		await page.evaluate(() => (window as unknown as { setView: (v: string) => Promise<void> }).setView("top"))
		// At rest nothing draws.
		await page.waitForTimeout(300)
		const d0 = await page.evaluate(() => (window as unknown as { __topStats: () => { draws: number } }).__topStats().draws)
		await page.waitForTimeout(800)
		assert.equal(await page.evaluate(() => (window as unknown as { __topStats: () => { draws: number } }).__topStats().draws), d0, "no draws while idle")
		assert.deepEqual(errors.filter((e) => !/WebGL|GPU|swiftshader/i.test(e)), [])
	})
})

test("a trace already in the file is replayed on load", { skip, timeout: 120_000 }, async () => {
	await withCopy(async (page) => {
		await page.waitForSelector("#progress .pg-row", { timeout: 10_000 })
		assert.equal(await page.locator("#progress [data-round]").textContent(), "2")
	}, line(0, "main", "board", "ok") + line(2, "main", "case", "started"))
})

test("an old run without a trace shows no strip and no error", { skip, timeout: 120_000 }, async () => {
	await withCopy(async (page, _d, _u, errors) => {
		await page.waitForTimeout(1500)
		assert.equal(await page.locator("#progress").isHidden(), true)
		assert.equal(await page.locator("#stage-top [data-badge]").count(), 0)
		assert.deepEqual(errors.filter((e) => !/WebGL|GPU|swiftshader/i.test(e)), [])
	})
})

test("stopProgress closes the stream and takes the strip down", { skip, timeout: 120_000 }, async () => {
	await withCopy(async (page, dir) => {
		appendFileSync(join(dir, "system-trace.jsonl"), line(0, "main", "board", "ok"))
		await page.waitForSelector("#progress .pg-row", { timeout: 10_000 })
		assert.equal(await page.evaluate(() => (window as unknown as { __progressOpen: () => boolean }).__progressOpen()), true)
		await page.evaluate(() => (window as unknown as { __stopProgress: () => void }).__stopProgress())
		assert.equal(await page.evaluate(() => (window as unknown as { __progressOpen: () => boolean }).__progressOpen()), false)
		assert.equal(await page.locator("#progress").count(), 0)
		assert.equal(await page.locator("#stage-top [data-badge]").count(), 0)
	})
})

// A one-board design has no system trace: its own run's events give the same strip.
for (const source of ["logger-single", "rover-fresh"]) {
	const has = existsSync(join(ROOT, "out", source, "trace.jsonl"))
	test(`a one-board design (${source}) shows the same strip and badge, live`, { skip: skip || (has ? false : `no ${source}`), timeout: 120_000 }, async () => {
		await withCopy(async (page, dir, _u, errors) => {
			await page.waitForSelector("#progress .pg-row", { timeout: 15_000 })
			assert.ok((await page.locator("#progress .pg-chip").count()) > 0, "chips from the run's own trace")
			await page.waitForSelector("#stage-top [data-badge]", { timeout: 10_000 })
			appendFileSync(join(dir, "trace.jsonl"), JSON.stringify({ seq: 9999, at: new Date().toISOString(), type: "artifact.failed", producerId: "x", payload: { kind: "firmware", revision: 99, error: "boom" } }) + "\n")
			await page.waitForFunction(() => document.querySelector('#progress [data-step=firmware][data-status=failed]'))
			assert.equal(await page.locator("#progress [data-step=firmware][data-status=failed]").getAttribute("title"), "boom")
			assert.deepEqual(errors.filter((e) => !/WebGL|GPU|swiftshader/i.test(e)), [])
		}, undefined, source)
	})
}
