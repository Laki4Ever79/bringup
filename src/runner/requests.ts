import { appendFileSync, watch, type FSWatcher } from "node:fs"
import { open, stat } from "node:fs/promises"
import { join } from "node:path"

export const REQUESTS_FILE = "requests.jsonl"
const POLL_MS = 250 // fs.watch can miss appends on some filesystems; polling backs it up

export interface ChangeRequest {
	at: string
	text: string
}

// Appends one engineer request for a running design to pick up (CLI and MCP request_change).
export function appendRequest(outDir: string, text: string): ChangeRequest {
	const request = { at: new Date().toISOString(), text }
	appendFileSync(join(outDir, REQUESTS_FILE), JSON.stringify(request) + "\n")
	return request
}

// Follows <outDir>/requests.jsonl from its start, calling onRequest once per complete line. A half-written
// last line waits for its newline; lines that are not {at, text} JSON are skipped.
export function watchRequests(outDir: string, onRequest: (r: ChangeRequest) => void): { close(): void } {
	return watchJsonl(outDir, REQUESTS_FILE, (raw) => {
		const r = raw as Partial<ChangeRequest>
		if (typeof r.text !== "string" || r.text.trim() === "") return null
		return { at: typeof r.at === "string" ? r.at : new Date().toISOString(), text: r.text }
	}, onRequest)
}

// Follows <outDir>/<file> from its start, calling onItem once per complete JSON line that `accept` turns into
// an item. A half-written last line waits for its newline; other lines are skipped.
export function watchJsonl<T>(outDir: string, file: string, accept: (raw: unknown) => T | null, onItem: (item: T) => void): { close(): void } {
	const path = join(outDir, file)
	let offset = 0
	let partial = ""
	let reading = false
	let again = false
	let closed = false

	const readNew = async () => {
		const size = await stat(path).then((s) => s.size, () => -1)
		if (size <= offset) return
		const fh = await open(path, "r")
		try {
			const buf = Buffer.alloc(size - offset)
			const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
			offset += bytesRead
			const lines = (partial + buf.subarray(0, bytesRead).toString("utf8")).split("\n")
			partial = lines.pop()!
			for (const raw of lines) {
				if (closed) return
				if (raw.trim() === "") continue
				let parsed: unknown
				try {
					parsed = JSON.parse(raw)
				} catch {
					console.error(`[${file}] skipping a line that is not JSON: ${raw.slice(0, 80)}`)
					continue
				}
				const item = accept(parsed)
				if (item !== null) onItem(item)
			}
		} finally {
			await fh.close()
		}
	}

	const poll = async () => {
		if (closed) return
		if (reading) {
			again = true
			return
		}
		reading = true
		try {
			do {
				again = false
				await readNew()
			} while (again && !closed)
		} catch (error) {
			console.error("[requests] read failed:", error)
		} finally {
			reading = false
		}
	}

	let watcher: FSWatcher | null = null
	try {
		// The directory, not the file: requests.jsonl usually doesn't exist until the first request.
		watcher = watch(outDir, (_, name) => {
			if (name === file) void poll()
		})
	} catch {
		// The poll timer alone is enough.
	}
	const timer = setInterval(() => void poll(), POLL_MS)
	void poll()

	return {
		close: () => {
			closed = true
			clearInterval(timer)
			watcher?.close()
		},
	}
}
