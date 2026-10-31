// The public demo (`cli.ts --public`): the hub, read-only, over recorded runs from docs/runs, plus an optional
// "Try it": a scripted, stubbed beacon run that takes one change from the scripted set. No model keys, no Ask, no
// bench, no ntfy, no ordering, no file sync: every POST but Try it answers 403 "read-only demo".
import { cpSync, existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const PUBLIC_BANNER = "Public demo: recorded runs used the real tools (KiCad, build123d, PlatformIO); live runs here are stubbed."

// Recorded runs worth replaying, from docs/runs (each has a trace.jsonl).
export const PUBLIC_RUNS = ["add-sensor", "add-sensor-real", "add-sensor-real-2", "real-20", "real-15", "linked", "file-sync", "wokwi"]

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url))

// Copies the recorded runs into the public out root (a tmp folder), so the hub serves them like any run.
export function preparePublicRoot(outRoot: string): string[] {
	const copied: string[] = []
	for (const id of PUBLIC_RUNS) {
		const from = join(REPO_ROOT, "docs/runs", id)
		if (!existsSync(join(from, "trace.jsonl"))) continue
		cpSync(from, join(outRoot, id), { recursive: true })
		copied.push(id)
	}
	return copied
}

// The changes the scripted agents act on (src/inference/scripts.ts): add a sensor, a width, a blink.
const SCRIPTED_CHANGES = [/^add .*(temp|humid|sensor)/i, /^make (it|the board) \d+(\.\d+)? ?mm wide$/i, /^blink faster( when tilted)?$/i]
const MAX_CHANGE_CHARS = 100

export interface GateRefusal {
	status: number
	error: string
}

// Try it's limits: one live run at a time for everyone, a few runs per IP per hour, one change per run.
export class PublicGate {
	readonly timeoutMs: number
	readonly cleanupMs: number
	private readonly now: () => number
	private readonly perIpPerHour: number
	private live = false
	private readonly starts = new Map<string, number[]>()
	private readonly changed = new Set<string>()

	constructor(opts: { now?: () => number; timeoutMs?: number; cleanupMs?: number; perIpPerHour?: number } = {}) {
		this.now = opts.now ?? Date.now
		this.timeoutMs = opts.timeoutMs ?? 3 * 60_000
		this.cleanupMs = opts.cleanupMs ?? 10 * 60_000
		this.perIpPerHour = opts.perIpPerHour ?? 5
	}

	admit(ip: string): GateRefusal | null {
		if (this.live) return { status: 409, error: "a live run is already going: watch it, or try again in a few minutes" }
		const hourAgo = this.now() - 3_600_000
		const recent = (this.starts.get(ip) ?? []).filter((t) => t > hourAgo)
		if (recent.length >= this.perIpPerHour) return { status: 429, error: `${this.perIpPerHour} runs an hour per visitor: try again later` }
		this.starts.set(ip, [...recent, this.now()])
		this.live = true
		return null
	}

	finished(): void {
		this.live = false
	}

	change(runId: string, text: string): GateRefusal | null {
		if (text.length > MAX_CHANGE_CHARS) return { status: 400, error: `a change is at most ${MAX_CHANGE_CHARS} characters` }
		if (this.changed.has(runId)) return { status: 409, error: "one change per run in the public demo" }
		if (!SCRIPTED_CHANGES.some((re) => re.test(text.trim()))) return { status: 400, error: 'the public demo takes the scripted changes: "add a temperature/humidity sensor", "make it 40 mm wide", "blink faster when tilted"' }
		this.changed.add(runId)
		return null
	}
}

// The visitor's address: the first X-Forwarded-For hop behind a proxy (Render), else the socket's.
export function clientIp(forwardedFor: string | string[] | undefined, socketIp: string | undefined): string {
	const first = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(",")[0]?.trim()
	return first || socketIp || "unknown"
}
