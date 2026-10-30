import type { Violation } from "./contract/consistency.ts"

export interface RunOptions {
	brief: string
	mock: boolean
	outDir: string
	approvalTimeoutMs?: number
	maxRevisions?: number
	timeoutMs?: number
}

export interface RunResult {
	settled: boolean
	outDir: string
	revision: number
	violations: Violation[]
	reportPath: string
}

// Runs one design from a brief until the consistency participant reports design.settled.
// (Implemented in Task 10.)
export async function runDesign(_opts: RunOptions): Promise<RunResult> {
	throw new Error("runDesign is not implemented yet")
}
