// A machine-wide spend ledger and cap for real-model calls (the user, 14 Nov 2026: "I forbid you from wasting more
// than $30 dollars of OpenAI tokens"). Every recorded call (appendUsage: agents, the dashboard's Ask and plans, the
// part learner) also goes to one ledger shared by every worktree and session on this machine; with BRINGUP_SPEND_CAP_USD
// set, an agent's model call is refused once the ledger has reached the cap, and a run doesn't start past it.
// The ledger: BRINGUP_SPEND_LEDGER, or ~/.bringup/spend.jsonl (outside the repos, so no worktree resets it).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { UsageRecord } from "./usage.ts"

// Under `node --test` (NODE_TEST_CONTEXT) the default is a temp file: tests that record usage don't touch the real ledger.
export const ledgerPath = (env: Record<string, string | undefined> = process.env) =>
	env.BRINGUP_SPEND_LEDGER ?? (env.NODE_TEST_CONTEXT ? join(tmpdir(), `bringup-test-spend-${process.pid}.jsonl`) : join(homedir(), ".bringup", "spend.jsonl"))

// BRINGUP_SPEND_CAP_USD, else capUsd in cap.json beside the ledger (a machine-wide setting no worktree's .env carries).
export function spendCap(env: Record<string, string | undefined> = process.env): number | null {
	const v = Number(env.BRINGUP_SPEND_CAP_USD)
	if (env.BRINGUP_SPEND_CAP_USD) return Number.isFinite(v) && v >= 0 ? v : null
	try {
		const c = Number((JSON.parse(readFileSync(join(dirname(ledgerPath(env)), "cap.json"), "utf8")) as { capUsd?: unknown }).capUsd)
		return Number.isFinite(c) && c >= 0 ? c : null
	} catch {
		return null
	}
}

export function recordSpend(r: UsageRecord, where: string, env: Record<string, string | undefined> = process.env): void {
	const path = ledgerPath(env)
	mkdirSync(dirname(path), { recursive: true })
	appendFileSync(path, JSON.stringify({ at: r.at, usd: r.usd, model: r.model, source: r.source, where }) + "\n")
}

// The ledger's total. A call with an unknown price counts as the dearest call seen (never as free).
export function spentUsd(env: Record<string, string | undefined> = process.env): { usd: number; calls: number } {
	const path = ledgerPath(env)
	if (!existsSync(path)) return { usd: 0, calls: 0 }
	let usd = 0, calls = 0, dearest = 0, unknown = 0
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		if (!raw.trim()) continue
		try {
			const e = JSON.parse(raw) as { usd: number | null }
			calls++
			if (typeof e.usd === "number") {
				usd += e.usd
				dearest = Math.max(dearest, e.usd)
			} else unknown++
		} catch {
			// a half-written line
		}
	}
	return { usd: usd + unknown * dearest, calls }
}

export class SpendCapReached extends Error {}

// Throws when the cap is set and reached: the caller's model call doesn't happen.
export function checkSpend(env: Record<string, string | undefined> = process.env): void {
	const cap = spendCap(env)
	if (cap === null) return
	const { usd } = spentUsd(env)
	if (usd >= cap) throw new SpendCapReached(`spend cap reached: $${usd.toFixed(2)} of $${cap.toFixed(2)} (BRINGUP_SPEND_CAP_USD, ledger ${ledgerPath(env)}); no more model calls`)
}
