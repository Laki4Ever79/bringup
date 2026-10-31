export interface ProofRow { id: string; label: string; seconds: number; woken: number; workers: number; shipped: number; vivid: string | null }
export function vividMismatch(shipped: { kind: string; message: string }[] | null | undefined): string | null
export function proofSummary(results: any): { changes: number; violations: number; rangeS: [number, number]; shipped: number; rows: ProofRow[]; headline: string } | null
export function matchTrial(o: { brief: string | null; before: any; after: any }, results: any): ProofRow | null
