// The system run's own trace (<out>/system-trace.jsonl): one line per board step, so the system page can show where
// every board of a robot is during a run without reading each board's trace. The lines come from the boards' traces
// (a build ready or failed, a boot, a settle) and from the system run itself (the body re-sent, the link tests, the
// system settling). The dashboard serves the file as a stream (GET /api/systems/:id/stream).
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readTrace } from "../runner/ripple.ts"

export const SYSTEM_TRACE = "system-trace.jsonl"

export type SystemStep = "contract" | "board" | "case" | "chassis" | "firmware" | "boot" | "drive" | "testkit" | "link" | "assembly" | "request" | "settled"
export type StepStatus = "started" | "ok" | "failed" | "not run"

export interface SystemTraceLine {
	at: string
	round: number
	// A board's name, or "system" for the run's own steps.
	board: string
	step: SystemStep
	status: StepStatus
	revision?: number
	detail?: string
}

const KIND_STEP: Record<string, SystemStep> = { board: "board", enclosure: "case", chassis: "chassis", firmware: "firmware", drive: "drive", testkit: "testkit" }

// One board trace event as a system line (without at/round/board), or null for events the system page doesn't show.
export function stepOf(event: { type: string; payload: unknown }): Omit<SystemTraceLine, "at" | "round" | "board"> | null {
	const p = event.payload as Record<string, unknown>
	if (event.type === "artifact.ready") {
		const step = KIND_STEP[String(p.kind)]
		if (!step) return null
		// The drive's result rides under its kind (builders.ts summary): pass, fail or not run.
		const summary = p[String(p.kind)] as { result?: string; failed?: string; reason?: string } | undefined
		const skipped = typeof p.skipped === "string" ? p.skipped : undefined
		const notRun = Boolean(skipped) || summary?.result === "not run"
		// A board with DRC errors was built but isn't one to order: the page shows it failed, with the count.
		const drc = p.drc as { errors?: number; firstError?: string | null } | undefined
		const drcErrors = step === "board" && (drc?.errors ?? 0) > 0
		const failed = summary?.result === "fail" || drcErrors
		const detail = skipped ?? (drcErrors ? `DRC: ${drc!.errors} error(s)${drc!.firstError ? `, first: ${drc!.firstError}` : ""}` : failed && summary?.failed ? `failed at ${summary.failed}` : undefined)
		return { step, status: notRun ? "not run" : failed ? "failed" : "ok", revision: Number(p.revision), ...(detail ? { detail } : {}) }
	}
	if (event.type === "artifact.failed") {
		const step = KIND_STEP[String(p.kind)]
		return step ? { step, status: "failed", revision: Number(p.revision), detail: String(p.error ?? "").split("\n")[0].slice(0, 200) } : null
	}
	if (event.type === "firmware.booted") return { step: "boot", status: p.booted ? "ok" : "failed", revision: Number(p.revision) }
	if (event.type === "design.settled") return { step: "settled", status: p.settled ? "ok" : "failed", revision: Number(p.revision) }
	if (event.type === "contract.changed") return { step: "contract", status: "ok", revision: Number(p.revision ?? p.version ?? 0), detail: String(p.field ?? "") }
	return null
}

export class SystemTrace {
	round = 0
	private readonly seen = new Map<string, number>()
	constructor(private readonly outDir: string) {}

	emit(line: Omit<SystemTraceLine, "at" | "round">): SystemTraceLine {
		const full: SystemTraceLine = { at: new Date().toISOString(), round: this.round, ...line }
		appendFileSync(join(this.outDir, SYSTEM_TRACE), JSON.stringify(full) + "\n")
		return full
	}

	// The board's trace events since the last follow, as system lines.
	follow(board: string, dir: string): SystemTraceLine[] {
		const trace = readTrace(dir)
		const from = this.seen.get(board) ?? 0
		this.seen.set(board, trace.length)
		const out: SystemTraceLine[] = []
		for (const e of trace.slice(from)) {
			const s = stepOf(e)
			if (s) out.push(this.emit({ board, ...s }))
		}
		return out
	}
}

// The lines written so far, from index `since` (the stream's replay).
export function readSystemTrace(outDir: string, since = 0): SystemTraceLine[] {
	const path = join(outDir, SYSTEM_TRACE)
	if (!existsSync(path)) return []
	const lines: SystemTraceLine[] = []
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		if (!raw.trim()) continue
		try {
			lines.push(JSON.parse(raw) as SystemTraceLine)
		} catch {
			// A half-written last line: the next read gets it whole.
		}
	}
	return lines.slice(since)
}
