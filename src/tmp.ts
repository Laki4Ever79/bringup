import { readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Bringup's temp folders (/tmp/bringup-*: board builds, fab packages, driver tests, the tests' own) are removed by whoever
// made them, in a finally or on a clean exit. A process that is killed first (a timeout's SIGKILL, a cancelled test)
// never gets there, and its folders stayed: 32,044 of them filled the disk on 16 Nov 2026. So each run and each test file
// starts by sweeping the ones older than STALE_HOURS, which no live process still writes to (the longest board build
// takes minutes). BRINGUP_KEEP_TMP=1 keeps everything.
export const TEMP_PREFIX = "bringup-"
export const STALE_HOURS = 12

export function sweepStaleTemp(opts: { root?: string; olderThanHours?: number; now?: number; env?: NodeJS.ProcessEnv } = {}): string[] {
	const env = opts.env ?? process.env
	if (env.BRINGUP_KEEP_TMP) return []
	const root = opts.root ?? tmpdir()
	const cutoff = (opts.now ?? Date.now()) - (opts.olderThanHours ?? STALE_HOURS) * 3_600_000
	const removed: string[] = []
	let names: string[] = []
	try {
		names = readdirSync(root).filter((n) => n.startsWith(TEMP_PREFIX))
	} catch {
		return removed
	}
	for (const n of names) {
		const p = join(root, n)
		try {
			const st = statSync(p)
			if (!st.isDirectory() || st.mtimeMs > cutoff) continue
			rmSync(p, { recursive: true, force: true })
			removed.push(p)
		} catch {
			// gone already, or not ours to remove
		}
	}
	return removed
}
