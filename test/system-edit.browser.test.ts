/// <reference lib="dom" />
// Edit mode in the Top view, in a real browser, on a temp copy of the recorded robot-2: drag a board, see the change and
// the checks on the item, undo, rotate, resize the plate, add and route a cable, and Apply. No system process runs:
// the design's GET is rewritten to the status asked for, and the requests endpoint is intercepted with page.route.
import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, type Page, type Route } from "playwright"
import { serveHub } from "../src/dashboard/server.ts"

const ROOT = resolve(import.meta.dirname, "..")
function chromiumPath(): string | null {
	if (existsSync(chromium.executablePath())) return chromium.executablePath()
	const cache = join(homedir(), ".cache", "ms-playwright")
	return (existsSync(cache) ? readdirSync(cache) : []).filter((d) => /^chromium-\d+$/.test(d)).map((d) => join(cache, d, "chrome-linux64", "chrome")).find((p) => existsSync(p)) ?? null
}
const exe = chromiumPath()
const skip = !existsSync(join(ROOT, "out", "robot-2", "system.json")) ? "no recorded robot-2 in out/" : !exe ? "no Playwright Chromium" : false

type Diff = { assembly?: { boards?: { name: string; xMm: number; yMm: number; rotDeg: number; standoffMm?: number }[]; plate?: { lengthMm: number; widthMm: number }; cables?: { link: string; points: { xMm: number; yMm: number }[] }[] }; links?: { id: string; kind: string; a: { board: string; edge?: string }; b: { board: string; edge?: string } }[] } | null
type Design = { assembly: { boards: { name: string; xMm: number }[] } }
// setDesign: how the design's GET is changed from now on (the round's result, another change).
interface Ctx { page: Page; name: string; posts: { body: Record<string, unknown> }[]; gets: () => number; errors: string[]; setDesign: (f: (d: Design) => void) => void }
// answer: what the intercepted requests endpoint says (202 by default).
async function withEdit(fn: (c: Ctx) => Promise<void>, { status = "waiting for a change", answer }: { status?: string; answer?: (route: Route) => Promise<void> } = {}) {
	const name = `robot-edit-${Math.random().toString(36).slice(2, 8)}`
	const dir = join(ROOT, "out", name)
	cpSync(join(ROOT, "out", "robot-2"), dir, { recursive: true })
	rmSync(join(dir, "system-trace.jsonl"), { force: true })
	const hub = await serveHub({ outRoot: join(ROOT, "out"), port: 0 })
	const browser = await chromium.launch({ executablePath: exe!, headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
		const errors: string[] = []
		page.on("pageerror", (e) => errors.push(e.message))
		page.on("response", (r) => { if (r.status() >= 400 && !/\/requests$/.test(r.url())) errors.push(`${r.status()} ${r.url()}`) })
		let gets = 0
		let change: (d: Design) => void = () => {}
		// The design as if its system stayed up for changes.
		await page.route((u) => u.pathname === `/api/systems/${name}`, async (route) => {
			gets++
			const r = await route.fetch()
			const d = await r.json()
			change(d)
			await route.fulfill({ response: r, json: { ...d, status, settled: true } })
		})
		const posts: { body: Record<string, unknown> }[] = []
		await page.route((u) => u.pathname === `/api/systems/${name}/requests`, async (route) => {
			posts.push({ body: JSON.parse(route.request().postData() ?? "{}") })
			if (answer) return answer(route)
			await route.fulfill({ status: 202, json: { round: 1 } })
		})
		await page.goto(`${hub.url}/system?id=${name}&view=top`)
		await page.waitForSelector("#stage-top svg [data-board=climate]", { timeout: 30_000 })
		await fn({ page, name, posts, gets: () => gets, errors, setDesign: (f) => { change = f } })
		assert.deepEqual(errors.filter((e) => !/WebGL|GPU|swiftshader/i.test(e)), [])
	} finally {
		await browser.close()
		await hub.close()
		rmSync(dir, { recursive: true, force: true })
	}
}

const diff = (page: Page) => page.evaluate(() => (window as unknown as { __edit: { diff: () => unknown } }).__edit.diff()) as Promise<Diff>
// Screen pixels per millimetre, and a board's centre on screen.
async function geom(page: Page, board: string) {
	return page.evaluate((b) => {
		const svg = document.querySelector("#stage-top svg") as SVGSVGElement
		const m = svg.getScreenCTM()!
		const r = document.querySelector(`#stage-top [data-board="${b}"] [data-outline]`)!.getBoundingClientRect()
		return { k: m.a, x: r.x + r.width / 2, y: r.y + r.height / 2 }
	}, board)
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
	await page.mouse.move(from.x, from.y)
	await page.mouse.down()
	await page.mouse.move(to.x, to.y, { steps })
	await page.mouse.up()
}
const enter = async (page: Page) => { await page.click("#edit-btn"); await page.waitForSelector("#edit-bar:not(.hidden)") }

test("drag climate 10 mm back: the change shows in the bar and in the diff; undo restores and redo again", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page }) => {
		// Edit starts from 3D too: it switches to Top.
		await page.evaluate(() => (window as unknown as { setView: (v: string) => Promise<void> }).setView("3d"))
		await page.click("#edit-btn")
		await page.waitForSelector("#edit-bar:not(.hidden)")
		assert.equal(await page.locator("#view-switch [data-view=top]").getAttribute("aria-pressed"), "true")
		assert.equal(await page.locator("#edit-count").textContent(), "0 changes")
		assert.equal(await page.locator("#edit-apply").isDisabled(), true, "nothing to apply yet")
		const g = await geom(page, "climate")
		await drag(page, g, { x: g.x - 10 * g.k, y: g.y })
		const d = await diff(page)
		const c = d!.assembly!.boards!.find((b) => b.name === "climate")!
		assert.ok(Math.abs(c.xMm - 38) <= 0.5, `climate moved 10 mm back: ${c.xMm}`)
		assert.equal(c.yMm, 0)
		assert.equal(await page.locator("#edit-count").textContent(), "1 change")
		assert.equal(await page.locator("#edit-apply").isDisabled(), false)
		// The drawing follows (a full redraw after the drag).
		const after = await geom(page, "climate")
		assert.ok(Math.abs(after.x - (g.x - 10 * g.k)) < g.k, "the board is drawn where it was dropped")
		await page.keyboard.press("Control+z")
		assert.equal(await diff(page), null, "undo restores")
		assert.equal(await page.locator("#edit-count").textContent(), "0 changes")
		await page.keyboard.press("Control+Shift+z")
		assert.ok(await diff(page), "redo brings it back")
		await page.click("#edit-undo")
		assert.equal(await diff(page), null)
		// At rest in edit mode nothing draws.
		await page.waitForTimeout(300)
		const draws = () => page.evaluate(() => (window as unknown as { __topStats: () => { draws: number } }).__topStats().draws)
		const d0 = await draws()
		await page.waitForTimeout(800)
		assert.equal(await draws(), d0, "no draws while idle in edit mode")
	})
})

test("a board dragged onto another shows the overlap and Apply is off", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page }) => {
		await enter(page)
		const g = await geom(page, "climate"), m = await geom(page, "main")
		await drag(page, g, { x: m.x + 5 * g.k, y: m.y })
		await page.waitForSelector('#stage-top [data-board="climate"][data-bad]')
		assert.equal(await page.locator('#stage-top [data-board="main"][data-bad]').count(), 1)
		assert.match(await page.locator('#stage-top [data-chip="board:climate"]').textContent() ?? "", /overlaps main/)
		assert.match(await page.locator("#edit-findings").textContent() ?? "", /climate overlaps main/)
		assert.equal(await page.locator("#edit-apply").isDisabled(), true)
		assert.match(await page.locator("#edit-why").textContent() ?? "", /fix the error/i)
		await page.keyboard.press("Control+z")
		assert.equal(await page.locator("#stage-top [data-bad]").count(), 0, "undo clears the finding on the item")
	})
})

test("Apply posts exactly the diff with a short text; 202 marks it applied and polls again", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page, posts, gets }) => {
		await enter(page)
		const g = await geom(page, "climate")
		await drag(page, g, { x: g.x - 10 * g.k, y: g.y })
		const sent = await diff(page)
		const before = gets()
		await page.click("#edit-apply")
		await page.waitForFunction(() => document.querySelector("#edit-count")?.textContent === "0 changes")
		assert.equal(posts.length, 1)
		const { text, ...rest } = posts[0].body as { text: string }
		assert.deepEqual(rest, sent, "the body is the diff")
		assert.match(text, /^moved climate 10 mm back$/)
		assert.match(await page.locator("#edit-why").textContent() ?? "", /round 1/)
		assert.equal(await diff(page), null, "applied: nothing left to send")
		await page.keyboard.press("Control+z")
		assert.equal(await diff(page), null, "undo stops at the applied state")
		await page.waitForTimeout(2500)
		assert.ok(gets() > before, "the page polls the design again after Apply")
	})
})

test("Apply refused: 409 shows the reason and keeps the change; 400 shows the errors on the items", { skip, timeout: 120_000 }, async () => {
	let n = 0
	await withEdit(async ({ page }) => {
		await enter(page)
		const g = await geom(page, "climate")
		await drag(page, g, { x: g.x - 10 * g.k, y: g.y })
		await page.click("#edit-apply")
		await page.waitForFunction(() => /isn't running/.test(document.querySelector("#edit-why")?.textContent ?? ""))
		assert.ok(await diff(page), "the change is kept")
		assert.equal(await page.locator("#edit-count").textContent(), "1 change")
		await page.click("#edit-apply")
		await page.waitForSelector('#stage-top [data-board="climate"][data-bad]')
		assert.match(await page.locator("#edit-findings").textContent() ?? "", /board climate is over the battery/)
	}, {
		answer: async (route) => {
			n++
			if (n === 1) return route.fulfill({ status: 409, json: { error: "This design isn't running; start it again to apply changes" } })
			return route.fulfill({ status: 400, json: { error: "assembly: board climate is over the battery", errors: ["assembly: board climate is over the battery"] } })
		},
	})
})

test("a design that isn't running: Apply is off and says why", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page, posts }) => {
		await enter(page)
		const g = await geom(page, "climate")
		await drag(page, g, { x: g.x - 10 * g.k, y: g.y })
		assert.equal(await page.locator("#edit-apply").isDisabled(), true)
		assert.match(await page.locator("#edit-why").textContent() ?? "", /isn't running/)
		assert.equal(posts.length, 0)
	}, { status: "settled" })
})

test("rotate with R and with the card's ↻; a click selects and does not open the board; leaving edit opens again", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page }) => {
		await enter(page)
		const g = await geom(page, "climate")
		await page.mouse.click(g.x, g.y)
		await page.waitForSelector("#facts:not(.hidden) [data-act=turn]")
		await page.waitForTimeout(700)
		assert.equal(await page.locator("#board-view").getAttribute("class"), null, "no zoom into the board page")
		await page.keyboard.press("r")
		assert.equal((await diff(page))!.assembly!.boards!.find((b) => b.name === "climate")!.rotDeg, 90)
		await page.click("#facts [data-act=turn]")
		assert.equal((await diff(page))!.assembly!.boards!.find((b) => b.name === "climate")!.rotDeg, 180)
		// The standoff height sits in the board's card.
		await page.fill("#facts input[data-act=standoff]", "12")
		await page.press("#facts input[data-act=standoff]", "Enter")
		assert.equal((await diff(page))!.assembly!.boards!.find((b) => b.name === "climate")!.standoffMm, 12)
		await page.click("#edit-btn")
		await page.waitForSelector("#edit-bar.hidden", { state: "attached" })
		const h = await geom(page, "main")
		await page.mouse.click(h.x, h.y)
		await page.waitForSelector("#board-view.on", { timeout: 10_000 })
	})
})

test("resize the plate from a corner handle", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page }) => {
		await enter(page)
		const h = await page.locator('#stage-top [data-plate-handle="fl"]').boundingBox()
		const { k } = await geom(page, "main")
		const at = { x: h!.x + h!.width / 2, y: h!.y + h!.height / 2 }
		// Front-left is up and right in the picture: 5 mm further out on each axis.
		await drag(page, at, { x: at.x + 5 * k, y: at.y - 5 * k })
		const p = (await diff(page))!.assembly!.plate!
		assert.ok(Math.abs(p.lengthMm - 166) <= 1, `length ${p.lengthMm}`)
		assert.ok(Math.abs(p.widthMm - 120) <= 1, `width ${p.widthMm}`)
		const rect = await page.locator("#stage-top [data-plate]").getAttribute("width")
		assert.equal(Number(rect), p.lengthMm, "the plate is drawn at its new size")
	})
})

test("add a cable from a board's dot, pick I2C, then bend its route; the card deletes it", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page }) => {
		await enter(page)
		const dot = await page.locator('#stage-top [data-dot="main"]').boundingBox()
		const c = await geom(page, "climate")
		await drag(page, { x: dot!.x + dot!.width / 2, y: dot!.y + dot!.height / 2 }, { x: c.x, y: c.y + 4 * c.k })
		await page.click("#edit-picker button[data-kind=i2c]")
		let d = await diff(page)
		const added = d!.links!.find((l) => l.id === "L2")!
		assert.equal(added.kind, "i2c")
		assert.deepEqual([added.a.board, added.b.board], ["main", "climate"])
		await page.waitForSelector('#stage-top [data-cable="L2"]', { state: "attached" })
		// Bend: drag the middle of its only leg 15 mm left (up on screen).
		const mid = await page.locator('#stage-top [data-route-handle="L2:0"]').boundingBox()
		const at = { x: mid!.x + mid!.width / 2, y: mid!.y + mid!.height / 2 }
		await drag(page, at, { x: at.x, y: at.y - 15 * c.k })
		d = await diff(page)
		const route = d!.assembly!.cables!.find((x) => x.link === "L2")!
		assert.equal(route.points.length, 3, "a bend adds a point")
		assert.ok(route.points[1].yMm > 10, `the bend is to the left: ${route.points[1].yMm}`)
		assert.equal((await page.locator('#stage-top [data-cable="L2"] [data-line]').getAttribute("d"))!.split("L").length, 3)
		// Select it (a press on its handle that doesn't move is a click on the cable): the card offers the kind, the edges and Delete.
		await page.click('#stage-top [data-route-handle="L2:0"]')
		await page.waitForSelector("#facts:not(.hidden) select[data-act=kind]")
		await page.selectOption("#facts select[data-act=kind]", "uart")
		assert.equal((await diff(page))!.links!.find((l) => l.id === "L2")!.kind, "uart")
		await page.selectOption("#facts select[data-act=edge-a]", "top")
		assert.equal((await diff(page))!.links!.find((l) => l.id === "L2")!.a.edge, "top")
		await page.click("#facts [data-act=delete]")
		d = await diff(page)
		assert.ok(!d?.links?.some((l) => l.id === "L2"), "deleted")
	})
})

const at = (x: number) => (d: Design) => { d.assembly.boards.find((b) => b.name === "main")!.xMm = x }
const stateX = (page: Page, board: string) => page.evaluate((b) => (window as unknown as { __edit: { state: () => { assembly: { boards: { name: string; xMm: number }[] } } } }).__edit.state().assembly.boards.find((x) => x.name === b)!.xMm, board)

test("after Apply, the next poll rebuilds the editor from the round's result", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page, setDesign }) => {
		await enter(page)
		const g = await geom(page, "climate")
		await drag(page, g, { x: g.x - 10 * g.k, y: g.y })
		await page.click("#edit-apply")
		await page.waitForFunction(() => document.querySelector("#edit-count")?.textContent === "0 changes")
		// The round moved main (and kept climate where it was sent).
		setDesign((d) => { at(-5)(d); d.assembly.boards.find((b) => b.name === "climate")!.xMm = 38 })
		await page.waitForFunction(() => (window as unknown as { __edit: { state: () => { assembly: { boards: { name: string; xMm: number }[] } } } }).__edit.state().assembly.boards.find((b) => b.name === "main")!.xMm === -5, null, { timeout: 15_000 })
		assert.equal(await diff(page), null)
		assert.equal(await page.locator("#edit-stale").isVisible(), false)
	})
})

test("the design changing under unsent edits asks Rebase or Discard; Apply waits; Rebase replays the edits on the new design", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page, posts, setDesign }) => {
		await enter(page)
		let g = await geom(page, "climate")
		await drag(page, g, { x: g.x - 10 * g.k, y: g.y })
		setDesign(at(-10))
		await page.waitForSelector("#edit-stale:not(.hidden)", { timeout: 15_000 })
		assert.match(await page.locator("#edit-stale").textContent() ?? "", /changed since you started editing/)
		assert.equal(await page.locator("#edit-apply").isDisabled(), true, "never send a diff based on an old snapshot")
		await page.click("#edit-rebase")
		assert.equal(await page.locator("#edit-stale").isVisible(), false)
		assert.equal(await stateX(page, "main"), -10, "the new design")
		assert.ok(Math.abs((await stateX(page, "climate")) - 38) <= 0.5, "with the edit replayed")
		await page.click("#edit-apply")
		await page.waitForFunction(() => document.querySelector("#edit-count")?.textContent === "0 changes")
		const boards = (posts[0].body as { assembly: { boards: { name: string; xMm: number }[] } }).assembly.boards
		assert.equal(boards.find((b) => b.name === "main")!.xMm, -10, "based on the new design, not the old snapshot")
		// Discard: the edits go, the new design stays.
		g = await geom(page, "climate")
		await drag(page, g, { x: g.x - 4 * g.k, y: g.y })
		setDesign(at(-12))
		await page.waitForSelector("#edit-stale:not(.hidden)", { timeout: 15_000 })
		await page.click("#edit-discard")
		assert.equal(await diff(page), null)
		assert.equal(await stateX(page, "main"), -12)
	}, { status: "running" })
})

test("leaving with unsent edits says so on the button; coming back to a changed design asks the same question", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page, gets, setDesign }) => {
		await enter(page)
		const g = await geom(page, "climate")
		await drag(page, g, { x: g.x - 10 * g.k, y: g.y })
		await page.click("#edit-btn")
		await page.waitForSelector("#edit-bar.hidden", { state: "attached" })
		assert.match(await page.locator("#edit-btn").textContent() ?? "", /1 unsent/)
		setDesign(at(-10))
		const n = gets()
		while (gets() < n + 2) await page.waitForTimeout(250)
		await page.click("#edit-btn")
		await page.waitForSelector("#edit-stale:not(.hidden)")
		assert.ok(await diff(page), "the kept edits are still there")
	}, { status: "running" })
})

test("drag details: back to the start keeps redo, Escape cancels a drag, a dragged board keeps its card", { skip, timeout: 120_000 }, async () => {
	await withEdit(async ({ page }) => {
		await enter(page)
		const g = await geom(page, "climate")
		await drag(page, g, { x: g.x - 10 * g.k, y: g.y })
		await page.keyboard.press("Control+z")
		assert.equal(await page.locator("#edit-redo").isDisabled(), false)
		// Out and back: no edit, and redo survives.
		await page.mouse.move(g.x, g.y); await page.mouse.down()
		await page.mouse.move(g.x - 8 * g.k, g.y, { steps: 6 }); await page.mouse.move(g.x, g.y, { steps: 6 }); await page.mouse.up()
		assert.equal(await diff(page), null)
		assert.equal(await page.locator("#edit-redo").isDisabled(), false, "redo kept")
		// Escape mid-drag: nothing changes, the board is back.
		await page.mouse.move(g.x, g.y); await page.mouse.down()
		await page.mouse.move(g.x - 10 * g.k, g.y, { steps: 6 })
		await page.keyboard.press("Escape")
		await page.mouse.up()
		assert.equal(await diff(page), null)
		assert.ok(Math.abs((await geom(page, "climate")).x - g.x) < 1, "drawn where it was")
		// Select, then drag: the card stays.
		await page.mouse.click(g.x, g.y)
		await page.waitForSelector("#facts:not(.hidden) [data-act=turn]")
		await drag(page, g, { x: g.x - 6 * g.k, y: g.y })
		await page.waitForTimeout(200)
		assert.equal(await page.locator("#facts [data-act=turn]").isVisible(), true)
	})
})
