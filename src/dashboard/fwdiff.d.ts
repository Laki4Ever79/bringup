export interface DiffLine { op: "same" | "del" | "add"; a: number | null; b: number | null; text: string }
export function lineDiff(oldText: string, newText: string): DiffLine[]
export function hunks(diff: DiffLine[], context?: number): { skippedBefore: number; skippedAfter: number; lines: DiffLine[] }[]
export function compareFiles(older: { path: string; hash: string; generated: boolean }[] | null, newer: { path: string; hash: string; generated: boolean }[]): { path: string; status: "added" | "removed" | "changed" | "same"; generated: boolean }[]
