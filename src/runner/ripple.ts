import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { BUILD_INPUTS } from "../agents/builders.ts"
import type { ArtifactKind } from "../events.ts"

export const RIPPLES_FILE = "ripples.json"

export interface TraceEvent {
	seq?: number
	at: string
	type: string
	producerId?: string
	payload: any
}

// What one engineer change request set off, from the trace alone. Times are ms since run.started.
export interface Ripple {
	id: string
	text: string
	atMs: number
	// Contract fields bumped by this request and its follow-ups (until the next request).
	fieldsChanged: string[]
	// Participants that reworked something because of it: agents that changed or proposed a contract field, builders
	// whose inputs changed, grounding (parts or pins changed), consistency (any field changed).
	woke: string[]
	// Agents that took a turn on it but changed and proposed nothing.
	checked: string[]
	stayedIdle: string[]
	violationsPeak: number
	// When the design was consistent again after the last change in the window: the latest consistency check is clean
	// AND every woken builder has built (or failed) a revision that includes it, whichever of the two came later.
	// Checks are only emitted when the result changes, so a clean check can come before the builds finish.
	// null if the request changed nothing or never got there.
	consistentAtMs: number | null
	durationMs: number | null
	// After the first design.ready, a re-settle re-arms the brief review: what its fix rounds changed until the next
	// request. Kept apart, so the request's own ripple isn't inflated by review work, and nothing is hidden.
	reviewFollowUps: { fieldsChanged: string[]; rounds: number }
}

const KINDS: ArtifactKind[] = ["board", "enclosure", "firmware"]
const builderName = (kind: string) => `build:${kind}`

// Everyone a request could wake, keyed like the dashboard's lanes (src/dashboard/lanes.js): the four LLM agents by
// role, the three builders (the QEMU boot rides on build:firmware), the grounding check and the consistency check.
export const RIPPLE_PARTICIPANTS = ["architect", "parts", "firmware", "reviewer", ...KINDS.map(builderName), "grounding", "consistency"]

function ripple(window: TraceEvent[], request: TraceEvent, startMs: number, lastCheckClean: boolean): Omit<Ripple, "reviewFollowUps"> {
	const atMs = Date.parse(request.at) - startMs
	const fields: string[] = []
	const woke = new Set<string>()
	const turned = new Set<string>()
	// The revision each woken builder still has to reach.
	const pending = new Map<ArtifactKind, number>()
	let violationsPeak = 0
	let consistentAt: number | null = null
	// The newest check's result, carried in from before the request.
	let clean = lastCheckClean
	const reached = (e: TraceEvent) => {
		if (clean && pending.size === 0 && fields.length > 0 && consistentAt === null) consistentAt = Date.parse(e.at) - startMs
	}
	for (const e of window) {
		switch (e.type) {
			case "agent.activity":
				if (e.payload.phase === "turn") turned.add(e.payload.role)
				break
			case "change.proposed":
				woke.add(e.payload.by)
				break
			case "contract.changed": {
				if (!fields.includes(e.payload.field)) fields.push(e.payload.field)
				woke.add(e.payload.by)
				// The same situations the participants wake on: consistency on every change, grounding on parts and pins,
				// each builder on its inputs.
				woke.add("consistency")
				if (e.payload.field === "parts" || e.payload.field === "pins") woke.add("grounding")
				for (const kind of KINDS) {
					if (!BUILD_INPUTS[kind].includes(e.payload.field)) continue
					woke.add(builderName(kind))
					pending.set(kind, e.payload.revision)
				}
				consistentAt = null
				break
			}
			case "artifact.ready":
			case "artifact.failed":
				if (e.payload.revision >= (pending.get(e.payload.kind) ?? Infinity)) pending.delete(e.payload.kind)
				reached(e)
				break
			case "consistency.checked": {
				const n = e.payload.violations.length
				violationsPeak = Math.max(violationsPeak, n)
				clean = n === 0
				// A build that finished into new violations was not "consistent" after all.
				if (!clean) consistentAt = null
				reached(e)
				break
			}
		}
	}
	return {
		id: request.payload.id,
		text: request.payload.text,
		atMs,
		fieldsChanged: fields,
		// Only the 9 lanes: a change by anyone else (the bench) still wakes the builders, but is not a lane of its own.
		woke: RIPPLE_PARTICIPANTS.filter((p) => woke.has(p)),
		checked: RIPPLE_PARTICIPANTS.filter((p) => !woke.has(p) && turned.has(p)),
		stayedIdle: RIPPLE_PARTICIPANTS.filter((p) => !woke.has(p) && !turned.has(p)),
		violationsPeak,
		consistentAtMs: consistentAt,
		durationMs: consistentAt === null ? null : consistentAt - atMs,
	}
}

// One Ripple per change.requested. Its ripple runs to the first design.ready after it (consistent and quiet again,
// handed to the reviewer); the rest, up to the next request, is review follow-up. Pure: tests and the report use it
// on a trace file, the live recorder on the events it has seen so far.
export function changeRipples(trace: TraceEvent[]): Ripple[] {
	const starts = trace.map((e, i) => (e.type === "change.requested" ? i : -1)).filter((i) => i >= 0)
	if (starts.length === 0) return []
	const started = trace.find((e) => e.type === "run.started") ?? trace[0]
	const startMs = Date.parse(started.at)
	return starts.map((start, k) => {
		const lastCheck = trace.slice(0, start).findLast((e) => e.type === "consistency.checked")
		const window = trace.slice(start + 1, starts[k + 1] ?? trace.length)
		const ready = window.findIndex((e) => e.type === "design.ready")
		const own = ready < 0 ? window : window.slice(0, ready + 1)
		const after = ready < 0 ? [] : window.slice(ready + 1)
		const followFields = [...new Set(after.filter((e) => e.type === "contract.changed").map((e) => e.payload.field as string))]
		// Every review round of the re-armed review; the first one starts right at the window's design.ready.
		const rounds = (ready < 0 ? [] : window.slice(ready)).filter((e) => e.type === "review.completed").length
		return { ...ripple(own, trace[start], startMs, (lastCheck?.payload.violations.length ?? 1) === 0), reviewFollowUps: { fieldsChanged: followFields, rounds } }
	})
}

export function readTrace(outDir: string): TraceEvent[] {
	const path = join(outDir, "trace.jsonl")
	if (!existsSync(path)) return []
	return readFileSync(path, "utf8").split("\n").flatMap((l) => {
		try {
			return l.trim() ? [JSON.parse(l) as TraceEvent] : []
		} catch {
			return [] // a half-written last line
		}
	})
}

export function writeRipples(outDir: string, requests: Ripple[]): void {
	const path = join(outDir, RIPPLES_FILE)
	// Written whole and renamed, so a reader polling the file never sees half of it.
	writeFileSync(`${path}.tmp`, JSON.stringify({ requests }, null, 2))
	renameSync(`${path}.tmp`, path)
}

const RECOMPUTE_ON = new Set(["change.requested", "change.proposed", "contract.changed", "artifact.ready", "artifact.failed", "consistency.checked", "design.settled"])

// A plain-code participant that keeps <outDir>/ripples.json current: it records every event it sees and, once a
// change request has arrived, rewrites the file whenever one of the events a ripple depends on comes in.
export function createRippleRecorder(outDir: string): Human {
	const seen: TraceEvent[] = []
	let requested = false
	return createHuman({
		name: "ripples",
		capabilities: [],
		handlers: [
			{
				specification: { isSatisfiedBy: () => true } as never,
				processor: {
					apply: ({ event }) => {
						seen.push({ at: event.occurredAt.toISOString(), type: event.type, producerId: event.producerId, payload: event.payload })
						if (event.type === "change.requested") requested = true
						// An agent's turn changes woke/checked even when it changes nothing, so turns rewrite the file too.
						const turn = event.type === "agent.activity" && (event.payload as { phase?: string }).phase === "turn"
						if (requested && (RECOMPUTE_ON.has(event.type) || turn)) writeRipples(outDir, changeRipples(seen))
					},
				},
			},
		],
	})
}
