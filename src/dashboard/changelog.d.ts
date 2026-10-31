export interface CauseText { text: string; link: { ripple: string } | { checks: string } | { changes: string } | null }
export interface LogEntry { revision: number; field: string; version: number; by: string; who: string; diff: string[]; reason: string | null; cause: CauseText }
export function readableDiff(field: string, before: any, after: any): string[]
export function causeText(cause: any): CauseText
export function changeLog(events: { type: string; payload?: any }[], from: number, to: number, snapshots: Map<number, any>): LogEntry[]
export function defaultRange(events: { type: string; payload?: any }[]): { from: number; to: number } | null
