export interface LaneEntry { status: string; text: string; at: string | null }
export interface Lane extends LaneEntry { history: LaneEntry[] }
export const LANES: { key: string; label: string }[]
export function createLanes(): Record<string, any>
export function applyLaneEvent(lanes: Record<string, any>, e: { type: string; at?: string; producerId?: string; payload?: any }): string[]
