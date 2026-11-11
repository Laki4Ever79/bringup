import { randomBytes, timingSafeEqual } from "node:crypto"
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import { open, readdir, readFile, realpath, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { basename, dirname, extname, join, resolve, sep } from "node:path"
import { appendDecision } from "../runner/decisions.ts"
import { appendRequest } from "../runner/requests.ts"
import { actionRefused, DRIFT_ACTIONS_FILE, readDrift, type DriftAction } from "../runner/drift.ts"
import { linkedInfo } from "../runner/linked.ts"
import { orderCheck, orderPackage } from "./order.ts"
import { addSpend, appendUsage, readSpend } from "../inference/usage.ts"
import { PlanConflict, PlanStore } from "./plans.ts"
import { exampleFile, listExamples } from "./examples.ts"
import { PlanInvalid } from "../system/architect.ts"
import { askPrompt, callModel, NoModelKey, revisionsToLoad, type AskPrompt } from "./ask.ts"
import type { RunProcessArgs } from "../runner/spawn-run.ts"
import type { TraceNotifier } from "./notify.ts"
import { clientIp, PUBLIC_BANNER, PUBLIC_TRY_IT, type PublicGate } from "./public.ts"

const TRACE = "trace.jsonl"
const POLL_MS = 250 // fs.watch can miss appends on some filesystems; polling backs it up
const HEARTBEAT_MS = 15_000
const PAGE = new URL("./page.html", import.meta.url)
const SYSTEM_PAGE = new URL("./system.html", import.meta.url)
const PLAN_PAGE = new URL("./plan.html", import.meta.url)
const START_PAGE = new URL("./start.html", import.meta.url)
const EXAMPLES = fileURLToPath(new URL("../../examples/", import.meta.url))
const STAGE_PAGE = new URL("./stage.html", import.meta.url)
const DESIGNS_PAGE = new URL("./designs.html", import.meta.url)
const PREVIEW = new URL("./preview.html", import.meta.url)
const BRIEFS = new URL("../../briefs/", import.meta.url)
const SYSTEM_SPECS = new URL("../../briefs/systems/", import.meta.url)
// af's A/B experiment (docs/experiment.md), committed so the hub can show the evidence without a run.
const EXPERIMENT = new URL("../../docs/experiment-results.json", import.meta.url)
const BENCH_SOURCES = ["real", "fake", "replay"] as const
// Page modules served from this folder (and nothing else from it).
const MODULES = new Set(["nav.js", "lanes.js", "stl.js", "model.js", "ripple.js", "rulers.js", "proof.js", "changelog.js", "pcb-view.js", "scene3d.js", "spend.js", "world3d.js", "plan-edit.js", "assembly.js", "drive.js"])
// Vendored OFL fonts (fonts/README.md), by exact name.
const FONTS = new Set(["BigShouldersDisplay.woff", "InstrumentSans.woff", "JetBrainsMono.woff"])
const RUN_ID = /^[\w-]+$/
// A board of a system: <system id>.<board name>, the run in <out>/<system>/boards/<name> (src/system/run.ts).
const BOARD_RUN_ID = /^([\w-]+)\.([\w-]+)$/
const PROPOSAL_ID = /^[\w-]{1,100}$/
const MAX_BODY = 64 * 1024
const MAX_TEXT = 2000
const MAX_RUNS_LISTED = 40

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".json": "application/json",
	".jsonl": "application/x-ndjson",
	".png": "image/png",
	".svg": "image/svg+xml",
	".stl": "model/stl",
	".step": "model/step",
	".txt": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".zip": "application/zip",
}

export interface Dashboard {
	url: string
	close(): Promise<void>
	// Tracks a run this process started some other way (npm run demo): its live status, and Stop reaches it.
	adopt(runId: string, run: { done: Promise<{ code: number }>; kill?: () => void }): void
	// With --lan: the random token a decision from another host (the phone) must carry as X-Bringup-Token.
	token?: string
}

// Follows trace.jsonl from byte 0, keeping every complete line for replay. A half-written last line waits
// in `partial` until its newline arrives.
class TraceTail {
	readonly lines: string[] = []
	private offset = 0
	private partial = ""
	private reading = false
	private again = false

	constructor(
		private readonly path: string,
		private readonly onLine: (line: string) => void,
	) {}

	async poll(): Promise<void> {
		if (this.reading) {
			this.again = true
			return
		}
		this.reading = true
		try {
			do {
				this.again = false
				await this.readNew()
			} while (this.again)
		} finally {
			this.reading = false
		}
	}

	private async readNew(): Promise<void> {
		const size = await stat(this.path).then((s) => s.size, () => -1)
		if (size < 0 || size === this.offset) return
		if (size < this.offset) {
			// Truncated or replaced: start over. Clients already shown the old lines keep them.
			this.offset = 0
			this.partial = ""
		}
		const fh = await open(this.path, "r")
		try {
			const buf = Buffer.alloc(size - this.offset)
			const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
			this.offset += bytesRead
			const chunks = (this.partial + buf.subarray(0, bytesRead).toString("utf8")).split("\n")
			this.partial = chunks.pop()!
			for (const line of chunks) {
				if (line.trim() === "") continue
				this.lines.push(line)
				this.onLine(line)
			}
		} finally {
			await fh.close()
		}
	}
}

// Resolves /files/<rel> to a real path inside runDir, or null. Rejects `..` segments outright and also
// checks the resolved real path, so a symlink can't point out of the run directory.
// A path segment from a URL, decoded; null for a malformed escape (decodeURIComponent throws on one), which every caller
// treats as a path that doesn't exist, never as a server error.
function safeDecode(s: string): string | null {
	try {
		return decodeURIComponent(s)
	} catch {
		return null
	}
}

async function fileInRun(runDir: string, rel: string): Promise<string | null> {
	const decoded = safeDecode(rel)
	if (decoded === null) return null
	if (decoded.includes("\0") || decoded.split(/[\\/]/).includes("..")) return null
	const root = await realpath(runDir)
	const target = await realpath(resolve(root, "." + sep + decoded)).catch(() => null)
	if (!target || !target.startsWith(root + sep)) return null
	const s = await stat(target).catch(() => null)
	return s?.isFile() ? target : null
}

function send(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(body)
}

function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value))
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
	}
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send application/json")
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += (chunk as Buffer).length
		if (size > MAX_BODY) throw new HttpError(413, `body over ${MAX_BODY} bytes`)
		chunks.push(chunk as Buffer)
	}
	try {
		const v = JSON.parse(Buffer.concat(chunks).toString("utf8"))
		if (v && typeof v === "object" && !Array.isArray(v)) return v
	} catch {}
	throw new HttpError(400, "body must be a JSON object")
}

function need<T>(ok: boolean, value: T, message: string): T {
	if (!ok) throw new HttpError(400, message)
	return value
}

const text = (v: unknown, name: string, max = MAX_TEXT, allowEmpty = false) =>
	need(typeof v === "string" && (allowEmpty || v.trim() !== "") && v.length <= max, v as string, `${name} must be a${allowEmpty ? "" : " non-empty"} string of at most ${max} characters`)
const bool = (v: unknown, name: string) => need(typeof v === "boolean", v as boolean, `${name} must be true or false`)

export type HubLaunch = (args: RunProcessArgs) => { done: Promise<{ code: number; stderr: string }>; kill?: () => void }

export interface HubOptions {
	// Directory holding one folder per run (out/).
	outRoot: string
	port?: number
	// Starts a run process (POST /api/runs). Without it the hub is read-only for new runs.
	launch?: HubLaunch
	// The run that /events and /files/* serve, for single-run dashboards and the demo.
	defaultRun?: { id: string; dir: string }
	// The model behind POST /api/runs/<id>/ask (tests inject one); by default the runs' own provider (ask.ts).
	ask?: (prompt: AskPrompt) => Promise<string>
	// The plan architect's environment and fetch (tests inject them; default: this process's env and fetch).
	planEnv?: Record<string, string | undefined>
	planFetch?: typeof fetch
	// The shipped examples for the start screen (default: the repo's examples/).
	examplesRoot?: string
	// --lan: listen on the network (bind, default every interface) so a phone can send decisions. Only the decision
	// route answers another host, and only with the hub's random token; everything else stays loopback-only.
	lan?: { bind?: string; token?: string }
	// Gets every trace line of the runs this hub follows (started here, adopted, or the default run): the ntfy push.
	notify?: TraceNotifier
	// --public (public.ts): any host may read; every POST is 403 "read-only demo" except Try it, a scripted stubbed run
	// of briefPath with one scripted change, within the gate's limits. Listens on bind (default every interface).
	public?: { gate: PublicGate; briefPath: string; bind?: string }
}

// What a scripted run says to a question: its agents don't reason, so there is nothing to ask them.
export const SCRIPTED_ANSWER = "Scripted mode: see the change log above. The scripted agents follow fixed scripts, so there is no model to ask; every write's reason and cause is listed there. Start a run with real models to ask questions."
const MAX_QUESTION = 500

interface RunSummary {
	runId: string
	// "bench live": settled, with its bring-up phase still running (--bench keeps the run up until Stop).
	// "waiting for a change": settled, and the run stays up (--stay) for the next change request until Stop.
	status: "running" | "bench live" | "waiting for a change" | "settled" | "unsettled" | "failed" | "stopped"
	bench: boolean
	// A scripted (--mock) run: no model calls, so nothing spent.
	scripted: boolean
	// Engineer change requests asked during the run, and the newest one's "consistent again in" time (ripples.json).
	changes: { count: number; lastDurationMs: number | null }
	revision: number
	startedAt: string
	title: string
}

function newRunId(): string {
	const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
	return `${t}-${randomBytes(3).toString("hex")}`
}

// The example briefs for the start screen: briefs/*.md except the folder's README.
async function listBriefs(): Promise<{ name: string; title: string; text: string }[]> {
	const names = (await readdir(BRIEFS).catch(() => [] as string[])).filter((n) => n.endsWith(".md") && n !== "README.md").sort()
	return Promise.all(
		names.map(async (name) => {
			const text = await readFile(new URL(name, BRIEFS), "utf8")
			const heading = text.split("\n").find((l) => l.trim()) ?? name
			return { name, title: heading.replace(/^#+\s*/, "").replace(/^Brief:\s*/i, "").trim(), text }
		}),
	)
}

// A hub over out/: GET / is the page (the page picks a run with ?run=<id>), /api/runs lists and starts runs,
// /api/runs/<id>/requests and /decisions take the engineer's input, /api/runs/<id>/drift lists the run's drifted files and
// /drift/<driftId>/revert|adopt queues an action on one, /runs/<id>/events streams a run's trace
// as SSE and /runs/<id>/files/* serves its artifacts. Loopback only: every request must carry a loopback Host
// (no DNS rebinding) and every POST must be same-origin JSON (no cross-site forms).
export async function serveHub(opts: HubOptions): Promise<Dashboard> {
	const outRoot = resolve(opts.outRoot)
	mkdirSync(outRoot, { recursive: true })
	const rootReal = await realpath(outRoot)
	const live = new Map<string, { exit: number | null; kill?: () => void }>()
	const streams = new Map<string, { tail: TraceTail; clients: Set<ServerResponse>; watcher: FSWatcher | null }>()
	const frame = (line: string) => `data: ${line}\n\n`
	let port = opts.port ?? 4317

	const streamFor = async (dir: string) => {
		let s = streams.get(dir)
		if (!s) {
			const clients = new Set<ServerResponse>()
			const tail = new TraceTail(join(dir, TRACE), (line) => {
				for (const c of clients) c.write(frame(line))
				void opts.notify?.(basename(dir), line)
			})
			let watcher: FSWatcher | null = null
			try {
				// The directory, not the file, so a trace created after startup is still picked up.
				watcher = watch(dir, (_, name) => {
					if (name === TRACE) void tail.poll()
				})
			} catch {
				// The poll timer alone is enough.
			}
			s = { tail, clients, watcher }
			streams.set(dir, s)
		}
		await s.tail.poll()
		return s
	}

	// A run folder under outRoot, by id: the id is never decoded and must match RUN_ID; the real path must stay inside.
	const runDir = async (id: string): Promise<string | null> => {
		const board = BOARD_RUN_ID.exec(id)
		if (board) {
			const real = await realpath(join(outRoot, board[1], "boards", board[2])).catch(() => null)
			if (!real || dirname(dirname(dirname(real))) !== rootReal) return null
			return (await stat(real)).isDirectory() ? real : null
		}
		if (!RUN_ID.test(id)) return null
		const real = await realpath(join(outRoot, id)).catch(() => null)
		if (!real || dirname(real) !== rootReal) return null
		return (await stat(real)).isDirectory() ? real : null
	}

	const summarize = async (id: string, dir: string): Promise<RunSummary> => {
		const traceText = await readFile(join(dir, TRACE), "utf8").catch(() => "")
		let revision = 0
		let startedAt: string | null = null
		let settled: boolean | null = null
		let bench = false
		let stay = false
		let changeCount = 0
		let scripted = false
		for (const l of traceText.split("\n")) {
			if (!l.trim()) continue
			try {
				const e = JSON.parse(l)
				startedAt ??= e.at
				// A bench event carries the board's booted rev (a replay's recorded one), not the contract's.
				if (typeof e.payload?.revision === "number" && !e.type.startsWith("bench.")) revision = Math.max(revision, e.payload.revision)
				if (e.type === "design.settled") settled = e.payload.settled === true
				if (e.type === "bench.connected") bench = true
				if (e.type === "run.started") {
					stay = e.payload?.stay === true
					scripted = e.payload?.mock === true
				}
				if (e.type === "change.requested") changeCount++
				// A change landed after settling: running again until it re-settles.
				if (e.type === "contract.changed" && stay) settled = null
			} catch {}
		}
		const brief = await readFile(join(dir, "brief.md"), "utf8").catch(() => "")
		const title = (brief.split("\n").find((l) => l.trim()) ?? id).replace(/^#+\s*/, "").replace(/^Brief:\s*/i, "").trim().slice(0, 80)
		const ripples = await readFile(join(dir, "ripples.json"), "utf8").then((t) => JSON.parse(t), () => null)
		const durations = (Array.isArray(ripples?.requests) ? ripples.requests : []).map((r: { durationMs?: unknown }) => r.durationMs).filter((d: unknown): d is number => typeof d === "number")
		const run = live.get(id)
		const status: RunSummary["status"] =
			run && run.exit === null ? (bench && settled !== null ? "bench live" : stay && settled !== null ? "waiting for a change" : "running") : settled !== null ? (settled ? "settled" : "unsettled") : run ? (run.exit === 0 ? "settled" : run.exit === 2 ? "unsettled" : "failed") : "stopped"
		return { runId: id, status, revision, startedAt: startedAt ?? (await stat(dir)).mtime.toISOString(), title, bench, scripted, changes: { count: changeCount, lastDurationMs: durations.at(-1) ?? null } }
	}

	const listRuns = async (): Promise<RunSummary[]> => {
		const out: RunSummary[] = []
		for (const name of await readdir(outRoot)) {
			const dir = await runDir(name)
			if (dir && name !== "plans" && !existsSync(join(dir, "system.json"))) out.push(await summarize(name, dir))
		}
		return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_RUNS_LISTED)
	}

	const plans = new PlanStore(outRoot, { env: opts.planEnv ?? process.env, fetchImpl: opts.planFetch })
	const planError = (res: ServerResponse, error: unknown) => {
		const e = error as Error & { status?: number; code?: string }
		if (e.code === "NO_KEY") return json(res, 400, { error: e.message, code: "NO_KEY" })
		if (error instanceof PlanInvalid) return json(res, 502, { error: e.message, code: e.code })
		if (error instanceof PlanConflict || typeof e.status === "number") return json(res, e.status ?? 500, { error: e.message })
		throw error
	}
	const startRun = (body: Record<string, unknown>): string => {
		if (!opts.launch) throw new HttpError(404, "this dashboard can't start runs")
		const brief = text(body.brief, "brief", 20_000)
		const mock = bool(body.mock, "mock")
		const hardware = bool(body.hardware, "hardware")
		const review = bool(body.review, "review")
		const engineerApproval = bool(body.engineerApproval, "engineerApproval")
		const bench = body.bench ?? false
		if (bench !== false && !BENCH_SOURCES.includes(bench as never)) throw new HttpError(400, `bench must be false or one of ${BENCH_SOURCES.join(", ")}`)
		const runId = newRunId()
		const outDir = join(outRoot, runId)
		mkdirSync(outDir, { recursive: true })
		const briefPath = join(outDir, "brief.md")
		writeFileSync(briefPath, brief.endsWith("\n") ? brief : brief + "\n")
		// Runs started here stay up after settling: the point is to change one thing and watch it follow.
		const extraArgs = ["--stay", ...(hardware ? [] : ["--no-hardware"]), ...(review ? [] : ["--no-review"]), ...(engineerApproval ? ["--engineer-approval"] : []), ...(bench ? ["--bench", bench as string] : [])]
		const run = opts.launch({ briefPath, mock, outDir, extraArgs })
		const entry = { exit: null as number | null, kill: run.kill }
		live.set(runId, entry)
		if (opts.notify) void streamFor(outDir)
		void run.done.then(({ code }) => (entry.exit = code), () => (entry.exit = 1))
		return runId
	}

	// Systems of boards (src/system): a folder under outRoot with system.json, its boards in boards/<name>, each an
	// ordinary run the run page opens as <system id>.<board name>.
	const systemDir = async (id: string): Promise<string | null> => {
		const dir = await runDir(id)
		return dir && !BOARD_RUN_ID.test(id) && existsSync(join(dir, "system.json")) ? dir : null
	}
	const readJsonFile = (path: string) => readFile(path, "utf8").then((t) => JSON.parse(t), () => null)
	const systemStatus = async (id: string, dir: string, state: { status?: string; settled?: boolean } | null) => {
		const run = live.get(id)
		if (run && run.exit === null) return { status: "running", settled: null }
		if (state?.status) return { status: state.status, settled: state.settled === true }
		// A system from before system-state.json: its report's status line.
		const line = (await readFile(join(dir, "system-report.md"), "utf8").catch(() => "")).split("\n").find((l) => l.startsWith("Status: "))
		if (line) return { status: line.slice("Status: ".length), settled: line.startsWith("Status: settled") }
		return { status: run ? "failed" : "stopped", settled: null }
	}
	const listSystems = async () => {
		const out: { id: string; name: string; boards: number; links: number; status: string; settled: boolean | null; startedAt: string }[] = []
		for (const name of await readdir(outRoot)) {
			const dir = await systemDir(name)
			if (!dir) continue
			const spec = await readJsonFile(join(dir, "system.json"))
			const st = await systemStatus(name, dir, await readJsonFile(join(dir, "system-state.json")))
			out.push({ id: name, name: spec?.name ?? name, boards: spec?.boards?.length ?? 0, links: spec?.links?.length ?? 0, ...st, startedAt: (await stat(join(dir, "system.json"))).mtime.toISOString() })
		}
		return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_RUNS_LISTED)
	}
	const systemDetail = async (id: string, dir: string) => {
		const spec = await readJsonFile(join(dir, "system.json"))
		const state = await readJsonFile(join(dir, "system-state.json"))
		const boards = await Promise.all(
			(spec?.boards ?? []).map(async (b: { name: string; run?: string }) => {
				const runId = `${id}.${b.name}`
				const bdir = await runDir(runId)
				if (!bdir) return { name: b.name, runId: null, imported: Boolean(b.run), status: b.run ? "imported" : "not started" }
				const summary = await summarize(runId, bdir)
				const contract = await readJsonFile(join(bdir, "contract.json"))
				const v = contract?.values ?? {}
				return {
					name: b.name,
					runId,
					imported: false,
					status: summary.status,
					revision: summary.revision,
					title: summary.title,
					outline: v.outline ? { widthMm: v.outline.widthMm, heightMm: v.outline.heightMm } : null,
					connectors: (v.connectors ?? []).map((c: { ref: string; kind: string; edge: string; offsetMm: number }) => ({ ref: c.ref, kind: c.kind, edge: c.edge, offsetMm: c.offsetMm })),
					pins: (v.pins ?? []).filter((p: { partRef: string }) => /^JL/.test(p.partRef)).map((p: { signal: string; gpio: number; partRef: string; partPin: string }) => ({ signal: p.signal, gpio: p.gpio, partRef: p.partRef, partPin: p.partPin })),
					render: existsSync(join(bdir, "board", "board.png")) ? `/runs/${runId}/files/board/board.png` : null,
					report: existsSync(join(bdir, "report.md")) ? `/runs/${runId}/files/report.md` : null,
					spend: readSpend(bdir),
					scripted: summary.scripted,
				}
			}),
		)
		const file = (name: string) => (existsSync(join(dir, name)) ? `/systems/${id}/files/${name}` : null)
		return {
			id,
			spec,
			...(await systemStatus(id, dir, state)),
			findings: state?.findings ?? (await readJsonFile(join(dir, "system-findings.json"))) ?? [],
			linkTests: state?.linkTests ?? [],
			asked: state?.asked ?? [],
			boards,
			scripted: boards.some((b) => "scripted" in b && b.scripted),
			spend: addSpend(readSpend(dir), ...boards.flatMap((b) => ("spend" in b && b.spend ? [b.spend] : []))),
			cable: await readFile(join(dir, "cable.md"), "utf8").catch(() => null),
			files: { report: file("system-report.md"), cable: file("cable.md"), wireviz: file("cable.yml"), bench: file("bench-plan.md") },
		}
	}
	// A one-board design, read as a design with one board (the page map, 11 Nov): the system page opens it on the same
	// Overview, with its board one level down. Its board is the run itself.
	const singleDir = async (id: string): Promise<string | null> => {
		const dir = await runDir(id)
		return dir && id !== "plans" && !BOARD_RUN_ID.test(id) && !existsSync(join(dir, "system.json")) ? dir : null
	}
	const singleDetail = async (id: string, dir: string) => {
		const summary = await summarize(id, dir)
		const v = (await readJsonFile(join(dir, "contract.json")))?.values ?? {}
		const report = existsSync(join(dir, "report.md")) ? `/runs/${id}/files/report.md` : null
		const board = {
			name: "main",
			runId: id,
			imported: false,
			status: summary.status,
			revision: summary.revision,
			title: summary.title,
			outline: v.outline ? { widthMm: v.outline.widthMm, heightMm: v.outline.heightMm } : null,
			connectors: (v.connectors ?? []).map((c: { ref: string; kind: string; edge: string; offsetMm: number }) => ({ ref: c.ref, kind: c.kind, edge: c.edge, offsetMm: c.offsetMm })),
			pins: [],
			render: existsSync(join(dir, "board", "board.png")) ? `/runs/${id}/files/board/board.png` : null,
			report,
			spend: readSpend(dir),
			scripted: summary.scripted,
		}
		return {
			id,
			single: true,
			spec: { name: summary.title, boards: [{ name: "main" }], links: [] },
			status: summary.status,
			settled: summary.status === "settled" || summary.status === "waiting for a change" || summary.status === "bench live",
			findings: [],
			linkTests: [],
			asked: [],
			boards: [board],
			scripted: summary.scripted,
			spend: readSpend(dir),
			cable: null,
			files: { report, cable: null, wireviz: null, bench: null },
		}
	}
	// Every design, newest first: systems and one-board designs in one list, each with its board count.
	const listDesigns = async () => {
		const systems = (await listSystems()).map((s) => ({ id: s.id, name: s.name, kind: "system" as const, boards: s.boards, status: s.status, settled: s.settled, startedAt: s.startedAt }))
		const singles = (await listRuns()).filter((r) => !BOARD_RUN_ID.test(r.runId)).map((r) => ({ id: r.runId, name: r.title, kind: "single" as const, boards: 1, status: r.status, settled: r.status === "settled", startedAt: r.startedAt }))
		return [...systems, ...singles].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_RUNS_LISTED)
	}
	const listSystemSpecs = async () => {
		const names = (await readdir(SYSTEM_SPECS).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort()
		return Promise.all(names.map(async (name) => ({ name, spec: JSON.parse(await readFile(new URL(name, SYSTEM_SPECS), "utf8")) })))
	}
	const startSystem = (body: Record<string, unknown>): string => {
		if (!opts.launch) throw new HttpError(404, "this dashboard can't start runs")
		const name = text(body.spec, "spec", 200)
		if (!/^[\w-]+\.json$/.test(name)) throw new HttpError(400, "spec must be a file name in briefs/systems")
		const specPath = resolve(fileURLToPath(SYSTEM_SPECS), name)
		if (!existsSync(specPath)) throw new HttpError(404, "no such system spec")
		return startSystemAt(specPath, { mock: bool(body.mock, "mock"), hardware: bool(body.hardware, "hardware"), review: bool(body.review, "review") })
	}
	// A system from a spec file: one in briefs/systems, or a plan's own system.json (plans.ts). `usagePath`: the plan's
	// architect calls, copied in so the system's spend includes them.
	const startSystemAt = (specPath: string, { mock, hardware, review }: { mock: boolean; hardware: boolean; review: boolean }, usagePath?: string): string => {
		if (!opts.launch) throw new HttpError(404, "this dashboard can't start runs")
		const id = `system-${newRunId()}`
		const outDir = join(outRoot, id)
		mkdirSync(outDir, { recursive: true })
		if (usagePath && existsSync(usagePath)) copyFileSync(usagePath, join(outDir, "usage.jsonl"))
		// `main.ts system <spec> …`: the launcher puts its first argument after main.ts.
		const run = opts.launch({ briefPath: "system", mock: false, outDir, extraArgs: [specPath, ...(mock ? ["--mock"] : []), ...(hardware ? [] : ["--no-hardware"]), ...(review ? [] : ["--no-review"])] })
		const entry = { exit: null as number | null, kill: run.kill }
		live.set(id, entry)
		void run.done.then(({ code }) => (entry.exit = code), () => (entry.exit = 1))
		return id
	}

	const allowedHost = (host: string | undefined) => ["127.0.0.1", "localhost", "[::1]"].some((h) => host === `${h}:${port}`)
	const token = opts.lan ? (opts.lan.token ?? randomBytes(24).toString("base64url")) : undefined
	const tokenOk = (given: string | string[] | undefined) => {
		if (!token || typeof given !== "string" || given.length !== token.length) return false
		return timingSafeEqual(Buffer.from(given), Buffer.from(token))
	}

	// The public demo's own routes; everything it doesn't handle falls through to the read-only GETs below.
	const publicRuns = new Set<string>()
	const READ_ONLY = Symbol("the read-only GET routes")
	const publicRoute = async (req: IncomingMessage, res: ServerResponse, path: string, pub: NonNullable<HubOptions["public"]>): Promise<unknown> => {
		if (req.method === "POST") {
			const origin = req.headers.origin
			if (origin !== undefined && origin.replace(/^https?:\/\//, "") !== req.headers.host) return json(res, 403, { error: "cross-site request" })
			if (path === "/api/runs") {
				if (!opts.launch) return json(res, 403, { error: "read-only demo" })
				const refused = pub.gate.admit(clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress))
				if (refused) return json(res, refused.status, { error: refused.error })
				const runId = newRunId()
				const outDir = join(outRoot, runId)
				mkdirSync(outDir, { recursive: true })
				copyFileSync(pub.briefPath, join(outDir, "brief.md"))
				const run = opts.launch({ briefPath: join(outDir, "brief.md"), mock: true, outDir, extraArgs: ["--stay", "--no-hardware", "--no-review"] })
				const entry = { exit: null as number | null, kill: run.kill }
				live.set(runId, entry)
				publicRuns.add(runId)
				const timer = setTimeout(() => run.kill?.(), pub.gate.timeoutMs)
				const end = (code: number) => {
					clearTimeout(timer)
					entry.exit = code
					publicRuns.delete(runId)
					pub.gate.finished()
					setTimeout(() => rmSync(outDir, { recursive: true, force: true }), pub.gate.cleanupMs).unref()
				}
				void run.done.then(({ code }) => end(code), () => end(1))
				return json(res, 201, { runId })
			}
			const change = /^\/api\/runs\/([^/]+)\/requests$/.exec(path)
			if (change && publicRuns.has(change[1])) {
				const dir = await runDir(change[1])
				if (!dir) return json(res, 404, { error: "unknown run" })
				const t = text((await readJson(req)).text, "text")
				const refused = pub.gate.change(change[1], t)
				if (refused) return json(res, refused.status, { error: refused.error })
				return json(res, 201, appendRequest(dir, t))
			}
			return json(res, 403, { error: "read-only demo" })
		}
		if (req.method !== "GET") return send(res, 405, "method not allowed")
		if (/^\/api\/runs\/[^/]+\/ready-to-order$/.test(path)) return json(res, 403, { error: "read-only demo" })
		// The page probes optional files (the report and the contract before a live run writes them, Cloud links, fab files, the BOM, change requests, lid vents, revision snapshots) that recorded runs
		// may not carry: an empty 204 instead of a 404, so a visitor's console stays clean. Anything else missing is a 404.
		if (path === "/favicon.ico") return send(res, 204, "")
		const probe = /^\/runs\/([^/]+)\/files\/(brief\.md|report\.md|contract\.json|cloud\.jsonl|fab\/README\.txt|bom\.json|requests\.jsonl|enclosure\/rev-\d+\/vents\.json|contracts\/rev-\d+\.json|drive\/rev-\d+\/(?:drive|trajectory)\.json)$/.exec(path)
		if (probe) {
			const dir = await runDir(probe[1])
			if (dir && !existsSync(join(dir, probe[2]))) return send(res, 204, "")
		}
		// The start screen, read-only: the examples stay, building is for one's own machine.
		if (path === "/" && !new URLSearchParams((req.url ?? "").split("?")[1] ?? "").has("run")) {
			const page = (await readFile(START_PAGE, "utf8")).replace(/<body[^>]*>/, (tag) => `${tag}<script>window.BRINGUP_PUBLIC = true</script><div id="public-banner" style="position:fixed;left:12px;bottom:12px;z-index:9999;max-width:560px;padding:6px 12px;font:13px/1.4 system-ui,sans-serif;background:#fff4d6;color:#4a3800;border:1px solid #e6cf8a;border-radius:4px">${PUBLIC_BANNER}</div>`)
			res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" })
			return res.end(page)
		}
		if (path === "/" || path === "/builds") {
			const page = (await readFile(PAGE, "utf8")).replace(/<body[^>]*>/, (tag) => `${tag}<script>window.BRINGUP_PUBLIC = true; addEventListener("DOMContentLoaded", () => { const n = document.getElementById("scripted-note"); if (n) n.textContent = "${PUBLIC_TRY_IT}"; const b = document.getElementById("brief-input"); if (b) b.readOnly = true })</script><style>#fab, #order-btn { display: none !important } #models, .switch[data-k], #scripted-pick, #examples, #stop-btn, #ask { display: none !important }</style><div id="public-banner" style="position:fixed;left:12px;bottom:12px;z-index:9999;max-width:560px;padding:6px 12px;font:13px/1.4 system-ui,sans-serif;background:#fff4d6;color:#4a3800;border:1px solid #e6cf8a;border-radius:4px">${PUBLIC_BANNER}</div>`)
			res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" })
			return res.end(page)
		}
		if (path === "/api/hub") return json(res, 200, { defaultRun: null, canStart: Boolean(opts.launch), public: true })
		return READ_ONLY
	}

	const server = createServer(async (req, res) => {
		const path = (req.url ?? "/").split("?")[0]
		try {
			if (opts.public && (await publicRoute(req, res, path, opts.public)) !== READ_ONLY) return
			// From another host (--lan, the phone's ntfy buttons): a decision with the token, and nothing else. In the
			// public demo every host may read (it only gets here for GETs).
			const fromLan = !opts.public && !allowedHost(req.headers.host)
			if (fromLan && !(req.method === "POST" && /^\/api\/runs\/[^/]+\/decisions$/.test(path) && tokenOk(req.headers["x-bringup-token"]))) return json(res, 403, { error: "loopback only" })
			if (req.method === "POST") {
				const origin = req.headers.origin
				if (!fromLan && origin !== undefined && !allowedHost(origin.replace(/^http:\/\//, ""))) return json(res, 403, { error: "cross-site request" })
				if (path === "/api/runs") return json(res, 201, { runId: startRun(await readJson(req)) })
				if (path === "/api/systems") return json(res, 201, { systemId: startSystem(await readJson(req)) })
				if (path === "/api/plans") {
					const body = await readJson(req)
					const sentence = text(body.sentence, "sentence", MAX_TEXT).trim()
					try {
						return json(res, 201, { id: (await plans.create(sentence, bool(body.mock, "mock"))).id })
					} catch (error) {
						return planError(res, error)
					}
				}
				const planPost = /^\/api\/plans\/(plan-[\w-]+)\/(change|build)$/.exec(path)
				if (planPost) {
					const body = await readJson(req)
					try {
						if (planPost[2] === "change") return json(res, 200, await plans.change(planPost[1], text(body.instruction, "instruction", MAX_TEXT).trim(), bool(body.mock, "mock"), typeof body.version === "number" ? body.version : undefined))
						const flags = { mock: bool(body.mock, "mock"), hardware: bool(body.hardware, "hardware"), review: bool(body.review, "review") }
						if (!flags.mock && !plans.hasModelKey()) return json(res, 400, { error: new NoModelKey().message, code: "NO_KEY" })
						const t = plans.buildTarget(planPost[1])
						if (t.kind === "system") return json(res, 201, { systemId: startSystemAt(t.specPath, flags, t.usagePath) })
						return json(res, 201, { runId: startRun({ brief: t.brief, ...flags, engineerApproval: false }) })
					} catch (error) {
						return planError(res, error)
					}
				}
				const stopSystem = /^\/api\/systems\/([^/]+)\/stop$/.exec(path)
				if (stopSystem) {
					if (!(await systemDir(stopSystem[1]))) return json(res, 404, { error: "unknown system" })
					const run = live.get(stopSystem[1])
					if (!run || run.exit !== null) return json(res, 409, { error: "that system is not running from this dashboard" })
					run.kill?.()
					return json(res, 200, { stopped: true })
				}
				const stop = /^\/api\/runs\/([^/]+)\/stop$/.exec(path)
				if (stop) {
					if (!(await runDir(stop[1]))) return json(res, 404, { error: "unknown run" })
					const run = live.get(stop[1])
					if (!run || run.exit !== null) return json(res, 409, { error: "that run is not running from this dashboard" })
					run.kill?.()
					return json(res, 200, { stopped: true })
				}
				const ask = /^\/api\/runs\/([^/]+)\/ask$/.exec(path)
				if (ask) {
					const dir = await runDir(ask[1])
					if (!dir) return json(res, 404, { error: "unknown run" })
					const body = await readJson(req)
					const question = text(body.question, "question", MAX_QUESTION).trim()
					const events = (await readFile(join(dir, TRACE), "utf8").catch(() => "")).split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : [] } catch { return [] } })
					if (events.find((e) => e.type === "run.started")?.payload?.mock === true) return json(res, 200, { scripted: true, answer: SCRIPTED_ANSWER })
					const revs = events.filter((e) => e.type === "contract.changed").map((e) => e.payload.revision as number)
					const to = typeof body.to === "number" ? body.to : Math.max(0, ...revs)
					const from = typeof body.from === "number" ? body.from : to - 1
					const snap = async (rev: number) => (rev > 0 ? readFile(join(dir, "contracts", `rev-${rev}.json`), "utf8").then((t) => JSON.parse(t), () => null) : null)
					const brief = ((await readFile(join(dir, "brief.md"), "utf8").catch(() => "")).split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").replace(/^Brief:\s*/i, "")
					try {
						// An older trace has no values in its writes: the revision snapshots give each one its change.
						const snapshots = new Map((await Promise.all(revisionsToLoad(events).map(async (rev) => [rev, await snap(rev)] as const))).filter(([, v]) => v))
						const answer = await (opts.ask ?? ((p: AskPrompt) => callModel(p, process.env, fetch, (r) => appendUsage(dir, r))))(askPrompt({ question, events, from: await snap(from), to: await snap(to), brief, snapshots }))
						return json(res, 200, { scripted: false, answer, from, to })
					} catch (error) {
						const e = error as Error & { code?: string }
						return e.code === "NO_KEY" ? json(res, 503, { error: new NoModelKey().message }) : json(res, 502, { error: e.message })
					}
				}
				// Drift you can follow (runner/drift.ts): the run carries out the action; the hub checks it and queues it.
				const d = /^\/api\/runs\/([^/]+)\/drift\/([\w-]+)\/(revert|adopt)$/.exec(path)
				if (d) {
					const dir = await runDir(d[1])
					if (!dir) return json(res, 404, { error: "unknown run" })
					const drift = readDrift(dir)
					const entry = drift.entries.find((e) => e.id === d[2])
					if (!entry) return json(res, 404, { error: "unknown drift entry" })
					const action = d[3] as DriftAction["action"]
					const refused = actionRefused(drift, entry, action)
					if (refused) return json(res, 409, { error: refused })
					appendFileSync(join(dir, DRIFT_ACTIONS_FILE), JSON.stringify({ at: new Date().toISOString(), driftId: entry.id, action }) + "\n")
					return json(res, 202, { queued: true, id: entry.id, action })
				}
				const m = /^\/api\/runs\/([^/]+)\/(requests|decisions)$/.exec(path)
				if (m) {
					const dir = await runDir(m[1])
					if (!dir) return json(res, 404, { error: "unknown run" })
					const body = await readJson(req)
					if (m[2] === "requests") return json(res, 201, appendRequest(dir, text(body.text, "text")))
					const decision = appendDecision(dir, {
						proposalId: need(typeof body.proposalId === "string" && PROPOSAL_ID.test(body.proposalId), body.proposalId as string, "proposalId is required"),
						approve: bool(body.approve, "approve"),
						reason: text(body.reason ?? "", "reason", MAX_TEXT, true),
					})
					return json(res, 201, decision)
				}
				return json(res, 404, { error: "not found" })
			}
			const planPut = /^\/api\/plans\/(plan-[\w-]+)$/.exec(path)
			if (req.method === "PUT" && planPut) {
				const origin = req.headers.origin
				if (origin !== undefined && !allowedHost(origin.replace(/^http:\/\//, ""))) return json(res, 403, { error: "cross-site request" })
				const body = await readJson(req)
				if (!body.plan || typeof body.plan !== "object") throw new HttpError(400, "plan must be an object")
				try {
					return json(res, 200, plans.put(planPut[1], body.plan as never))
				} catch (error) {
					return planError(res, error)
				}
			}
			if (req.method !== "GET") return send(res, 405, "method not allowed")
			if (planPut) {
				const v = plans.view(planPut[1])
				return v ? json(res, 200, v) : json(res, 404, { error: "unknown plan" })
			}
			if (/^\/plan\/plan-[\w-]+$/.test(path)) {
				res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" })
				return res.end(await readFile(PLAN_PAGE))
			}
			// The landing page is the start screen; a run (?run=, or the hub opened on one) and My builds (/builds) keep
			// the run page.
			if (path === "/" || path === "/builds") {
				const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "")
				res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" })
				if (path === "/" && !q.has("run") && !opts.defaultRun) return res.end(await readFile(START_PAGE))
				// Inside the system page (embed=1): the run page without its own way out; the system page owns that.
				if (q.get("embed") === "1") return res.end((await readFile(PAGE, "utf8")).replace(/<body[^>]*>/, (tag) => `${tag}<script>window.BRINGUP_EMBED = true</script>`))
				return res.end(await readFile(PAGE))
			}
			if (path === "/preview") {
				res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" })
				return res.end(await readFile(PREVIEW))
			}
			if (MODULES.has(path.slice(1))) {
				const source = await readFile(new URL(`.${path}`, import.meta.url)).catch(() => null)
				// pcb-view.js and scene3d.js are optional: the page falls back without them.
				if (!source) return send(res, 404, "not found")
				res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
				return res.end(source)
			}
			if (path.startsWith("/fonts/") && FONTS.has(path.slice("/fonts/".length))) {
				res.writeHead(200, { "content-type": "font/woff", "cache-control": "max-age=86400" })
				return res.end(await readFile(new URL(`.${path}`, import.meta.url)))
			}
			if (path === "/api/runs") return json(res, 200, await listRuns())
			// Ready to order (order.ts): the check for the button, and the zip itself, from the latest settled revision.
			const order = /^\/api\/runs\/([^/]+)\/ready-to-order(\/check)?$/.exec(path)
			if (order) {
				const dir = await runDir(order[1])
				if (!dir) return json(res, 404, { error: "unknown run" })
				if (order[2]) {
					const c = orderCheck(dir)
					return json(res, 200, c.ok ? { ok: true, revision: c.revision } : c)
				}
				const p = orderPackage(dir)
				if (!p.ok) return json(res, 409, { error: p.reason })
				res.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${p.name}"`, "cache-control": "no-store" })
				return res.end(p.zip)
			}
			const filesOf = /^\/api\/runs\/([^/]+)\/files$/.exec(path)
			if (filesOf) {
				const dir = await runDir(filesOf[1])
				return dir ? json(res, 200, { linked: linkedInfo(dir), entries: readDrift(dir).entries }) : json(res, 404, { error: "unknown run" })
			}
			const spendOf = /^\/api\/runs\/([^/]+)\/spend$/.exec(path)
			if (spendOf) {
				const dir = await runDir(spendOf[1])
				return dir ? json(res, 200, readSpend(dir)) : json(res, 404, { error: "unknown run" })
			}
			// The run's Mozaik Cloud link (cloud.jsonl's last url), or null: a run without the Cloud is normal, not a 404.
			const cloudOf = /^\/api\/runs\/([^/]+)\/cloud$/.exec(path)
			if (cloudOf) {
				const dir = await runDir(cloudOf[1])
				if (!dir) return json(res, 404, { error: "unknown run" })
				const urls = (await readFile(join(dir, "cloud.jsonl"), "utf8").catch(() => "")).split("\n").flatMap((l) => { try { const u = JSON.parse(l).url; return typeof u === "string" && /^https?:\/\//.test(u) ? [u] : [] } catch { return [] } })
				return json(res, 200, { url: urls.at(-1) ?? null })
			}
			const driftOf = /^\/api\/runs\/([^/]+)\/drift$/.exec(path)
			if (driftOf) {
				const dir = await runDir(driftOf[1])
				return dir ? json(res, 200, readDrift(dir)) : json(res, 404, { error: "unknown run" })
			}
			if (path === "/api/examples") return json(res, 200, listExamples(opts.examplesRoot ?? EXAMPLES))
			if (path.startsWith("/examples/")) {
				const rel = safeDecode(path.slice("/examples/".length))
				const file = rel === null ? null : exampleFile(opts.examplesRoot ?? EXAMPLES, rel)
				if (!file) return send(res, 404, "not found")
				// Revalidated by size and time, not cached blind by path: a re-saved example shows at once, and an unchanged
				// one costs a 304.
				const st = await stat(file)
				const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
				if (req.headers["if-none-match"] === etag) {
					res.writeHead(304, { etag, "cache-control": "no-cache" })
					return res.end()
				}
				res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", etag })
				return createReadStream(file).pipe(res)
			}
			if (path === "/api/briefs") return json(res, 200, await listBriefs())
			if (path === "/system") {
				res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" })
				return res.end(await readFile(SYSTEM_PAGE))
			}
			// Every design, one board or several (the page map, 11 Nov).
			if (path === "/designs") {
				res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" })
				return res.end(await readFile(DESIGNS_PAGE))
			}
			if (path === "/api/systems") return json(res, 200, await listSystems())
			if (path === "/api/designs") return json(res, 200, await listDesigns())
			if (path === "/api/system-specs") return json(res, 200, await listSystemSpecs())
			const sys = /^\/api\/systems\/([^/]+)$/.exec(path)
			if (sys) {
				const dir = await systemDir(sys[1])
				if (dir) return json(res, 200, await systemDetail(sys[1], dir))
				const one = await singleDir(sys[1])
				return one ? json(res, 200, await singleDetail(sys[1], one)) : json(res, 404, { error: "unknown design" })
			}
			const sysFile = /^\/systems\/([^/]+)\/files\/(system-report\.md|cable\.md|cable\.yml|bench-plan\.md|bench-plan\.json)$/.exec(path)
			if (sysFile) {
				const dir = await systemDir(sysFile[1])
				if (!dir || !existsSync(join(dir, sysFile[2]))) return send(res, 404, "not found")
				res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
				return res.end(await readFile(join(dir, sysFile[2])))
			}
			if (path === "/api/experiment") {
				const text = await readFile(EXPERIMENT, "utf8").catch(() => null)
				return text ? json(res, 200, JSON.parse(text)) : json(res, 404, { error: "no experiment results" })
			}
			if (path === "/api/hub") return json(res, 200, { defaultRun: opts.defaultRun?.id ?? null, canStart: Boolean(opts.launch) })
			// The talk's stage: three cards (stage.html); the finished runs come from <out>/stage.json, ids that exist only.
			if (path === "/stage") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
				return res.end(await readFile(STAGE_PAGE))
			}
			if (path === "/api/stage") {
				const saved = JSON.parse(await readFile(join(outRoot, "stage.json"), "utf8").catch(() => "{}"))
				const ok = async (v: unknown) => (typeof v === "string" && (await runDir(v)) ? v : null)
				return json(res, 200, { sensor: await ok(saved.sensor), board: await ok(saved.board) })
			}

			// Per-run routes, plus /events and /files/* for the default run.
			let dir: string | null = null
			let rest = path
			const m = /^\/runs\/([^/]+)(\/.*)$/.exec(path)
			if (m) {
				dir = await runDir(m[1])
				rest = m[2]
				if (!dir) return send(res, 404, "unknown run")
			} else if (opts.defaultRun) {
				dir = opts.defaultRun.dir
			}
			if (dir && rest === "/events") {
				const s = await streamFor(dir)
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
				res.write(": replay\n\n")
				for (const line of s.tail.lines) res.write(frame(line))
				s.clients.add(res)
				req.on("close", () => s.clients.delete(res))
				return
			}
			if (dir && rest.startsWith("/files/")) {
				const file = await fileInRun(dir, rest.slice("/files/".length))
				if (!file) return send(res, 404, "not found")
				res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" })
				createReadStream(file).pipe(res)
				return
			}
			send(res, 404, "not found")
		} catch (error) {
			if (error instanceof HttpError) return json(res, error.status, { error: error.message })
			if (!res.headersSent) send(res, 500, String(error))
			else res.end()
		}
	})

	if (opts.defaultRun) await streamFor(resolve(opts.defaultRun.dir))
	const timer = setInterval(() => {
		for (const s of streams.values()) void s.tail.poll()
	}, POLL_MS)
	const heartbeat = setInterval(() => {
		for (const s of streams.values()) for (const c of s.clients) c.write(": ping\n\n")
	}, HEARTBEAT_MS)

	await new Promise<void>((ok, fail) => {
		// A port that is taken (EADDRINUSE): stop the polling timers too, or they keep the process alive for nothing.
		server.once("error", (error) => {
			clearInterval(timer)
			clearInterval(heartbeat)
			fail(error)
		})
		server.listen(port, opts.public ? (opts.public.bind ?? "0.0.0.0") : opts.lan ? (opts.lan.bind ?? "0.0.0.0") : "127.0.0.1", () => ok())
	})
	port = (server.address() as AddressInfo).port

	return {
		adopt: (runId, run) => {
			const entry = { exit: null as number | null, kill: run.kill }
			live.set(runId, entry)
			void run.done.then(({ code }) => (entry.exit = code), () => (entry.exit = 1))
			if (opts.notify) void runDir(runId).then((dir) => (dir ? streamFor(dir) : null))
		},
		token,
		url: `http://127.0.0.1:${port}`,
		close: async () => {
			clearInterval(timer)
			clearInterval(heartbeat)
			for (const s of streams.values()) {
				s.watcher?.close()
				for (const c of s.clients) c.end()
			}
			streams.clear()
			for (const run of live.values()) if (run.exit === null) run.kill?.()
			await new Promise<void>((ok) => server.close(() => ok()))
		},
	}
}

// Starts a dashboard on `port`; if another process holds it (another hub, npm run demo), on a free port instead,
// saying so, rather than dying with EADDRINUSE.
export async function listenWithFallback(start: (port: number) => Promise<Dashboard>, port: number, log: (line: string) => void): Promise<Dashboard> {
	try {
		return await start(port)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
		const dash = await start(0)
		log(`dashboard: port ${port} is taken (another dashboard or npm run demo?), so this one is on ${new URL(dash.url).port}`)
		return dash
	}
}

// Live view of one run: the hub over its parent folder, with /events and /files/* serving this run.
export async function serveDashboard(runDir: string, port = 4317, launch?: HubLaunch, extra: Pick<HubOptions, "lan" | "notify"> = {}): Promise<Dashboard> {
	const dir = resolve(runDir)
	return serveHub({ outRoot: dirname(dir), port, launch, defaultRun: { id: basename(dir), dir }, ...extra })
}
