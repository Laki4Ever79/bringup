import { mkdtempSync, rmSync } from "node:fs"
import { sweepStaleTemp } from "../src/tmp.ts"
import { tmpdir } from "node:os"
import { join as joinPath } from "node:path"
import { createHuman, type SemanticEvent } from "@mozaik-ai/core"
import { join } from "../src/runtime.ts"

// Run plans a test makes (src/system/plan-gate.ts) stay out of the real ~/.bringup: one temporary folder per test
// process, inherited by the runs it spawns.
process.env.BRINGUP_RUN_PLANS ??= mkdtempSync(joinPath(tmpdir(), "bringup-test-plans-"))

// A brief whose "about W × H mm" becomes "exactly W × H mm": the scripted architect then keeps that very size (space
// rules: "about" is a limit, and a run on it ends compact). For tests whose subject is a change on the 50 × 30 mm board.
export function exactSize(brief: string): string {
	return brief.replace(/\babout (\d+(?:\.\d+)? × \d+(?:\.\d+)? mm)/, "exactly $1")
}

// Each test file's temp folders, removed when its process ends cleanly. They were never removed: 32,044 /tmp/bringup-*
// folders (some 780 MB, a board build or a mock run each) filled the disk on 16 Nov 2026. A file that fails keeps them,
// since its failures print their paths (BRINGUP_KEEP_TMP=1 keeps them always).
const made: string[] = []
// And the ones a killed test left behind, once per test file (src/tmp.ts).
sweepStaleTemp()
let cleanupArmed = false
export function tempDir(): string {
	const dir = mkdtempSync(joinPath(tmpdir(), "bringup-"))
	made.push(dir)
	if (!cleanupArmed) {
		cleanupArmed = true
		process.once("exit", (code) => {
			if (code !== 0 || process.exitCode || process.env.BRINGUP_KEEP_TMP) return
			for (const d of made) {
				try {
					rmSync(d, { recursive: true, force: true })
				} catch {
					// a folder a still-running child holds: left for the next clean
				}
			}
		})
	}
	return dir
}

// Joins a participant that records every event it sees, in delivery order.
export function recorder(): SemanticEvent[] {
	const seen: SemanticEvent[] = []
	join(
		createHuman({
			name: "recorder",
			capabilities: [],
			handlers: [{ specification: { isSatisfiedBy: () => true } as never, processor: { apply: ({ event }) => void seen.push(event) } }],
		}),
	)
	return seen
}

// Waits on the condition itself, polling, up to one generous ceiling (lead-2, 28 Nov 2026: fixed 2-8 s waits failed the
// scripted agents' tests whenever a board build loaded the machine; adopt itself failed 2 of 8). A loaded machine makes a
// test slower, never red. A test that wants longer still passes its own; a shorter one is raised to the ceiling.
// BRINGUP_TEST_WAIT_MS overrides it.
export const WAIT_CEILING_MS = Number(process.env.BRINGUP_TEST_WAIT_MS) || 60_000
export async function waitFor(check: () => boolean, timeoutMs = WAIT_CEILING_MS): Promise<void> {
	const ceiling = Math.max(timeoutMs, WAIT_CEILING_MS)
	const start = Date.now()
	while (!check()) {
		if (Date.now() - start > ceiling) throw new Error(`waitFor timed out after ${ceiling} ms`)
		await new Promise((r) => setTimeout(r, 10))
	}
}

// Tests that take minutes (whole runs, firmware builds, emulators, sweeps) skip in `npm test`. They run in
// `npm run test:slow`, and in `npm run test:affected` when their code changed (both set BRINGUP_SLOW=1).
export const slow: string | false = process.env.BRINGUP_SLOW === "1" ? false : "slow: runs in npm run test:slow, or test:affected when its code changes"
