// The connector (Task 3 of the Studio plan): streams a run folder to Bringup Studio and applies Studio's commands back
// into it. Plain HTTPS: POST /api/connector/runs/:runId/sync with the folder's changes, and a long-polled
// GET /api/connector/runs/:runId/commands?after=<id> for what Studio wants appended.
//
// A run never fails because Studio is unreachable: every request is caught, both loops back off (to 30 s) and resume
// from the folder itself. There is no in-memory queue to lose: what was last confirmed sent is the only state, so after
// an outage the next scan sends whatever changed meanwhile. Commands already applied are kept in <run>/.studio/applied.json
// so a restart never applies one twice.
//
// Public, in the engine: never imports src/dashboard or cloud/. Never logs the token.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { applyCommands } from "./apply.ts"
import { diffFile, fileState, syncable, type Command, type FileChange, type FileState } from "./protocol.ts"

export const MAX_BACKOFF_MS = 30_000
// One sync request carries at most this much file data; the rest goes on the next tick.
export const MAX_BATCH_BYTES = 8 * 1024 * 1024
// A long poll is held by the server up to about 25 s; the client gives up a little later and asks again.
export const POLL_TIMEOUT_MS = 35_000

export interface ConnectorOpts {
	url: string
	token: string
	intervalMs?: number
	fetch?: typeof fetch
	log?: (m: string) => void
}

type Sent = FileState & { mtimeMs: number }

// Every file of the run worth sending, path relative with "/" separators. Skipped folders aren't walked at all.
function walk(root: string): { path: string; full: string; size: number; mtimeMs: number }[] {
	const out: { path: string; full: string; size: number; mtimeMs: number }[] = []
	const visit = (dir: string) => {
		let entries: import("node:fs").Dirent[]
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			const full = join(dir, e.name)
			const path = relative(root, full).split(sep).join("/")
			if (e.isDirectory()) {
				if (syncable(`${path}/x`, 0)) visit(full)
			} else if (e.isFile()) {
				try {
					const st = statSync(full)
					if (syncable(path, st.size)) out.push({ path, full, size: st.size, mtimeMs: st.mtimeMs })
				} catch {
					// gone between the listing and the stat: the next scan sees it as deleted
				}
			}
		}
	}
	visit(root)
	return out
}

const APPLIED = join(".studio", "applied.json")
function readApplied(runDir: string): { ids: string[]; last: string | null } {
	try {
		return JSON.parse(readFileSync(join(runDir, APPLIED), "utf8"))
	} catch {
		return { ids: [], last: null }
	}
}
function writeApplied(runDir: string, a: { ids: string[]; last: string | null }): void {
	mkdirSync(join(runDir, ".studio"), { recursive: true })
	writeFileSync(join(runDir, APPLIED), JSON.stringify(a))
}

export function startConnector(runDir: string, runId: string, opts: ConnectorOpts): { stop(): Promise<void>; synced(): Promise<void> } {
	const f = opts.fetch ?? fetch
	const base = opts.url.replace(/\/+$/, "")
	const headers = { authorization: `Bearer ${opts.token}`, "content-type": "application/json" }
	const interval = opts.intervalMs ?? 1000
	const log = opts.log ?? (() => {})
	const sent = new Map<string, Sent>()
	let stopped = false
	const cancel = new AbortController()
	let warned = false
	const unreachable = (what: string, e: unknown) => {
		// Once per outage, and never the token: only the URL and the error's message.
		if (!warned) log(`Bringup Studio unreachable (${what}: ${e instanceof Error ? e.message : String(e)}); the run goes on, retrying`)
		warned = true
	}
	const backoff = (n: number) => Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(n, 10))
	const sleep = (ms: number) => new Promise<void>((r) => {
		const t = setTimeout(r, ms)
		wake.push(() => (clearTimeout(t), r()))
	})
	const wake: (() => void)[] = []

	// One scan and send. Resolves true when the folder's changes all went up (or there were none).
	const syncOnce = async (): Promise<boolean> => {
		const files = walk(runDir)
		const now = new Set(files.map((x) => x.path))
		const changes: FileChange[] = []
		const after = new Map<string, Sent | null>()
		let bytes = 0
		for (const x of files) {
			const prev = sent.get(x.path)
			if (prev && prev.size === x.size && prev.mtimeMs === x.mtimeMs) continue
			let content: Buffer
			try {
				content = readFileSync(x.full)
			} catch {
				continue
			}
			const st = fileState(content)
			if (prev && prev.sha256 === st.sha256 && prev.size === st.size) {
				sent.set(x.path, { ...prev, mtimeMs: x.mtimeMs })
				continue
			}
			const c = diffFile(prev, content, x.path)
			const size = c.kind === "delete" ? 0 : c.data.length
			if (changes.length && bytes + size > MAX_BATCH_BYTES) break
			bytes += size
			changes.push(c)
			after.set(x.path, { ...st, mtimeMs: x.mtimeMs })
		}
		for (const p of sent.keys()) if (!now.has(p)) (changes.push({ path: p, kind: "delete" }), after.set(p, null))
		if (!changes.length) return true
		const res = await f(`${base}/api/connector/runs/${encodeURIComponent(runId)}/sync`, { method: "POST", headers, body: JSON.stringify({ changes }), signal: AbortSignal.timeout(60_000) })
		if (!res.ok) throw new Error(`sync answered HTTP ${res.status}`)
		await res.arrayBuffer().catch(() => undefined)
		for (const [p, s] of after) (s ? sent.set(p, s) : sent.delete(p))
		return after.size === changes.length && files.every((x) => sent.get(x.path)?.mtimeMs === x.mtimeMs)
	}

	let syncing: Promise<void> = Promise.resolve()
	const syncLoop = async () => {
		let fails = 0
		while (!stopped) {
			const p = syncOnce()
			syncing = p.then(() => undefined, () => undefined)
			try {
				await p
				fails = 0
				warned = false
				await sleep(interval)
			} catch (e) {
				unreachable("sync", e)
				await sleep(backoff(++fails))
			}
		}
	}

	const applied = readApplied(runDir)
	const seen = new Set(applied.ids)
	const commandLoop = async () => {
		let fails = 0
		while (!stopped) {
			try {
				const q = applied.last ? `?after=${encodeURIComponent(applied.last)}` : ""
				const res = await f(`${base}/api/connector/runs/${encodeURIComponent(runId)}/commands${q}`, { headers, signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]) })
				if (!res.ok) throw new Error(`commands answered HTTP ${res.status}`)
				const { commands } = (await res.json()) as { commands: Command[] }
				if (commands?.length) {
					applyCommands(runDir, commands, seen)
					applied.ids = [...seen].slice(-1000)
					applied.last = commands[commands.length - 1].id
					writeApplied(runDir, applied)
				} else await sleep(interval)
				fails = 0
			} catch (e) {
				if (stopped) break
				unreachable("commands", e)
				await sleep(backoff(++fails))
			}
		}
	}

	if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true })
	const loops = [syncLoop(), commandLoop()]
	return {
		// The current scan done (tests and the run's end use it).
		synced: () => syncing,
		// Stops both loops, then one last best-effort sync so Studio has the run's final state. Never throws.
		async stop() {
			stopped = true
			cancel.abort()
			for (const w of wake.splice(0)) w()
			await Promise.allSettled(loops)
			await syncOnce().catch((e) => unreachable("final sync", e))
		},
	}
}

// What a run starts (src/main.ts): the connector when a token exists and --offline isn't given, else nothing at all
// (no request is made without a token).
export function studioConnector(runDir: string, runId: string, opts: { offline: boolean; token: { url: string; token: string; account?: string } | null; intervalMs?: number; log?: (m: string) => void }): ReturnType<typeof startConnector> | null {
	if (opts.offline || !opts.token) return null
	return startConnector(runDir, runId, { url: opts.token.url, token: opts.token.token, ...(opts.intervalMs ? { intervalMs: opts.intervalMs } : {}), ...(opts.log ? { log: opts.log } : {}) })
}
