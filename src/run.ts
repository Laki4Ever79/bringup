import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHuman } from "@mozaik-ai/core"
import { checkConsistency, type Violation } from "./contract/consistency.ts"
import { createChangeDesk } from "./change-control.ts"
import { createBoardBuilder, createEnclosureBuilder, createFirmwareBuilder } from "./agents/builders.ts"
import { createConsistencyParticipant, MAX_REVISIONS, type Settlement } from "./agents/consistency.ts"
import { createCritic } from "./agents/critic.ts"
import { createArchitectAgent, createFirmwareReviewer, createPartsAgent } from "./agents/roles.ts"
import { inferenceConfig } from "./inference/models.ts"
import { mockScripts } from "./inference/scripts.ts"
import { writeReport } from "./report.ts"
import { APPROVAL_TIMEOUT_MS, BringupState, join as joinRuntime, sendMessage, startRuntime } from "./runtime.ts"
import { detectEnvironment, type Env } from "./tools/env.ts"

export interface RunOptions {
	brief: string
	mock: boolean
	outDir: string
	approvalTimeoutMs?: number
	maxRevisions?: number
	timeoutMs?: number
	env?: Env
}

export interface RunResult {
	settled: boolean
	outDir: string
	revision: number
	violations: Violation[]
	reportPath: string
}

export const ROOT = new URL("..", import.meta.url).pathname

// Runs one design from a brief until the consistency participant reports design.settled.
// Everything after sendMessage is event-driven; this function only waits for the outcome.
export async function runDesign(opts: RunOptions): Promise<RunResult> {
	mkdirSync(opts.outDir, { recursive: true })
	writeFileSync(join(opts.outDir, "brief.md"), opts.brief)
	const env = opts.env ?? (await detectEnvironment(ROOT))
	const state = new BringupState(opts.outDir, opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS)
	startRuntime(state, inferenceConfig(opts.mock, mockScripts()), join(opts.outDir, "trace.jsonl"))

	let resolveSettled: (s: Settlement) => void = () => {}
	const settledPromise = new Promise<Settlement>((r) => (resolveSettled = r))

	joinRuntime(createChangeDesk())
	joinRuntime(createConsistencyParticipant({ quietMs: 1500, maxRevisions: opts.maxRevisions ?? MAX_REVISIONS, onSettled: resolveSettled }))
	joinRuntime(createBoardBuilder(env))
	joinRuntime(createEnclosureBuilder(env))
	joinRuntime(createFirmwareBuilder(env))
	joinRuntime(createCritic(env))
	createArchitectAgent({ mock: opts.mock })
	createPartsAgent({ mock: opts.mock })
	createFirmwareReviewer({ mock: opts.mock })
	const engineer = createHuman({ name: "engineer", capabilities: [], handlers: [] })
	joinRuntime(engineer)

	sendMessage(opts.brief, engineer.getId())

	const timeoutMs = opts.timeoutMs ?? 30 * 60_000
	const outcome = await Promise.race([
		settledPromise,
		new Promise<Settlement>((r) => setTimeout(() => r({ settled: false, revision: state.contract.revision }), timeoutMs).unref()),
	])
	writeFileSync(join(opts.outDir, "contract.json"), JSON.stringify(state.contract.snapshot(), null, 2))
	const reportPath = writeReport(opts.outDir, state, env, outcome.settled)
	return {
		settled: outcome.settled,
		outDir: opts.outDir,
		revision: state.contract.revision,
		violations: checkConsistency(state.contract.snapshot(), state.artifacts),
		reportPath,
	}
}
