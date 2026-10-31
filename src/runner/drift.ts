import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Drift you can follow: every saved generated file that runner/file-sync.ts saw, kept per run in <outDir>/drift.json.
// The run owns the file and rewrites it live; the hub and `bringup status` only read it, and the hub queues actions
// in drift-actions.jsonl for the run to carry out.

export const DRIFT_FILE = "drift.json"
export const DRIFT_ACTIONS_FILE = "drift-actions.jsonl"

export interface DriftEntry {
	id: string
	// Relative to the out dir.
	path: string
	savedAt: string
	// The revision the file was generated at, and the contract's when the save was seen.
	savedRevision: number
	designRevision: number
	// adopted: the edit mapped to a contract field and went out as the engineer's change request.
	kind: "not-in-contract" | "stale" | "adopted"
	items: string[]
	status: "open" | "adopted" | "reverted"
	requestId?: string
	// Whether the edit maps to a contract field, so it can be sent as a change request.
	adoptable: boolean
	note?: string
}

export interface DriftFile {
	// The run is up and acts on queued actions; false after run.ended.
	live: boolean
	entries: DriftEntry[]
}

export interface DriftAction {
	at: string
	driftId: string
	action: "revert" | "adopt"
}

export function readDrift(outDir: string): DriftFile {
	const path = join(outDir, DRIFT_FILE)
	if (!existsSync(path)) return { live: false, entries: [] }
	return JSON.parse(readFileSync(path, "utf8")) as DriftFile
}

export function writeDrift(outDir: string, d: DriftFile): void {
	const path = join(outDir, DRIFT_FILE)
	// Written whole and renamed, so a reader never sees half of it.
	writeFileSync(`${path}.tmp`, JSON.stringify(d, null, 2))
	renameSync(`${path}.tmp`, path)
}

// Why an entry can't be acted on, or null if it can.
export function actionRefused(d: DriftFile, entry: DriftEntry, action: DriftAction["action"]): string | null {
	if (!d.live) return "the run is not running, so nothing can act on its files"
	if (entry.status !== "open") return `${entry.id} is already ${entry.status}`
	if (action === "adopt" && !entry.adoptable) return "this edit isn't in the design contract: nothing to adopt"
	return null
}

// `bringup status <runDir>`: drifted files in the manner of git status.
export function driftStatusLines(d: DriftFile, where: string): string[] {
	const state = d.live ? "run is live" : "run has ended"
	if (d.entries.length === 0) return [`Drift in ${where} (${state}): nothing drifted.`]
	const lines = [`Drift in ${where} (${state}):`]
	for (const e of d.entries) {
		const why = e.kind === "stale" ? `stale, saved at rev ${e.savedRevision}, design at rev ${e.designRevision}` : e.kind === "not-in-contract" ? `not in the contract, saved at rev ${e.savedRevision}` : `saved at rev ${e.savedRevision}`
		const head = e.status === "adopted" && e.requestId ? `→ ${e.requestId} (${why})` : `(${why})`
		lines.push(`  ${e.status.padEnd(8)}  ${e.id}  ${e.path}  ${head}`)
		for (const item of e.items) lines.push(`              ${item}`)
	}
	return lines
}
