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
import { appendRequest, watchRequests } from "./runner/requests.ts"
import { createRippleRecorder } from "./runner/ripple.ts"
import { watchDecisions } from "./runner/decisions.ts"
import { loadCatalog } from "./tools/parts-search.ts"
import { createEngineer } from "./agents/engineer.ts"
import { startCloudSession } from "./runner/cloud.ts"
import { createActivityParticipant } from "./agents/activity.ts"
import { APPROVAL_TIMEOUT_MS, BringupState, emit, join as joinRuntime, sendMessage, startRuntime } from "./runtime.ts"
import { makeEvent } from "./events.ts"
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
		timings?: Pick<BenchOptions, "windowMs" | "liveCheckMs" | "bootTimeoutMs" | "batchMs" | "blinkWaitMs">
	}
	// Engineer change requests sent one at a time: the first once the design has settled, each next one once it has
	// settled again (or after changeTimeoutMs, for a request that changed nothing). The run ends after the last.
	changes?: string[]
	changeTimeoutMs?: number
	// A pause after each settle before the next scripted change goes out, so the settled design can be seen first.
	changeDelayMs?: number
	// After settling (and after any scripted changes), keep taking change requests and re-settling until `until`
	// (the dashboard's Stop, Ctrl-C). Without it the run ends at its first settle, as the CLI judge path expects.
	stay?: { until: Promise<void> }
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
// How long a scripted change request may take to re-settle the design before the next one is sent anyway.
const CHANGE_TIMEOUT_MS = 20 * 60_000

// A scripted change needs a whole design to ripple through: one that settled, or at least got to the brief review
// (real runs usually end with review findings open). A run stuck before that (real-11: pins never written) ends.
export function changesMayStart(first: Settlement, reviewRound: number): boolean {
	return first.settled || reviewRound > 0
}

// The whole run's time limit: 30 min for the design, plus one change timeout per scripted change request.
export function runTimeoutMs(opts: Pick<RunOptions, "timeoutMs" | "changes" | "changeTimeoutMs">): number {
	return opts.timeoutMs ?? 30 * 60_000 + (opts.changes ?? []).length * (opts.changeTimeoutMs ?? CHANGE_TIMEOUT_MS)
}

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
	// Keeps <outDir>/ripples.json current once a change request arrives.
	joinRuntime(createRippleRecorder(opts.outDir))

	let resolveSettled: (s: Settlement) => void = () => {}
	const settledPromise = new Promise<Settlement>((r) => (resolveSettled = r))
	// The newest settlement; with --bench the design can settle again after the first.
	let latest: Settlement | null = null
	const writeOutputs = (settled: boolean) => {
		writeFileSync(join(opts.outDir, "contract.json"), JSON.stringify(state.contract.snapshot(), null, 2))
		return writeReport(opts.outDir, state, env, settled, { noHardware: opts.noHardware ?? false, bench: Boolean(opts.bench) })
	}
	// Scripted change requests (--change): each goes out through requests.jsonl, like one from the CLI or the MCP.
	const changes = [...(opts.changes ?? [])]
	let changesDone: () => void = () => {}
	const allChanged = new Promise<void>((r) => (changesDone = r))
	let changeTimer: NodeJS.Timeout | null = null
	const nextChange = () => {
		if (changeTimer) clearTimeout(changeTimer)
		const text = changes.shift()
		if (text === undefined) return changesDone()
		appendRequest(opts.outDir, text)
		// A request the agents can't map to a field changes nothing, so the design never settles again: move on.
		changeTimer = setTimeout(nextChange, opts.changeTimeoutMs ?? CHANGE_TIMEOUT_MS)
	}
	const scripted = changes.length > 0
	const afterSettle = () => {
		if (changeTimer) clearTimeout(changeTimer)
		changeTimer = setTimeout(nextChange, opts.changeDelayMs ?? 0)
	}
	const onSettled = (s: Settlement) => {
		const first = latest === null
		latest = s
		if (opts.bench || scripted || opts.stay) writeOutputs(s.settled)
		if (first) resolveSettled(s)
		if (!scripted) return
		if (first && !changesMayStart(s, state.review.round)) {
			console.warn("bringup: the design never got consistent, so the scripted change requests are not sent")
			changes.length = 0
			return nextChange()
		}
		afterSettle()
	}

	joinRuntime(createChangeDesk())
	joinRuntime(createConsistencyParticipant({ quietMs: 1500, maxRevisions: opts.maxRevisions ?? MAX_REVISIONS, keepRunning: Boolean(opts.bench) || scripted || Boolean(opts.stay), onSettled }))
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
	const bom = createBomWriter({ root: env.root, fetch: opts.bomFetch, live: !opts.mock || opts.bomFetch !== undefined })
	joinRuntime(bom)
	createArchitectAgent({ mock: opts.mock })
	createPartsAgent({ mock: opts.mock })
	createFirmwareReviewer({ mock: opts.mock })
	if (state.review.enabled) createBriefReviewer({ mock: opts.mock, env })
	const engineer = createEngineer()
	joinRuntime(engineer)

	emit(makeEvent("run.started", engineer.getId(), { review: state.review.enabled, engineerApproval: state.engineerApproval, noHardware: opts.noHardware ?? false, bench: Boolean(opts.bench), stay: Boolean(opts.stay) }), engineer.getId())
	sendMessage(opts.brief, engineer.getId())
	// Mid-run change requests (tsx src/request.ts, MCP request_change) arrive as further engineer messages.
	let requestCount = 0
	const requests = watchRequests(opts.outDir, (r) => {
		emit(makeEvent("change.requested", engineer.getId(), { id: `req-${++requestCount}`, text: r.text }), engineer.getId())
		sendMessage(r.text, engineer.getId())
	})
	// The engineer's Approve/Reject votes on held changes (dashboard, or appended by hand).
	const decisions = watchDecisions(opts.outDir, (d) => engineer.decide(d))

	const timeoutMs = runTimeoutMs(opts)
	const deadline = new Promise<Settlement>((r) => setTimeout(() => r({ settled: false, revision: state.contract.revision }), timeoutMs).unref())
	const outcome = await Promise.race([settledPromise, deadline])
	// Scripted changes, until the last one has settled or the run's time is up.
	if (scripted) await Promise.race([allChanged, deadline])
	if (changeTimer) clearTimeout(changeTimer)
	// Bring-up: change requests keep arriving and the bench keeps flashing until the engineer stops the run.
	if (opts.bench) await opts.bench.until
	// A run that stays up: change requests keep arriving and re-settling the design until it is stopped.
	if (opts.stay) await opts.stay.until
	// The page closes its composer on this: nobody is taking change requests any more.
	emit(makeEvent("run.ended", engineer.getId(), { settled: (latest as Settlement | null)?.settled ?? outcome.settled, revision: state.contract.revision }), engineer.getId())
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
