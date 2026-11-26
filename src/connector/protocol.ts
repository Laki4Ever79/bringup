// The mirror protocol between a run on the user's machine and Bringup Studio (docs/superpowers/plans/2026-11-26-
// bringup-studio-hosted.md, Task 1). The connector sends a run folder's changes up as FileChanges and takes Studio's
// commands back down as lines for the files the hub appends. Plain data over HTTPS: no WebSocket, no new dependency.
//
// This file is public, in the engine: it must never import src/dashboard (the private page) or cloud/ (the server).
import { createHash } from "node:crypto"

export type FileState = { size: number; sha256: string }

// A change to one file of the run, path relative to the run folder with "/" separators. "append": the file grew and
// what was there is unchanged, so only the new bytes go up (a trace.jsonl growing by one event). "put": the whole file
// (a new file, a rewritten contract.json, a file that shrank). "delete": it's gone. data is base64.
export type FileChange = { path: string; kind: "append"; offset: number; data: string } | { path: string; kind: "put"; sha256: string; data: string } | { path: string; kind: "delete" }

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex")

export function fileState(content: Buffer): FileState {
	return { size: content.length, sha256: sha256(content) }
}

// What changed between the state last sent and the file's content now. An append only when the file grew and its first
// prev.size bytes hash to what was sent: a file rewritten to something longer is a put, never an append on a stale
// prefix.
export function diffFile(prev: FileState | undefined, next: Buffer, path: string): FileChange {
	if (prev && next.length > prev.size && sha256(next.subarray(0, prev.size)) === prev.sha256) return { path, kind: "append", offset: prev.size, data: next.subarray(prev.size).toString("base64") }
	return { path, kind: "put", sha256: sha256(next), data: next.toString("base64") }
}

// Build products and caches stay on the machine: a firmware build's .pio folder, node_modules, the package's .work,
// linker outputs, the connector's own bookkeeping (.studio/), a firmware image over 4 MB and anything over 32 MB (a
// recorded simulation video).
const SKIP_DIRS = new Set([".pio", "node_modules", ".work", ".studio", ".git"])
export const MAX_FILE_BYTES = 32 * 1024 * 1024
export const MAX_BIN_BYTES = 4 * 1024 * 1024
export function syncable(path: string, size: number): boolean {
	const parts = path.split(/[\\/]/)
	if (parts.some((p) => SKIP_DIRS.has(p))) return false
	const name = parts[parts.length - 1]
	if (name.endsWith(".elf")) return false
	if (name.endsWith(".bin") && size > MAX_BIN_BYTES) return false
	return size <= MAX_FILE_BYTES
}

// The files the hub appends to a run (src/runner/requests.ts, decisions.ts, steer.ts, drift.ts; src/system/run.ts):
// the only ones Studio's commands may write.
export const WRITEBACK_FILES = ["requests.jsonl", "decisions.jsonl", "steer.jsonl", "drift-actions.jsonl", "system-requests.jsonl"] as const
export type WritebackFile = (typeof WRITEBACK_FILES)[number]

// One line Studio wants appended to one of those files; id is the server's, unique per run, so a command applied twice
// lands once.
export type Command = { file: WritebackFile; line: string; id: string }
