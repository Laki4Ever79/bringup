import { randomBytes } from "node:crypto"
import { createReadStream, mkdirSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import { open, readdir, readFile, realpath, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { basename, dirname, extname, join, resolve, sep } from "node:path"
import { appendDecision } from "../runner/decisions.ts"
import { appendRequest } from "../runner/requests.ts"
import type { RunProcessArgs } from "../runner/spawn-run.ts"

const TRACE = "trace.jsonl"
const POLL_MS = 250 // fs.watch can miss appends on some filesystems; polling backs it up
const HEARTBEAT_MS = 15_000
const PAGE = new URL("./page.html", import.meta.url)
const PREVIEW = new URL("./preview.html", import.meta.url)
const BRIEFS = new URL("../../briefs/", import.meta.url)
// Page modules served from this folder (and nothing else from it).
const MODULES = new Set(["lanes.js", "stl.js", "model.js", "pcb-view.js", "scene3d.js"])
const RUN_ID = /^[\w-]+$/
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
async function fileInRun(runDir: string, rel: string): Promise<string | null> {
	let decoded: string
	try {
		decoded = decodeURIComponent(rel)
	} catch {
		return null
	}
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
}

interface RunSummary {
	runId: string
	status: "running" | "settled" | "unsettled" | "failed" | "stopped"
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
// /api/runs/<id>/requests and /decisions take the engineer's input, /runs/<id>/events streams a run's trace
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
		for (const l of traceText.split("\n")) {
			if (!l.trim()) continue
			try {
				const e = JSON.parse(l)
				startedAt ??= e.at
				if (typeof e.payload?.revision === "number") revision = Math.max(revision, e.payload.revision)
				if (e.type === "design.settled") settled = e.payload.settled === true
			} catch {}
		}
		const brief = await readFile(join(dir, "brief.md"), "utf8").catch(() => "")
		const title = (brief.split("\n").find((l) => l.trim()) ?? id).replace(/^#+\s*/, "").trim().slice(0, 80)
		const run = live.get(id)
		const status: RunSummary["status"] =
			run && run.exit === null ? "running" : settled !== null ? (settled ? "settled" : "unsettled") : run ? (run.exit === 0 ? "settled" : run.exit === 2 ? "unsettled" : "failed") : "stopped"
		return { runId: id, status, revision, startedAt: startedAt ?? (await stat(dir)).mtime.toISOString(), title }
	}

	const listRuns = async (): Promise<RunSummary[]> => {
		const out: RunSummary[] = []
		for (const name of await readdir(outRoot)) {
			const dir = await runDir(name)
			if (dir) out.push(await summarize(name, dir))
		}
		return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_RUNS_LISTED)
	}

	const startRun = (body: Record<string, unknown>): string => {
		if (!opts.launch) throw new HttpError(404, "this dashboard can't start runs")
		const brief = text(body.brief, "brief", 20_000)
		const mock = bool(body.mock, "mock")
		const hardware = bool(body.hardware, "hardware")
		const review = bool(body.review, "review")
		const engineerApproval = bool(body.engineerApproval, "engineerApproval")
		const runId = newRunId()
		const outDir = join(outRoot, runId)
		mkdirSync(outDir, { recursive: true })
		const briefPath = join(outDir, "brief.md")
		writeFileSync(briefPath, brief.endsWith("\n") ? brief : brief + "\n")
		const extraArgs = [...(hardware ? [] : ["--no-hardware"]), ...(review ? [] : ["--no-review"]), ...(engineerApproval ? ["--engineer-approval"] : [])]
		const run = opts.launch({ briefPath, mock, outDir, extraArgs })
		const entry = { exit: null as number | null, kill: run.kill }
		live.set(runId, entry)
		void run.done.then(({ code }) => (entry.exit = code), () => (entry.exit = 1))
		return runId
	}

	const allowedHost = (host: string | undefined) => ["127.0.0.1", "localhost", "[::1]"].some((h) => host === `${h}:${port}`)

	const server = createServer(async (req, res) => {
		const path = (req.url ?? "/").split("?")[0]
		try {
			if (!allowedHost(req.headers.host)) return json(res, 403, { error: "loopback only" })
			if (req.method === "POST") {
				const origin = req.headers.origin
				if (origin !== undefined && !allowedHost(origin.replace(/^http:\/\//, ""))) return json(res, 403, { error: "cross-site request" })
				if (path === "/api/runs") return json(res, 201, { runId: startRun(await readJson(req)) })
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
			if (req.method !== "GET") return send(res, 405, "method not allowed")
			if (path === "/") {
				res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" })
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
			if (path === "/api/runs") return json(res, 200, await listRuns())
			if (path === "/api/briefs") return json(res, 200, await listBriefs())
			if (path === "/api/hub") return json(res, 200, { defaultRun: opts.defaultRun?.id ?? null, canStart: Boolean(opts.launch) })

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
		server.once("error", fail)
		server.listen(port, "127.0.0.1", () => ok())
	})
	port = (server.address() as AddressInfo).port

	return {
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

// Live view of one run: the hub over its parent folder, with /events and /files/* serving this run.
export async function serveDashboard(runDir: string, port = 4317, launch?: HubLaunch): Promise<Dashboard> {
	const dir = resolve(runDir)
	return serveHub({ outRoot: dirname(dir), port, launch, defaultRun: { id: basename(dir), dir } })
}
