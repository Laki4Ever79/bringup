export interface RippleCheck { key: string; label: string; state: "running" | "ok" | "warn" | "error"; detail: string; seq?: number[] }
export interface Ripple {
	id: string
	text: string
	atMs: number
	fieldsChanged: string[]
	woke: string[]
	stayedIdle: string[]
	working: string[]
	violationsPeak: number
	violations: number[]
	consistentAtMs: number | null
	durationMs: number | null
	revisions: { from: number; to: number } | null
	checks: RippleCheck[]
	state: "sent" | "rippling" | "consistent" | "no-change" | "unsettled"
}
export interface RipplesFile { requests: { id: string; text: string; atMs: number; fieldsChanged: string[]; woke: string[]; stayedIdle: string[]; violationsPeak: number; consistentAtMs: number | null; durationMs: number | null }[] }
type Ev = { type: string; at: string; payload?: any }
export function runStart(events: Ev[]): number | null
export function liveRipples(events: Ev[], requests: { at: string; text: string }[], now?: number): Ripple[]
export function mergeRipples(live: Ripple[], file: RipplesFile | null, t0: number): Ripple[]
export function resultLine(r: Ripple, now?: number): { headline: string; detail: string; text: string }
export interface Moved {
	outline: { before: { w: number; h: number }; after: { w: number; h: number } } | null
	connectors: { ref: string; kind: string; before: { edge: string; offsetMm: number; widthMm: number } | null; after: { edge: string; offsetMm: number; widthMm: number } | null }[]
	pins: { signal: string; before: number | null; after: number | null }[]
	parts: { ref: string; before: string | null; after: string | null }[]
	count: number
}
export function whatMoved(before: any, after: any): Moved
