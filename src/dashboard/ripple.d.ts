export interface RippleCheck { key: string; label: string; state: "running" | "ok" | "warn" | "error"; detail: string; short?: string; seq?: number[] }
export interface Ripple {
	id: string
	text: string
	file: { name: string; path: string; revision: number; items: string[] } | null
	atMs: number
	fieldsChanged: string[]
	woke: string[]
	checked: string[]
	reading: string[]
	stayedIdle: string[]
	working: string[]
	violationsPeak: number
	violations: number[]
	consistentAtMs: number | null
	durationMs: number | null
	revisions: { from: number; to: number } | null
	checks: RippleCheck[]
	reviewFollowUps: { fieldsChanged: string[]; rounds: number }
	state: "sent" | "rippling" | "consistent" | "no-change" | "unsettled"
}
export interface RipplesFile { requests: { id: string; text: string; atMs: number; fieldsChanged: string[]; woke: string[]; checked?: string[]; stayedIdle: string[]; violationsPeak: number; consistentAtMs: number | null; durationMs: number | null }[] }
type Ev = { type: string; at: string; payload?: any }
export function runStart(events: Ev[]): number | null
export function liveRipples(events: Ev[], requests: { at: string; text: string; source?: { kind: string; path: string; revision: number; items?: string[] } }[], now?: number): Ripple[]
export function mergeRipples(live: Ripple[], file: RipplesFile | null, t0: number): Ripple[]
export interface Moved {
	outline: { before: { w: number; h: number }; after: { w: number; h: number } } | null
	connectors: { ref: string; kind: string; before: { edge: string; offsetMm: number; widthMm: number } | null; after: { edge: string; offsetMm: number; widthMm: number } | null }[]
	pins: { signal: string; before: number | null; after: number | null }[]
	parts: { ref: string; before: string | null; after: string | null }[]
	count: number
}
export function whatMoved(before: any, after: any): Moved
export interface StatusLine { state: "initial" | "rippling" | "sent" | "consistent" | "no-change" | "unsettled"; headline: string; detail: string }
export function statusLine(o: { ripple: Ripple | null; now?: number; stubbed?: boolean; violations?: { kind: string }[]; settled?: { settled: boolean; revision: number } | null; revision?: number; firstAtMs?: number | null; endAtMs?: number | null; workingCount?: number; open?: boolean; benchAsk?: string | null }): StatusLine
