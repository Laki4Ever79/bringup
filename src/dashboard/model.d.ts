export const AGENT_COLORS: Record<string, string>
export function scrubberModel(events: any[]): { dots: any[]; boards: number[] }
export function boardFor(model: { boards: number[] }, revision: number): number | null
export function contractDiff(field: string, before: any, after: any): string[]
export function changedRefs(before: any, after: any): string[]
export function prCards(events: any[], snapshots: Map<number, any>): any[]
export function checkPills(events: any[]): any[]
export function parseBattery(reportText: string): { days: number; targetDays: number | null } | null
