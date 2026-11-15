/// <reference lib="dom" />
// Forking a starter robot in a real browser: the start page's "Fork this robot" on Rover + climate makes a plan and
// opens it, and the plan says where it came from. No build runs.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
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

test("start page → Fork this robot on Rover + climate → the plan page shows the forked plan and where it came from", { skip, timeout: 120_000 }, async () => {
	const out = tempDir()
	const hub = await serveHub({ outRoot: out, port: 0, examplesRoot: join(ROOT, "examples") })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
		const errors: string[] = []
		page.on("pageerror", (e) => errors.push(e.message))
		await page.goto(`${hub.url}/`)
		const card = page.locator('#gallery .card[data-name="rover-climate"]')
		await card.waitFor({ timeout: 30_000 })
		// A plain example has no fork button; a starter does.
		assert.equal(await page.locator('#gallery .card[data-name="logger"] .fork').count(), 0)
		await card.locator(".fork").click()
		await page.waitForURL(/\/system\?id=plan-/, { timeout: 30_000 })
		const id = new URL(page.url()).searchParams.get("id")!
		assert.ok(existsSync(join(out, "plans", id, "plan.json")), "the fork is a plan in the hub's store")
		const line = page.locator("#forked-from")
		await line.waitFor({ timeout: 30_000 })
		assert.match((await line.textContent()) ?? "", /forked from Rover \+ climate board/)
		await page.waitForSelector('.plan-canvas .card[data-name="climate"]', { timeout: 30_000 })
		assert.equal(await page.locator('.plan-canvas .card[data-name="main"]').count(), 1)
		assert.deepEqual(errors.filter((e) => !/WebGL|GPU|swiftshader/i.test(e)), [])
	} finally {
		await browser.close()
		await hub.close()
	}
})
