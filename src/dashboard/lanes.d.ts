export interface LaneEntry { status: string; text: string; at: string | null }
export interface Lane extends LaneEntry { lastResult: string; history: LaneEntry[]; boot: { ok: boolean; revision: number; bootRevision: number | null; lastLine: string; tail: string } | null }
export const LANES: { key: string; label: string }[]
export function createLanes(): Record<string, any>
export function applyLaneEvent(lanes: Record<string, any>, e: { type: string; at?: string; producerId?: string; payload?: any }): string[]
export const BUILDS: Record<"board" | "enclosure" | "firmware", { inputs: string[]; requires: string[] }>
