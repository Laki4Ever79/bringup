export const AGENT_COLORS: Record<string, string>
export function scrubberModel(events: any[]): { dots: any[]; boards: number[] }
export function boardFor(model: { boards: number[] }, revision: number): number | null
export function contractDiff(field: string, before: any, after: any): string[]
export function changedRefs(before: any, after: any): string[]
export function prCards(events: any[], snapshots: Map<number, any>): any[]
export function checkPills(events: any[]): any[]
export function parseBattery(reportText: string): { days: number; targetDays: number | null } | null
export function benchState(events: any[]): { source: "real" | "fake" | "replay"; meter: boolean; ports: any; flash: any; verdict: any; measured: any } | null
export function flashSteps(flash: any): { key: string; label: string; state: "done" | "active" | "failed" | "todo" }[]
export function attitude(ax: number, ay: number, az: number): { pitch: number; roll: number }
export function lowPass(prev: { pitch: number; roll: number }, next: { pitch: number; roll: number }, k: number): { pitch: number; roll: number }
export class TelemetryBuffer {
	constructor(windowMs?: number)
	windowMs: number
	current: { at: number; mA: number }[]
	tilt: { at: number; tilt: number }[]
	lastImu: { ax: number; ay: number; az: number; at: number } | null
	add(samples: any[]): void
}
export function safeUrl(url: unknown): string | null
export function sourcingRows(item: any): {
	sources: { supplier: string; url: string | null; stock: string; price: string; note: string | null }[]
	alternatives: { mpn: string; lcsc: string | null; stock: string; price: string }[]
}
