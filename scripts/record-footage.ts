// Records raw footage for the submission video (docs/video.md), Acts 1–4, from a real `npm run demo` (scripted
// agents, real tools): real mouse moves and typing in a real browser, recorded with Playwright at 1920×1080.
// Act 5, the real board, is filmed by hand.
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs npx tsx scripts/record-footage.ts [--out out/footage] [--port 4398] [--no-cursor]
//
// Playwright is not a dependency of the project (judges don't need it): point PLAYWRIGHT_CORE at an install, e.g.
// `npm i --no-save playwright-core && npx playwright-core install chromium`, then PLAYWRIGHT_CORE=playwright-core.
// Writes out/footage/act-1.webm … act-4.webm, a frame grab per act (act-N.png) and shots.md (timestamps).
import { spawn } from "node:child_process"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const W = 1920
const H = 1080

export interface Mark {
	act: number
	atMs: number
	what: string
}

// The shot list: one line per mark, "act N  m:ss  what happens", in recording order.
export function shotList(marks: Mark[]): string {
	const t = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`
	return ["# Footage shot list (times from the start of each act's file)", "", ...marks.map((m) => `- act-${m.act}.webm  ${t(m.atMs)}  ${m.what}`), ""].join("\n")
}

// A cursor drawn where the real mouse is, as a screen recorder would (headless video has none). Moves only on real
// mouse events; it never shows anything the page doesn't.
const CURSOR = `(() => {
	const c = document.createElement("div")
	c.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:transform 40ms linear"
	c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 2 L2 18 L7 13 L10 20 L13 19 L10 12 L17 12 Z" fill="#16140f" stroke="#fff" stroke-width="1.5"/></svg>'
	const add = () => document.body && !c.isConnected && document.body.append(c)
	addEventListener("mousemove", (e) => { add(); c.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)" }, true)
	addEventListener("DOMContentLoaded", add)
})()`

async function main(): Promise<void> {
	const argv = process.argv.slice(2)
	const arg = (flag: string, fallback: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback)
	const out = resolve(ROOT, arg("--out", "out/footage"))
	const port = Number(arg("--port", "4398"))
	const cursor = !argv.includes("--no-cursor")
	mkdirSync(out, { recursive: true })
	const pw = process.env.PLAYWRIGHT_CORE
	if (!pw) throw new Error("set PLAYWRIGHT_CORE to a playwright-core install (see the header of this file)")
	const { chromium } = await import(pw)

	// The demo: scripted agents, real tools. The automatic change is "blink faster when tilted" (firmware only), so
	// the board is still 50 × 30 mm when "make it 40 mm wide" is typed: exactly the experiment's "10 mm narrower" trial,
	// which is what puts the proof line on screen.
	const demo = spawn("npx", ["tsx", "src/demo.ts", "--no-open", "--port", String(port), "--change", "blink faster when tilted", "--after", "10"], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], detached: true })
	const runUrl = await new Promise<string>((ok, fail) => {
		let buf = ""
		demo.stdout.on("data", (c: Buffer) => {
			process.stdout.write(c)
			buf += c.toString()
			const m = /dashboard: (http:\/\/\S+\?run=\S+)/.exec(buf)
			if (m) ok(m[1])
		})
		demo.once("exit", (code) => fail(new Error(`the demo exited (${code}) before its dashboard was up`)))
	})
	const hubUrl = runUrl.replace(/\?run=.*/, "?run=")
	const browser = await chromium.launch({ headless: true })
	const marks: Mark[] = []
	let actStart = 0
	let act = 0
	const mark = (what: string) => {
		marks.push({ act, atMs: Date.now() - actStart, what })
		console.log(`[act ${act}] ${what}`)
	}
	const take = async (n: number, url: string, body: (page: any) => Promise<void>) => {
		const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: out, size: { width: W, height: H } } })
		if (cursor) await ctx.addInitScript(CURSOR)
		const page = await ctx.newPage()
		act = n
		actStart = Date.now()
		await page.goto(url)
		await body(page)
		await page.screenshot({ path: join(out, `act-${n}.png`) })
		const video = page.video()
		await ctx.close()
		renameSync(await video.path(), join(out, `act-${n}.webm`))
	}
	const until = (page: any, fn: string, ms: number) => page.waitForFunction(fn, null, { timeout: ms, polling: 250 })
	const glide = async (page: any, sel: string) => {
		const b = await page.locator(sel).first().boundingBox()
		if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 25 })
	}
	const resultIs = (state: string, quote: boolean) => `document.getElementById("rip-result").className === "${state}" && document.getElementById("rip-text").classList.contains("quote") === ${quote}`

	try {
		// Act 2 (recorded first: the run is already starting): the first design building, then "Consistent at rev N".
		await take(2, runUrl, async (page) => {
			mark("the run page opens: 05 reads “Designing from the brief”, agent tiles lighting up together")
			await page.waitForTimeout(4000)
			await glide(page, "#agents")
			mark("several agent tiles working at once")
			await until(page, resultIs("consistent", false), 15 * 60_000)
			mark("05: “First design consistent at rev N” · now change one thing ↑")
			await glide(page, "#pcb-host")
			await page.waitForTimeout(3500)
		})

		// Act 3: the automatic change ripples; then "make it 40 mm wide" typed by hand; the proof line; the PCB; why.
		await take(3, runUrl, async (page) => {
			await until(page, `/blink/i.test(document.getElementById("rip-text").textContent)`, 120_000)
			mark("the automatic change lands: “blink faster when tilted” (firmware only)")
			await until(page, resultIs("consistent", true), 10 * 60_000)
			mark("05: “blink faster when tilted”: board, case and firmware agree; firmware woke, board and case stayed idle")
			await page.waitForTimeout(3000)
			await glide(page, "#change-input")
			await page.click("#change-input")
			mark("typing “make it 40 mm wide”")
			await page.keyboard.type("make it 40 mm wide", { delay: 90 })
			await page.waitForTimeout(600)
			await page.keyboard.press("Enter")
			await until(page, `/40 mm/.test(document.getElementById("rip-text").textContent) && ["rippling", "sent"].includes(document.getElementById("rip-result").className)`, 120_000)
			mark("the ripple: outline v1 → v2; 05 reads “Board and case rebuilding for 40 mm wide”")
			await until(page, `/40 mm/.test(document.getElementById("rip-text").textContent) && document.getElementById("rip-result").className === "consistent"`, 10 * 60_000)
			mark("05: “40 mm wide: board, case and firmware agree” · the proof line: without the shared contract, 4 mismatches would ship")
			await page.waitForTimeout(4000)
			const u1 = page.locator('.pcb-root [data-ref="U1"]').first()
			const b = await u1.boundingBox().catch(() => null)
			if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 30 })
			mark("the PCB at 40 mm: rulers, U1's size on hover")
			await page.waitForTimeout(3000)
			await glide(page, "#why-btn")
			await page.click("#why-btn")
			mark("What changed & why: outline 50×30 → 40×30 mm, the architect's reason, caused by the request")
			await page.waitForTimeout(5000)
		})

		// Act 1: the hub page, the evidence band, a slow scroll.
		await take(1, hubUrl, async (page) => {
			mark("the hub: Change one thing. The whole design follows.")
			await page.waitForTimeout(3000)
			for (let i = 0; i < 12; i++) {
				await page.mouse.wheel(0, 60)
				await page.waitForTimeout(180)
			}
			mark("the evidence band comes into view")
			await page.waitForTimeout(3000)
		})

		// Act 4: the evidence band, closing in on the J1 cutout row.
		await take(4, hubUrl, async (page) => {
			await page.locator("#proof").scrollIntoViewIfNeeded()
			mark("the evidence: 0 violations with the shared contract against the mismatches each team would ship")
			await page.waitForTimeout(3000)
			const row = page.locator(".proof-row", { hasText: "cutout for J1" }).first()
			const b = await row.boundingBox()
			if (b) {
				await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 30 })
				// A camera move onto the row: the page itself, scaled about that row (no overlay).
				const y = b.y + b.height / 2
				await page.evaluate(`(() => { const s = document.documentElement.style; s.transition = "transform 2.4s cubic-bezier(.2,.8,.2,1)"; s.transformOrigin = "50% " + (${y} + window.scrollY) + "px"; s.transform = "scale(1.9)" })()`)
			}
			mark("closing in on: cutout for J1 is left@15 mm, connector is bottom@25 mm")
			await page.waitForTimeout(5000)
		})
	} finally {
		await browser.close()
		// npx → tsx → demo: signal the whole group, or the demo outlives its wrapper.
		try { process.kill(-demo.pid!, "SIGTERM") } catch {}
		writeFileSync(join(out, "shots.md"), shotList(marks.sort((a, b) => a.act - b.act || a.atMs - b.atMs)))
		console.log(`footage: ${out}`)
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
