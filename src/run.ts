import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkConsistency, type Violation } from "./contract/consistency.ts"
import { createChangeDesk } from "./change-control.ts"
import { createBoardBuilder, createEnclosureBuilder, createFirmwareBuilder } from "./agents/builders.ts"
import { createConsistencyParticipant, MAX_REVISIONS, type Settlement } from "./agents/consistency.ts"
import { createGroundingCheck } from "./agents/grounding-check.ts"
import { createBomWriter } from "./agents/bom.ts"
import { createArchitectAgent, createFirmwareReviewer, createPartsAgent } from "./agents/roles.ts"
import { createBriefReviewer, MAX_REVIEW_ROUNDS } from "./agents/reviewer.ts"
import type { Script } from "./inference/scripted-runner.ts"
import { inferenceConfig } from "./inference/models.ts"
import { mockScripts } from "./inference/scripts.ts"
import { writeReport } from "./report.ts"
import { createEmulatorCheck, emulatorEnabled } from "./agents/emulator.ts"
import { watchRequests } from "./runner/requests.ts"
import { watchDecisions } from "./runner/decisions.ts"
import { loadCatalog } from "./tools/parts-search.ts"
import { createEngineer } from "./agents/engineer.ts"
import { startCloudSession } from "./runner/cloud.ts"
import { createActivityParticipant } from "./agents/activity.ts"
import { APPROVAL_TIMEOUT_MS, BringupState, join as joinRuntime, sendMessage, startRuntime } from "./runtime.ts"
import { detectEnvironment, type Env } from "./tools/env.ts"
import { createStubBuilders } from "./tools/stubs.ts"
import { createBench, type Bench, type BenchOptions } from "./agents/bench.ts"
import type { Bridge, BridgeHello } from "./tools/bench-bridge.ts"

export interface RunOptions {
	brief: string
	mock: boolean
	outDir: string
	approvalTimeoutMs?: number
	maxRevisions?: number
	timeoutMs?: number
	env?: Env
	// Derive board, enclosure and firmware from the contract instead of running the hardware tools.
	noHardware?: boolean
	// The LLM brief reviewer gates settling (default on); maxReviewRounds is how many fix rounds it may ask for.
	review?: boolean
	// Every held change also needs the human engineer (votes arrive in <outDir>/decisions.jsonl).
	engineerApproval?: boolean
	maxReviewRounds?: number
	// Mock model scripts, for tests; defaults to mockScripts().
	scripts?: Record<string, Script>
	// The live hardware bench (--bench): bring-up is a post-settle phase. The run stays alive after the first settle
	// until `until` resolves (Ctrl-C), re-settling and rewriting the report after every later change.
	bench?: {
		open: () => Promise<{ bridge: Bridge; hello: BridgeHello }>
		until: Promise<void>
		timings?: Pick<BenchOptions, "windowMs" | "liveCheckMs" | "bootTimeoutMs" | "batchMs">
	}
	// Injected fetch for bom.json's live stock lookups (tests).
	bomFetch?: typeof fetch
}

export interface RunResult {
	settled: boolean
	outDir: string
	revision: number
	violations: Violation[]
	reportPath: string
}

export const ROOT = fileURLToPath(new URL("..", import.meta.url))

// How long, after settling, the report waits for a QEMU boot still in flight.
const EMULATOR_GRACE_MS = 30_000
// How long, after settling, the run waits for bom.json's live stock lookups to finish.
const BOM_GRACE_MS = 15_000

// Runs one design from a brief until the consistency participant reports design.settled.
// Everything after sendMessage is event-driven; this function only waits for the outcome.
export async function runDesign(opts: RunOptions): Promise<RunResult> {
	mkdirSync(opts.outDir, { recursive: true })
	writeFileSync(join(opts.outDir, "brief.md"), opts.brief)
	const env = opts.env ?? (await detectEnvironment(ROOT))
	const state = new BringupState(opts.outDir, opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS)
	state.engineerApproval = opts.engineerApproval ?? false
	state.contract.setCatalog(loadCatalog(ROOT))
	state.review.enabled = opts.review ?? true
	state.review.maxRounds = opts.maxReviewRounds ?? MAX_REVIEW_ROUNDS
	startRuntime(state, inferenceConfig(opts.mock, opts.scripts ?? mockScripts()), join(opts.outDir, "trace.jsonl"))

	// First, so the one Cloud session sees every participant join and every event (null without a key).
	const cloud = startCloudSession(() => state.getParticipants())
	if (cloud) joinRuntime(cloud.participant)
	joinRuntime(createActivityParticipant())

	let resolveSettled: (s: Settlement) => void = () => {}
	const settledPromise = new Promise<Settlement>((r) => (resolveSettled = r))
	// The newest settlement; with --bench the design can settle again after the first.
	let latest: Settlement | null = null
	const writeOutputs = (settled: boolean) => {
		writeFileSync(join(opts.outDir, "contract.json"), JSON.stringify(state.contract.snapshot(), null, 2))
		return writeReport(opts.outDir, state, env, settled, { noHardware: opts.noHardware ?? false, bench: Boolean(opts.bench) })
	}
	const onSettled = (s: Settlement) => {
		const first = latest === null
		latest = s
		if (opts.bench) writeOutputs(s.settled)
		if (first) resolveSettled(s)
	}

	joinRuntime(createChangeDesk())
	joinRuntime(createConsistencyParticipant({ quietMs: 1500, maxRevisions: opts.maxRevisions ?? MAX_REVISIONS, keepRunning: Boolean(opts.bench), onSettled }))
	let bench: Bench | null = null
	if (opts.bench) {
		bench = createBench({ ...(await opts.bench.open()), ...opts.bench.timings })
		joinRuntime(bench)
	}
	const builders = opts.noHardware ? createStubBuilders() : [createBoardBuilder(env), createEnclosureBuilder(env), createFirmwareBuilder(env)]
	for (const b of builders) joinRuntime(b)
	// Boots each new compiled firmware in QEMU when it is installed; never holds up settling.
	const emulator = emulatorEnabled(env, opts.noHardware ?? false) ? createEmulatorCheck(env) : null
	if (emulator) joinRuntime(emulator)
	joinRuntime(createGroundingCheck(env))
	const bom = createBomWriter({ root: env.root, fetch: opts.bomFetch })
	joinRuntime(bom)
	createArchitectAgent({ mock: opts.mock })
	createPartsAgent({ mock: opts.mock })
	createFirmwareReviewer({ mock: opts.mock })
	if (state.review.enabled) createBriefReviewer({ mock: opts.mock, env })
	const engineer = createEngineer()
	joinRuntime(engineer)

	sendMessage(opts.brief, engineer.getId())
	// Mid-run change requests (tsx src/request.ts, MCP request_change) arrive as further engineer messages.
	const requests = watchRequests(opts.outDir, (r) => sendMessage(r.text, engineer.getId()))
	// The engineer's Approve/Reject votes on held changes (dashboard, or appended by hand).
	const decisions = watchDecisions(opts.outDir, (d) => engineer.decide(d))

	const timeoutMs = opts.timeoutMs ?? 30 * 60_000
	const outcome = await Promise.race([
		settledPromise,
		new Promise<Settlement>((r) => setTimeout(() => r({ settled: false, revision: state.contract.revision }), timeoutMs).unref()),
	])
	// Bring-up: change requests keep arriving and the bench keeps flashing until the engineer stops the run.
	if (opts.bench) await opts.bench.until
	requests.close()
	decisions.close()
	await bench?.close()
	await cloud?.end()
	// The design has settled; give a boot that is still running a moment to finish, so the report can include it.
	await Promise.all([emulator?.whenIdle(EMULATOR_GRACE_MS), bom.whenIdle(BOM_GRACE_MS)])
	const settled = (latest as Settlement | null)?.settled ?? outcome.settled
	const reportPath = writeOutputs(settled)
	return {
		settled,
		outDir: opts.outDir,
		revision: state.contract.revision,
		violations: checkConsistency(state.contract.snapshot(), state.artifacts),
		reportPath,
	}
}
