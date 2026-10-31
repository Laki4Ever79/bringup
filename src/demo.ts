import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { serveDashboard, type Dashboard, type HubLaunch } from "./dashboard/server.ts"
import { startRunProcess, type RunProcessArgs } from "./runner/spawn-run.ts"

export interface DemoOptions {
	real: boolean
	brief: string
	change: string | null
	afterS: number
	port: number
	open: boolean
}

export interface DemoDeps {
	launch: (args: RunProcessArgs, hooks: { onStdout: (chunk: string) => void }) => { done: Promise<{ code: number; stderr: string }>; kill?: () => void }
	outRoot: string
	log: (line: string) => void
	openUrl: (url: string) => void
}

export interface DemoResult {
	outDir: string
	code: number
	summary: string[]
	dashboard: Dashboard
}

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const USAGE = `usage: npm run demo -- [--real] [--brief briefs/logger.md] [--change "make the board 60 mm wide" | --no-change] [--after 8] [--port 4317] [--no-open]`

// Pure: argv (after `npm run demo --`) to options. Throws with a message on anything it doesn't understand.
export function parseDemoArgs(argv: string[]): DemoOptions {
	const o: DemoOptions = { real: false, brief: "briefs/logger.md", change: "make the board 60 mm wide", afterS: 8, port: 4317, open: true }
	const args = argv.flatMap((a) => (a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a]))
	for (let i = 0; i < args.length; i++) {
		const flag = args[i]
		const value = () => {
			const v = args[++i]
			if (v === undefined || (v.startsWith("--") && flag !== "--change")) throw new Error(`${flag} needs a value\n${USAGE}`)
			return v
		}
		const number = (min: number) => {
			const n = Number(value())
			if (!Number.isFinite(n) || n < min) throw new Error(`${flag} must be a number ≥ ${min}\n${USAGE}`)
			return n
		}
		switch (flag) {
			case "--real": o.real = true; break
			case "--mock": o.real = false; break
			case "--brief": o.brief = value(); break
			case "--change": {
				const text = value().trim()
				if (!text) throw new Error(`--change needs the request text\n${USAGE}`)
				o.change = text
				break
			}
			case "--no-change": o.change = null; break
			case "--after": o.afterS = number(0); break
			case "--port": o.port = number(0); break
			case "--no-open": o.open = false; break
			default: throw new Error(`unknown argument ${flag}\n${USAGE}`)
		}
	}
	return o
}

interface TraceLine {
	type: string
	payload: any
}

function parseTrace(text: string): TraceLine[] {
	return text.split("\n").flatMap((l) => {
		try {
			return l.trim() ? [JSON.parse(l) as TraceLine] : []
		} catch {
			return [] // a half-written last line
		}
	})
}

// Pure: the 5-line summary printed when the run exits.
export function summarize(traceText: string, code: number): string[] {
	const trace = parseTrace(traceText)
	const count = (type: string) => trace.filter((e) => e.type === type).length
	const decided = trace.filter((e) => e.type === "change.decided")
	const violations = new Set(trace.filter((e) => e.type === "consistency.checked").flatMap((e) => e.payload.violations.map((v: any) => `${v.kind}|${v.message}`)))
	const settled = trace.findLast((e) => e.type === "design.settled")?.payload
	const revision = settled?.revision ?? Math.max(0, ...trace.map((e) => (typeof e.payload?.revision === "number" ? e.payload.revision : 0)))
	const failed = count("artifact.failed")
	return [
		`settled: ${code === 0 ? "yes" : "no"} (exit ${code})`,
		`revision: ${revision}`,
		`change control: ${count("change.proposed")} held, ${decided.filter((e) => e.payload.approved).length} approved, ${decided.filter((e) => !e.payload.approved).length} rejected`,
		`violations caught: ${violations.size}`,
		`artifacts built: ${count("artifact.ready")}${failed ? ` (${failed} failed build${failed === 1 ? "" : "s"})` : ""}`,
	]
}

export const CLOUD_FILE = "cloud.jsonl"
const CLOUD_LINK = /mozaik cloud — watching live:\s*(\S+)/
const ANSI = /\x1b\[[0-9;]*m/g
const CLOUD_COUNT_EVERY_MS = 5000

// Picks Mozaik Cloud's per-loop "watching live" links out of the run's stdout. The first is printed in
// full; later ones are only counted (at most one count line per 5 s) so the terminal stays readable.
// Every URL goes to <outDir>/cloud.jsonl for the dashboard.
export function createCloudRelay(outDir: string, log: (line: string) => void, now: () => number = Date.now) {
	let partial = ""
	let total = 0
	let printedCount = 0
	let lastPrintAt = 0

	const printCount = () => {
		printedCount = total
		lastPrintAt = now()
		log(`+${total - 1} agent loops live in Mozaik Cloud`)
	}

	const line = (raw: string) => {
		const url = CLOUD_LINK.exec(raw.replace(ANSI, ""))?.[1]
		if (!url) return
		total++
		appendFileSync(join(outDir, CLOUD_FILE), JSON.stringify({ at: new Date().toISOString(), url }) + "\n")
		if (total === 1) {
			lastPrintAt = now()
			log(`Mozaik Cloud: ${url}`)
		} else if (now() - lastPrintAt >= CLOUD_COUNT_EVERY_MS) {
			printCount()
		}
	}

	return {
		write(chunk: string) {
			const lines = (partial + chunk).split("\n")
			partial = lines.pop()!
			for (const l of lines) line(l)
		},
		end() {
			if (partial) line(partial)
			partial = ""
			if (total > 1 && printedCount !== total) printCount()
		},
	}
}

const readTrace = (outDir: string) => (existsSync(join(outDir, "trace.jsonl")) ? readFileSync(join(outDir, "trace.jsonl"), "utf8") : "")

// The hub over out/, opened on this run. Runs started from its start screen use the same launcher.
async function startDashboard(outDir: string, port: number, launch: HubLaunch): Promise<Dashboard> {
	try {
		return await serveDashboard(outDir, port, launch)
	} catch (error) {
		// Another demo's dashboard still holds the port: take any free one instead.
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return serveDashboard(outDir, 0, launch)
		throw error
	}
}

// One-command demo: a run in its own process, the live dashboard on its output, and one engineer change request.
// The run sends it itself (--change), `afterS` seconds after the first design has settled, so the dashboard shows
// "Consistent at rev N" first and then the ripple. The run stays up after that (--stay) for changes typed on the
// dashboard, until Stop or Ctrl-C.
export async function runDemo(o: DemoOptions, deps: DemoDeps): Promise<DemoResult> {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
	const outDir = join(deps.outRoot, `demo-${stamp}`)
	mkdirSync(outDir, { recursive: true })
	const briefPath = join(outDir, "brief.md")
	copyFileSync(resolve(ROOT, o.brief), briefPath)

	const dashboard = await startDashboard(outDir, o.port, (args) => deps.launch(args, { onStdout: () => {} }))
	const pageUrl = `${dashboard.url}/?run=${encodeURIComponent(basename(outDir))}`
	deps.log(`dashboard: ${pageUrl}`)
	if (o.open) deps.openUrl(pageUrl)

	deps.log(`run: ${o.real ? "real models" : "mock models"}, brief ${o.brief}, output ${outDir}`)
	const cloud = createCloudRelay(outDir, deps.log)
	const extraArgs = ["--stay", ...(o.change ? ["--change", o.change, "--change-delay", String(o.afterS)] : [])]
	const run = deps.launch({ briefPath, mock: !o.real, outDir, extraArgs }, { onStdout: (chunk) => cloud.write(chunk) })
	// The hub knows it is live: "waiting for a change" once settled, and its Stop button ends it.
	dashboard.adopt(basename(outDir), run)
	if (o.change) deps.log(`engineer: "${o.change}", ${o.afterS} s after the design first settles`)
	deps.log("the run stays up after settling: change things from the dashboard; Stop there, or Ctrl+C, ends it")

	const { code, stderr } = await run.done
	cloud.end()
	if (code !== 0 && code !== 2) deps.log(`run failed (exit ${code}):\n${stderr.trimEnd().split("\n").slice(-15).join("\n")}`)
	const summary = summarize(readTrace(outDir), code)
	return { outDir, code, summary, dashboard }
}

function openInBrowser(url: string): void {
	if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return
	if (spawnSync("which", ["xdg-open"], { stdio: "ignore" }).status !== 0) return
	spawn("xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
}

async function main(): Promise<void> {
	let opts: DemoOptions
	try {
		opts = parseDemoArgs(process.argv.slice(2))
	} catch (error) {
		console.error((error as Error).message)
		process.exit(1)
	}
	let active: ReturnType<typeof startRunProcess> | null = null
	let dashboard: Dashboard | null = null
	process.on("SIGINT", () => {
		active?.kill()
		void (dashboard?.close() ?? Promise.resolve()).then(() => process.exit(0))
	})
	const r = await runDemo(opts, {
		launch: (args, hooks) => (active = startRunProcess(args, { onStdout: hooks.onStdout })),
		outRoot: join(ROOT, "out"),
		log: (line) => console.log(line),
		openUrl: openInBrowser,
	})
	dashboard = r.dashboard
	active = null
	console.log(`\nreport: ${join(r.outDir, "report.md")}`)
	for (const line of r.summary) console.log(`  ${line}`)
	console.log(`\ndashboard still serving at ${r.dashboard.url}; Ctrl+C to stop`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
