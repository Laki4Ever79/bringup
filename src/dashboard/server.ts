import { createReadStream, watch, type FSWatcher } from "node:fs"
import { open, readFile, realpath, stat } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { extname, join, resolve, sep } from "node:path"

const TRACE = "trace.jsonl"
const POLL_MS = 250 // fs.watch can miss appends on some filesystems; polling backs it up
const HEARTBEAT_MS = 15_000
const PAGE = new URL("./page.html", import.meta.url)
const PREVIEW = new URL("./preview.html", import.meta.url)
// Page modules served from this folder (and nothing else from it).
const MODULES = new Set(["lanes.js", "stl.js", "model.js", "pcb-view.js", "scene3d.js"])

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

// Live view of one run: GET / is the page, /events streams trace.jsonl as SSE (replay first, then
// follow), /files/* serves artifacts from the run directory.
export async function serveDashboard(runDir: string, port = 4317): Promise<Dashboard> {
	const dir = resolve(runDir)
	const clients = new Set<ServerResponse>()
	const frame = (line: string) => `data: ${line}\n\n`
	const tail = new TraceTail(join(dir, TRACE), (line) => {
		for (const c of clients) c.write(frame(line))
	})
	await tail.poll()

	const server = createServer(async (req, res) => {
		const path = (req.url ?? "/").split("?")[0]
		try {
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
				res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
				return res.end(await readFile(new URL(`.${path}`, import.meta.url)))
			}
			if (path === "/events") {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
				res.write(": replay\n\n")
				for (const line of tail.lines) res.write(frame(line))
				clients.add(res)
				req.on("close", () => clients.delete(res))
				return
			}
			if (path.startsWith("/files/")) {
				const file = await fileInRun(dir, path.slice("/files/".length))
				if (!file) return send(res, 404, "not found")
				res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" })
				createReadStream(file).pipe(res)
				return
			}
			send(res, 404, "not found")
		} catch (error) {
			if (!res.headersSent) send(res, 500, String(error))
			else res.end()
		}
	})

	let watcher: FSWatcher | null = null
	try {
		// Watch the directory, not the file, so a trace created after startup is still picked up.
		watcher = watch(dir, (_, name) => {
			if (name === TRACE) void tail.poll()
		})
	} catch {
		// The poll timer alone is enough.
	}
	const timer = setInterval(() => void tail.poll(), POLL_MS)
	const heartbeat = setInterval(() => {
		for (const c of clients) c.write(": ping\n\n")
	}, HEARTBEAT_MS)

	await new Promise<void>((ok, fail) => {
		server.once("error", fail)
		server.listen(port, "127.0.0.1", () => ok())
	})
	const { port: actual } = server.address() as AddressInfo

	return {
		url: `http://127.0.0.1:${actual}`,
		close: async () => {
			clearInterval(timer)
			clearInterval(heartbeat)
			watcher?.close()
			for (const c of clients) c.end()
			clients.clear()
			await new Promise<void>((ok) => server.close(() => ok()))
		},
	}
}
