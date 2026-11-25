// The build package's assembly pictures (17 Nov 2026): the run's robot in the dashboard's 3D view, drawn up to each
// assembly step (world3d.js ASSEMBLY_STEPS, from the page URL's ?step=N) and once exploded, captured in headless
// Chromium into <package>/assembly/step-N-<name>.png and exploded.png. It shows the run's own built board and chassis
// (the package rebuilds the board on today's code; the pictures are for assembling, not for fabrication). Without
// Playwright's Chromium, or without a built robot in the run, no pictures, and the note says why.
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

export interface AssemblyPictures {
	files: string[]
	note: string | null
}

async function chromiumExe(): Promise<{ chromium: typeof import("playwright").chromium; exe: string } | null> {
	try {
		const { chromium } = await import("playwright")
		if (existsSync(chromium.executablePath())) return { chromium, exe: chromium.executablePath() }
		const cache = join(homedir(), ".cache", "ms-playwright")
		const exe = (existsSync(cache) ? readdirSync(cache) : []).filter((d) => /^chromium-\d+$/.test(d)).map((d) => join(cache, d, "chrome-linux64", "chrome")).find((p) => existsSync(p))
		return exe ? { chromium, exe } : null
	} catch {
		return null
	}
}

export async function assemblyPictures(runDir: string, outDir: string, log: (m: string) => void = () => {}): Promise<AssemblyPictures> {
	if (!existsSync(join(runDir, "trace.jsonl")) || !existsSync(join(runDir, "chassis"))) return { files: [], note: `no assembly pictures: ${runDir} is not a run with a built chassis` }
	const browser = await chromiumExe()
	if (!browser) return { files: [], note: "no assembly pictures: Playwright's Chromium is not installed (npx playwright install chromium)" }
	// The 3D page is Bringup's hosted page, not part of the npm package (25 Nov 2026, the open-core split): without it, no
	// pictures, and the note says why.
	// Named through variables so neither the compiler nor the public-tree filter needs the page to be there.
	const [server, world] = ["../dashboard/server.ts", "../dashboard/world3d.js"]
	const page = await Promise.all([import(server), import(world)]).catch(() => null)
	if (!page) return { files: [], note: "no assembly pictures: they are drawn by Bringup's 3D page, which this install doesn't include" }
	const [{ serveHub }, { ASSEMBLY_STEPS }] = page as [{ serveHub: (o: { outRoot: string; port: number }) => Promise<{ url: string; close: () => Promise<void> }> }, { ASSEMBLY_STEPS: string[] }]
	const hub = await serveHub({ outRoot: dirname(runDir), port: 0 })
	const b = await browser.chromium.launch({ executablePath: browser.exe, headless: true })
	const files: string[] = []
	try {
		mkdirSync(join(outDir, "assembly"), { recursive: true })
		const page = await b.newPage({ viewport: { width: 1200, height: 900 } })
		await page.addInitScript("window.__name = (f) => f")
		const shot = async (query: string, file: string) => {
			await page.goto(`${hub.url}/system?id=${encodeURIComponent(basename(runDir))}&${query}`)
			await page.waitForFunction(() => ((globalThis as unknown as { __worldStats?: () => { triangles: number } | undefined }).__worldStats?.()?.triangles ?? 0) > 0, null, { timeout: 60_000 })
			// Only the scene: the page's switches, badges and hints hidden (a picture for the builder, not of the dashboard).
			await page.addStyleTag({ content: "body * { visibility: hidden !important } #stage canvas { visibility: visible !important }" })
			// One frame after the scene is up, so the canvas holds it.
			await page.waitForTimeout(500)
			await page.locator("#stage canvas").first().screenshot({ path: join(outDir, "assembly", file) })
			files.push(`assembly/${file}`)
		}
		for (const [k, name] of ASSEMBLY_STEPS.entries()) await shot(`step=${k}`, `step-${k + 1}-${name}.png`)
		await shot("explode", "exploded.png")
		log(`assembly pictures: ${files.length} in ${join(outDir, "assembly")}`)
		return { files, note: null }
	} catch (e) {
		return { files, note: `assembly pictures stopped: ${String(e).split("\n")[0]}` }
	} finally {
		await b.close()
		await hub.close()
	}
}
