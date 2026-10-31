export const AGENT_COLORS: Record<string, string>
export function scrubberModel(events: any[]): { dots: any[]; boards: number[] }
export function boardFor(model: { boards: number[] }, revision: number): number | null
export function contractDiff(field: string, before: any, after: any): string[]
export function changedRefs(before: any, after: any): string[]
export function prCards(events: any[], snapshots: Map<number, any>): any[]
export function checkPills(events: any[]): any[]
export function parseBattery(reportText: string): { days: number; targetDays: number | null } | null
export function benchState(events: any[]): { source: "real" | "fake" | "replay"; meter: boolean; ports: any; flash: any; verdict: any; measured: any; instruction: { revision: number | null; action: string; text: string } | null; blink: { revision: number; source: string; blinkMs: number | null; tiltBlinkMs: number | null; expected: { blinkMs: number; tiltBlinkMs: number; tiltDeg: number }; pass: boolean; detail: string } | null } | null
export function flashSteps(flash: any): { key: string; label: string; state: "done" | "active" | "failed" | "todo" }[]
export function attitude(ax: number, ay: number, az: number): { pitch: number; roll: number }
export function lowPass(prev: { pitch: number; roll: number }, next: { pitch: number; roll: number }, k: number): { pitch: number; roll: number }
export class TelemetryBuffer {
	constructor(windowMs?: number)
	windowMs: number
	current: { at: number; mA: number }[]
	tilt: { at: number; tilt: number }[]
	led: { at: number; led: number; shake?: number }[]
	lastImu: { ax: number; ay: number; az: number; at: number } | null
	imu: boolean | null
	shake: boolean | null
	add(samples: any[]): void
}
export function safeUrl(url: unknown): string | null
export function sourcingRows(item: any): {
	sources: { supplier: string; url: string | null; stock: string; price: string; note: string | null }[]
	alternatives: { mpn: string; lcsc: string | null; stock: string; price: string }[]
}
export function readinessLine(readiness: any, ref: string): { status: string; warn: boolean } | null
export function statusLedRef(contract: any): string | null
export function ledMirror(input: { contract: any; bench: any; led: { at: number; led: number; shake?: number }[] }): { ref: string; on: boolean; color: "red" | "green"; label: string } | null
export function relativeGravity(g0: number[], g: number[]): number[]
export function toggleOpen(open: string | null, clicked: string | null): string | null
export function readinessShort(readiness: { supplier: string; total: number; counts: { listed: number }; lines?: { ref: string; status: string }[] } | null): string
export function runPhase(s: { settled: { settled: boolean } | null; stay: boolean; alive: boolean; benchLive: boolean; stopped: boolean }): { bar: "live" | "bench" | "waiting" | "stopped" | "settled"; pill: string; open: boolean }
export function composerPrompt(bar: string, settled: { settled: boolean } | null, opts?: { scripted?: boolean }): string
export function foldHeader(kind: "parts" | "revisions", data?: { count?: number; totalUsd?: number | null }): string
export interface FoldStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }
export function foldOpen(storage: FoldStorage | null | undefined, kind: string): boolean
export function setFold(storage: FoldStorage | null | undefined, kind: string, open: boolean): void
export function youTile(o?: { ripple?: { text: string; file: { name: string } | null } | null; settled?: { settled: boolean } | null; open?: boolean; waitingForYou?: number; benchAsk?: string | null }): { cls: string; status: string; task: string }
