/// <reference lib="dom" />
// The Top view (src/dashboard/top2d.js) in headless Chromium, fed robot-2's recorded data. Skipped without the
// recorded run or Playwright's Chromium.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
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


async function withTop(fn: (page: Page) => Promise<void>) {
	const hub = await serveHub({ outRoot: join(ROOT, "out"), port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
		await page.addInitScript("window.__name = (f) => f")
		// A same-origin document (the JSON itself) to import the module from.
		await page.goto(`${hub.url}/api/systems/robot-2`)
		const chDir = join(ROOT, "out", "robot-2", "boards", "main", "chassis")
		const rev = readdirSync(chDir).map((d) => /^rev-(\d+)$/.exec(d)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a)[0]
		await page.evaluate(async (rev) => {
			const sys = await (await fetch("/api/systems/robot-2")).json()
			const get = async (p: string) => { const r = await fetch(p); return r.ok ? r.json() : null }
			const boards = await Promise.all(sys.boards.map(async (b: any) => ({ name: b.name, outline: b.outline, connectors: b.connectors, status: b.status, circuit: await get(`/runs/${b.runId}/files/board/circuit.json`) })))
			const main = sys.boards.find((b: any) => b.name === "main")
			const chassis = await get(`/runs/${main.runId}/files/chassis/rev-${rev}/spec.json`)
			document.body.innerHTML = '<div id="host" style="width:1000px;height:700px"></div>'
			const { mountTop } = await import(String("/top2d.js"))
			const { topLayout } = await import(String("/top-layout.js"))
			const w: any = window
			w.events = []
			w.tv = mountTop(document.getElementById("host")!, { onHover: (n: any, k: any) => w.events.push(["hover", n, k]), onPick: (n: any, k: any) => w.events.push(["pick", n, k]) })
			await w.tv.ready
			w.tv.setWorld({ boards, cables: sys.spec.links, assembly: sys.assembly, chassis })
			w.bounds = topLayout(sys.assembly, boards, sys.spec.links).bounds
			w.layout = topLayout(sys.assembly, boards, sys.spec.links)
			w.world = { boards, cables: sys.spec.links, assembly: sys.assembly, chassis }
		}, rev)
		await fn(page)
	} finally {
		await browser.close()
		await hub.close()
	}
}
const homeStart = async (page: Page) => { await page.evaluate(() => { (window as any).homeAtStart = document.querySelector("svg")!.getAttribute("viewBox")!.split(" ").map(Number) }) }
const vb = (page: Page) => page.evaluate(() => document.querySelector("svg")!.getAttribute("viewBox")!.split(" ").map(Number))
const near = (a: number[], b: number[], tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

test("top view draws every board and cable of robot-2", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		assert.equal(await page.locator("[data-board]").count(), 2)
		assert.equal(await page.locator("[data-cable]").count(), 1)
		assert.ok((await page.locator("[data-part]").count()) > 0, "the built boards' parts are drawn")
	})
})

test("robot-2's wheels and battery show as outlines", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		assert.equal(await page.locator('[data-mech="wheel"]').count(), 2)
		assert.equal(await page.locator('[data-mech="battery"]').count(), 1)
		assert.equal(await page.locator('[data-mech="motor"]').count(), 2)
		assert.equal(await page.locator('[data-mech="caster"]').count(), 1)
		const b = await page.locator('[data-mech="battery"]').boundingBox()
		assert.ok(b && b.width > 5)
	})
})

test("focus zooms the viewBox onto the board and back", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		await homeStart(page)
		await page.evaluate(() => (window as any).tv.focus("climate", { ms: 200 }))
		const c = await page.evaluate(() => (window as any).layout.boards.find((b: any) => b.name === "climate"))
		const k = 1.25
		assert.ok(near(await vb(page), [c.x - (c.w * (k - 1)) / 2, c.y - (c.h * (k - 1)) / 2, c.w * k, c.h * k]), "on climate, grown by 25%")
		await page.evaluate(() => (window as any).tv.focus(null, { ms: 200 }))
		const v = await vb(page), b = await page.evaluate(() => (window as any).bounds)
		// Home covers the layout's bounds (plus the wheels, which stand outside the plate).
		assert.ok(v[0] <= b.x + 0.001 && v[1] <= b.y + 0.001 && v[0] + v[2] >= b.x + b.w - 0.001 && v[1] + v[3] >= b.y + b.h - 0.001, "back on home, covering bounds")
		assert.ok(near(v, await page.evaluate(() => { const r = document.querySelector("svg")!; void r; return (window as any).homeAtStart }), 0.001), "home is where it started")
	})
})

test("a second focus mid-flight ends on the second board and stops drawing", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		await page.evaluate(() => { (window as any).tv.focus("main", { ms: 500 }) })
		await page.waitForTimeout(100)
		await page.evaluate(() => (window as any).tv.focus("climate"))
		const c = await page.evaluate(() => (window as any).layout.boards.find((b: any) => b.name === "climate"))
		assert.ok(near(await vb(page), [c.x - c.w * 0.125, c.y - c.h * 0.125, c.w * 1.25, c.h * 1.25]))
		const d0 = await page.evaluate(() => (window as any).tv.stats().draws)
		await page.waitForTimeout(500)
		assert.equal(await page.evaluate(() => (window as any).tv.stats().draws), d0)
	})
})

test("no drawing while idle", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		const d0 = await page.evaluate(() => (window as any).tv.stats().draws)
		await page.waitForTimeout(2000)
		assert.equal(await page.evaluate(() => (window as any).tv.stats().draws), d0)
	})
})

test("hover and click report the board, and select outlines it in the signal colour", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		const box = await page.locator('[data-board="climate"] [data-outline]').boundingBox()
		assert.ok(box)
		await page.mouse.move(box.x + 2, box.y + 2)
		await page.mouse.down()
		await page.mouse.up()
		await page.mouse.move(0, 0)
		const ev = await page.evaluate(() => (window as any).events)
		assert.deepEqual(ev.find((e: any) => e[0] === "hover"), ["hover", "climate", "board"])
		assert.deepEqual(ev.find((e: any) => e[0] === "pick"), ["pick", "climate", "board"])
		assert.deepEqual(ev.at(-1), ["hover", null, "board"])
		await page.evaluate(() => (window as any).tv.select("climate", "board"))
		assert.match((await page.locator('[data-board="climate"] [data-outline]').getAttribute("stroke"))!, /signal/)
	})
})

test("every mechanical outline lies inside the default view", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		const v = await vb(page)
		const rects = await page.evaluate(() => [...document.querySelectorAll("[data-mech]")].map((e) => { const b = (e as SVGGraphicsElement).getBBox(); return [b.x, b.y, b.width, b.height] }))
		assert.ok(rects.length >= 6)
		for (const r of rects) assert.ok(r[0] >= v[0] && r[1] >= v[1] && r[0] + r[2] <= v[0] + v[2] && r[1] + r[3] <= v[1] + v[3], `mech ${r} inside ${v}`)
	})
})

test("setWorld again keeps a focused board and a panned view", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		await page.evaluate(() => (window as any).tv.focus("climate", { ms: 100 }))
		const before = await vb(page)
		await page.evaluate(() => (window as any).tv.setWorld((window as any).world))
		assert.ok(near(await vb(page), before, 0.001), "still on climate")
		await page.mouse.move(500, 350)
		await page.mouse.wheel(0, 300)
		await page.waitForTimeout(100)
		const zoomed = await vb(page)
		assert.ok(zoomed[2] > before[2])
		await page.evaluate(() => (window as any).tv.setWorld((window as any).world))
		assert.ok(near(await vb(page), zoomed, 0.001), "a zoomed view stays")
		assert.equal(await page.evaluate(() => (window as any).tv.stats().draws) > 0, true)
	})
})

test("a cable reports kind cable on hover and click", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		const p = await page.evaluate(() => { const r = document.querySelector("[data-cable] [data-line]")!.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })
		await page.mouse.move(p[0], p[1] + 1)
		await page.mouse.down()
		await page.mouse.up()
		const ev = await page.evaluate(() => (window as any).events)
		assert.deepEqual(ev.find((e: any) => e[0] === "hover"), ["hover", "L1", "cable"])
		assert.deepEqual(ev.find((e: any) => e[0] === "pick"), ["pick", "L1", "cable"])
	})
})

test("after dispose nothing runs: no frames, no clicks", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		await page.evaluate(() => { (window as any).tv.focus("main", { ms: 800 }) })
		await page.waitForTimeout(100)
		const box = await page.locator('[data-board="main"] [data-outline]').boundingBox()
		const d = await page.evaluate(() => { const t = (window as any).tv; t.dispose(); t.focus("climate"); t.setWorld((window as any).world); return t.stats().draws })
		await page.waitForTimeout(300)
		assert.equal(await page.evaluate(() => (window as any).tv.stats().draws), d)
		assert.equal(await page.locator("svg").count(), 0)
		assert.ok(box)
		await page.mouse.click(box.x + 2, box.y + 2)
		assert.equal((await page.evaluate(() => (window as any).events)).filter((e: any) => e[0] === "pick").length, 0)
	})
})

test("focus on an unknown board changes nothing, and a vanished focused board sends the view home once", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		const home = await vb(page)
		await page.evaluate(() => (window as any).tv.focus("nope", { ms: 50 }))
		assert.ok(near(await vb(page), home, 0.001))
		await page.evaluate(() => (window as any).tv.setWorld((window as any).world))
		assert.ok(near(await vb(page), home, 0.001), "an unknown focus name did not pin the view")
		await page.evaluate(() => (window as any).tv.focus("climate", { ms: 50 }))
		await page.evaluate(() => { const w = (window as any).world; (window as any).tv.setWorld({ ...w, boards: w.boards.filter((b: any) => b.name !== "climate"), cables: [], assembly: { ...w.assembly, boards: w.assembly.boards.filter((b: any) => b.name !== "climate") } }) })
		const after = await vb(page)
		assert.ok(after[2] > 100, "home again")
		await page.mouse.move(500, 350)
		await page.mouse.wheel(0, 300)
		await page.waitForTimeout(50)
		const z = await vb(page)
		await page.evaluate(() => (window as any).tv.setWorld((window as any).world))
		assert.ok(near(await vb(page), z, 0.001), "no second snap")
	})
})

test("a press during a flight takes over: the next setWorld does not jump to the unreached target", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		await page.evaluate(() => { (window as any).tv.focus("climate", { ms: 1000 }) })
		await page.waitForTimeout(250)
		await page.mouse.move(5, 5)
		await page.mouse.down()
		await page.mouse.up()
		const held = await vb(page)
		await page.evaluate(() => (window as any).tv.setWorld((window as any).world))
		assert.ok(near(await vb(page), held, 0.001))
	})
})

test("a live update retargets a flight and keeps its time; the promise resolves on arrival", { skip, timeout: 60_000 }, async () => {
	await withTop(async (page) => {
		const r = await page.evaluate(async () => {
			const tv = (window as any).tv, w = (window as any).world
			const t0 = performance.now()
			const p = tv.focus("climate", { ms: 600 }).then(() => performance.now() - t0)
			await new Promise((res) => setTimeout(res, 300))
			tv.setWorld(w)
			return p
		})
		assert.ok(r >= 550 && r < 900, `arrived after ${r} ms, not restarted`)
	})
})
