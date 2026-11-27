import { resolveProvider } from "./inference/providers.ts"
import { readBrief } from "./brief-file.ts"
import { sweepStaleTemp } from "./tmp.ts"
import { modelLimitOf } from "./inference/limit.ts"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { OWNERS, type ContractSnapshot, type FieldName } from "./contract/types.ts"
import { checkConsistency, type Violation } from "./contract/consistency.ts"
import { createChangeDesk } from "./change-control.ts"
import { createBoardBuilder, createArmBuilder, createArmSimBuilder, createCncSimBuilder, createChassisBuilder, createDriveBuilder, createEnclosureBuilder, createFirmwareBuilder, createTestkitBuilder } from "./agents/builders.ts"
import { createConsistencyParticipant, MAX_REVISIONS, type Settlement } from "./agents/consistency.ts"
import { createGroundingCheck } from "./agents/grounding-check.ts"
import { createBomWriter } from "./agents/bom.ts"
import { createArchitectAgent, createCaseAgent, createMechanicsAgent, createConnectivityAgent, createFirmwareReviewer, createMlAgent, createPartsAgent, createTestAgent } from "./agents/roles.ts"
import { createBriefReviewer, MAX_REVIEW_ROUNDS } from "./agents/reviewer.ts"
import type { Script } from "./inference/scripted-runner.ts"
import { inferenceConfig } from "./inference/models.ts"
import { mockScripts } from "./inference/scripts.ts"
import { heldBy, writeReport } from "./report.ts"
import { createEmulatorCheck, emulatorEnabled } from "./agents/emulator.ts"
import { appendRequest, watchRequests } from "./runner/requests.ts"
import { createRippleRecorder } from "./runner/ripple.ts"
import { createFileSync } from "./runner/file-sync.ts"
import { createLinkedSync } from "./runner/linked.ts"
import { watchDecisions } from "./runner/decisions.ts"
import { createSteerDesk } from "./runner/steer-run.ts"
import { steerTools } from "./runner/steer-tools.ts"
import { loadCatalog } from "./tools/parts-search.ts"
import { createEngineer } from "./agents/engineer.ts"
import { startCloudSession } from "./runner/cloud.ts"
import { createActivityParticipant } from "./agents/activity.ts"
import { APPROVAL_TIMEOUT_MS, BringupState, emit, join as joinRuntime, sendMessage, startRuntime } from "./runtime.ts"
import { makeEvent } from "./events.ts"
import { detectEnvironment, type Env } from "./tools/env.ts"
import { createStubBuilders, missingBuilders } from "./tools/stubs.ts"
import { createBench, type Bench, type BenchOptions } from "./agents/bench.ts"
import type { Bridge, BridgeHello } from "./tools/bench-bridge.ts"
import { appendUsage } from "./inference/usage.ts"
import { recordRun, runSource } from "./modules/library.ts"
import { rosAfterRun } from "./ros/after-run.ts"
import { runScorecardCourse, SCORECARD_FILE, wantsScorecard } from "./tools/drive.ts"
import { mcuProfileOf } from "./mcu/profile.ts"

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
	// Skip the scorecard course (lap and go-to) a gyro-less encoder rover drives after each settle (--no-scorecard).
	noScorecard?: boolean
	// Build what this machine's tools allow and derive the rest from the contract (a fresh install with only the board
	// tools still gets a real board: setup streamlining, 26 Nov 2026).
	stubMissing?: boolean
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
	// A git working copy the engineer owns (runner/linked.ts): each settled revision is committed there, and edits to
	// it sync back. Without it, a staying run can still be linked later with `bringup link <run> <dir>`.
	link?: string
	// Continue a design (bringup continue, continue_design): start from this contract, from the run in `from`, instead of
	// drafting from the brief. The builders rebuild from it, the checks run, and the design settles again before taking
	// change requests.
	seed?: { contract: ContractSnapshot; from: string }
	// Injected fetch for bom.json's live stock lookups (tests).
	bomFetch?: typeof fetch
}

export interface RunResult {
	settled: boolean
	// What else held an unsettled design (report.ts heldBy): grounding findings, failed or unfinished builds, approvals.
	held?: string[]
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

// The whole run's time limit: 30 min for the design (60 on the Claude subscription, whose turns take about 20 s each:
// the first rover run there, 15 Nov, hit 30 min with a board build in flight), plus one change timeout per scripted
// change request. BRINGUP_TIMEOUT_MIN overrides it.
export function runTimeoutMs(opts: Pick<RunOptions, "timeoutMs" | "changes" | "changeTimeoutMs">, env: Record<string, string | undefined> = process.env): number {
	const base = Number(env.BRINGUP_TIMEOUT_MIN) > 0 ? Number(env.BRINGUP_TIMEOUT_MIN) * 60_000 : resolveProvider(env)?.protocol === "claude-code" ? 60 * 60_000 : 30 * 60_000
	return opts.timeoutMs ?? base + (opts.changes ?? []).length * (opts.changeTimeoutMs ?? CHANGE_TIMEOUT_MS)
}

// Runs one design from a brief until the consistency participant reports design.settled.
// Everything after sendMessage is event-driven; this function only waits for the outcome.
export async function runDesign(opts: RunOptions): Promise<RunResult> {
	// Temp folders a killed earlier run left behind (src/tmp.ts).
	sweepStaleTemp()
	mkdirSync(opts.outDir, { recursive: true })
	writeFileSync(join(opts.outDir, "brief.md"), opts.brief)
	const env = opts.env ?? (await detectEnvironment(ROOT))
	const state = new BringupState(opts.outDir, opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS)
	state.engineerApproval = opts.engineerApproval ?? false
	state.contract.setCatalog(loadCatalog(ROOT))
	state.review.enabled = opts.review ?? true
	state.review.maxRounds = opts.maxReviewRounds ?? MAX_REVIEW_ROUNDS
	if (opts.seed) {
		state.contract.restore(opts.seed.contract)
		writeFileSync(join(opts.outDir, "continued-from.json"), JSON.stringify({ from: opts.seed.from, revision: opts.seed.contract.revision }, null, 2))
	}
	// The provider's limit stops the run at once, with the reason, instead of letting the silenced agents "settle".
	let stopOnLimit: (s: Settlement) => void = () => {}
	const limitHit = new Promise<Settlement>((r) => (stopOnLimit = r))
	const onFailure = (model: string, error: string) => {
		console.error(`[bringup] ${model} inference failed: ${error}`)
		const limit = modelLimitOf(error)
		if (limit && !state.stopped) {
			state.stopped = `the model provider's limit was reached: ${limit}`
			console.error(`[bringup] stopping the run: ${state.stopped}`)
			stopOnLimit({ settled: false, revision: state.contract.revision })
		}
	}
	startRuntime(state, inferenceConfig(opts.mock, opts.scripts ?? mockScripts(), onFailure, (r) => appendUsage(opts.outDir, r)), join(opts.outDir, "trace.jsonl"))

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
		// What this run showed about the modules it used (src/modules/library.ts), for the module library. Not from the
		// test suite (node --test sets NODE_TEST_CONTEXT), so tests never write a machine's evidence.
		if (!process.env.NODE_TEST_CONTEXT && !process.env.BRINGUP_NO_EVIDENCE)
			((src) => recordRun(env.root, state.contract.snapshot().values, state.artifacts, `${opts.mock ? "scripted " : ""}${src.run}`, state.contract.revision, undefined, state.artifactFailures as Partial<Record<string, string>>, { design: src.design, ...(src.starter ? { starter: src.starter } : {}) }))(runSource(opts.outDir))
		return writeReport(opts.outDir, state, env, settled, { noHardware: opts.noHardware ?? false, bench: Boolean(opts.bench), mock: opts.mock })
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
	// The scorecard course (tools/drive.ts runScorecardCourse): once per settle, on the settled drive (a gyro-less encoder
	// rover's that passed), unless that drive already has one. One at a time, in the background; the run waits for it
	// before its report. About 1-2 min of QEMU per accepted change, not per rebuild.
	let scoring: Promise<void> | null = null
	const scoreSettled = () => {
		const d = state.artifacts.drive
		if (opts.noScorecard || opts.noHardware || scoring || !env.pio || !env.python || !wantsScorecard(d) || existsSync(join(d.dir, SCORECARD_FILE))) return
		if (!existsSync(join(d.dir, "fw")) || !existsSync(join(d.dir, "spec.json"))) return
		const machine = mcuProfileOf(state.contract.snapshot().values.parts)?.sim.machine ?? "esp32c3"
		scoring = runScorecardCourse({ root: env.root, python: env.python, pio: env.pio, fwDir: join(d.dir, "fw"), spec: JSON.parse(readFileSync(join(d.dir, "spec.json"), "utf8")), outDir: d.dir, machine }, d)
			.then((sc) => console.log(`bringup: scorecard for drive rev ${sc.revision}: go-to ${sc.goto.missMm ?? "?"} mm, lap ${sc.lap.missMm ?? "?"} mm`))
			.catch((e) => console.warn(`bringup: the scorecard course didn't run: ${e instanceof Error ? e.message : e}`))
			.finally(() => {
				scoring = null
				// A settle that came while this one drove: its drive gets its own course now.
				if ((latest as Settlement | null)?.settled) scoreSettled()
			})
	}
	const onSettled = (s: Settlement) => {
		if (s.settled) scoreSettled()
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
	const real = { board: () => createBoardBuilder(env), enclosure: () => createEnclosureBuilder(env), firmware: () => createFirmwareBuilder(env), testkit: () => createTestkitBuilder(env), chassis: () => createChassisBuilder(env), drive: () => createDriveBuilder(env), arm: () => createArmBuilder(env), armsim: () => createArmSimBuilder(env), cncsim: () => createCncSimBuilder(env) }
	const stubbed = opts.noHardware ? Object.keys(real) : opts.stubMissing ? missingBuilders(env) : []
	const builders = [...Object.entries(real).filter(([k]) => !stubbed.includes(k)).map(([, make]) => make()), ...(stubbed.length ? createStubBuilders(undefined, stubbed) : [])]
	for (const b of builders) joinRuntime(b)
	// A run that stays up syncs edits to its generated files back into the design (runner/file-sync.ts).
	const files = opts.stay || opts.bench ? createFileSync({ outDir: opts.outDir }) : null
	if (files) joinRuntime(files)
	// Once a folder is linked, it is the one place edits sync from: the per-revision watcher above stops.
	const linked = opts.stay || opts.bench ? createLinkedSync({ outDir: opts.outDir, linkDir: opts.link, onAttach: () => files?.close() }) : null
	if (linked) joinRuntime(linked)
	// Boots each new compiled firmware in QEMU when it is installed; never holds up settling.
	const emulator = emulatorEnabled(env, opts.noHardware ?? false) ? createEmulatorCheck(env) : null
	if (emulator) joinRuntime(emulator)
	joinRuntime(createGroundingCheck(env))
	const bom = createBomWriter({ root: env.root, fetch: opts.bomFetch, live: !opts.mock || opts.bomFetch !== undefined })
	joinRuntime(bom)
	createArchitectAgent({ mock: opts.mock })
	createPartsAgent({ mock: opts.mock })
	createMlAgent({ mock: opts.mock })
	createTestAgent({ mock: opts.mock })
	createCaseAgent({ mock: opts.mock })
	// Joins every run; it wakes only when motion targets make the design a robot.
	createMechanicsAgent({ mock: opts.mock })
	createConnectivityAgent({ mock: opts.mock })
	createFirmwareReviewer({ mock: opts.mock })
	if (state.review.enabled) createBriefReviewer({ mock: opts.mock, env })
	const engineer = createEngineer()
	joinRuntime(engineer)
	// Pause, edit, verify, resume; pause, stop or redo one agent (runner/steer.ts), from <outDir>/steer.jsonl.
	const steerDesk = createSteerDesk({ outDir: opts.outDir, tools: opts.noHardware ? null : steerTools(env) })
	joinRuntime(steerDesk)

	emit(makeEvent("run.started", engineer.getId(), { review: state.review.enabled, engineerApproval: state.engineerApproval, noHardware: opts.noHardware ?? false, bench: Boolean(opts.bench), stay: Boolean(opts.stay), mock: opts.mock }), engineer.getId())
	if (opts.seed) {
		// The continued design as its fields' changes, so every builder builds it and the checks look at it; no agent is
		// asked to draft it again.
		const s = state.contract.snapshot()
		const reason = `continued from ${opts.seed.from} at revision ${s.revision}`
		for (const field of Object.keys(s.values) as FieldName[])
			emit(makeEvent("contract.changed", engineer.getId(), { field, version: s.versions[field], revision: s.revision, by: OWNERS[field], reason, after: s.values[field] }), engineer.getId())
	} else sendMessage(opts.brief, engineer.getId())
	// Mid-run change requests (tsx src/request.ts, MCP request_change) arrive as further engineer messages.
	let requestCount = 0
	const requests = watchRequests(opts.outDir, (r) => {
		const request = { id: `req-${++requestCount}`, text: r.text, ...(r.source ? { source: r.source } : {}) }
		emit(makeEvent("change.requested", engineer.getId(), request), engineer.getId())
		// A system of boards hands this board its links (docs/system.md): the integrator owns the field, so it is written
		// as it is, and this board's own agents follow it through the checks it wakes, like any other change.
		if (r.links || r.assembly) {
			const handed: [FieldName, unknown][] = []
			if (r.links) handed.push(["links", r.links])
			if (r.assembly) handed.push(["assembly", r.assembly])
			for (const [field, value] of handed) {
				const before = state.contract.get(field) ?? null
				const result = state.contract.propose({ field, value, by: "integrator", baseVersion: state.contract.version(field) } as never)
				if (result.status === "applied") emit(makeEvent("contract.changed", engineer.getId(), { field, version: result.version, revision: result.revision, by: "integrator", reason: r.text, before, after: value, cause: { kind: "request", id: request.id, text: r.text } }), engineer.getId())
				else if (result.status !== "unchanged") console.error(`[system] ${field} not applied: ${JSON.stringify(result)}`)
			}
			return
		}
		state.currentRequest = request
		sendMessage(r.text, engineer.getId())
	})
	// The engineer's Approve/Reject votes on held changes (dashboard, or appended by hand).
	const decisions = watchDecisions(opts.outDir, (d) => engineer.decide(d))

	const timeoutMs = runTimeoutMs(opts)
	const deadline = new Promise<Settlement>((r) => setTimeout(() => r({ settled: false, revision: state.contract.revision }), timeoutMs).unref())
	const outcome = await Promise.race([settledPromise, deadline, limitHit])
	// Scripted changes, until the last one has settled or the run's time is up.
	if (scripted) await Promise.race([allChanged, deadline])
	if (changeTimer) clearTimeout(changeTimer)
	// Bring-up: change requests keep arriving and the bench keeps flashing until the engineer stops the run.
	if (opts.bench) await opts.bench.until
	// A run that stays up: change requests keep arriving and re-settling the design until it is stopped.
	if (opts.stay) await opts.stay.until
	// The page closes its composer on this: nobody is taking change requests any more.
	files?.close()
	linked?.close()
	steerDesk.close()
	emit(makeEvent("run.ended", engineer.getId(), { settled: (latest as Settlement | null)?.settled ?? outcome.settled, revision: state.contract.revision }), engineer.getId())
	requests.close()
	decisions.close()
	await bench?.close()
	await cloud?.end()
	// The design has settled; give a boot that is still running a moment to finish, so the report can include it.
	await Promise.all([emulator?.whenIdle(EMULATOR_GRACE_MS), bom.whenIdle(BOM_GRACE_MS)])
	// The scorecard course still driving: its lap and go-to belong in this run's files.
	await scoring
	// A robot's ROS 2 package, tested on mock hardware and on its own firmware in QEMU (src/ros/after-run.ts).
	await rosAfterRun(env, opts.outDir, state.contract.snapshot(), state.artifacts)
	const settled = (latest as Settlement | null)?.settled ?? outcome.settled
	const reportPath = writeOutputs(settled)
	return {
		settled,
		outDir: opts.outDir,
		revision: state.contract.revision,
		violations: checkConsistency(state.contract.snapshot(), state.artifacts, readBrief(opts.outDir)),
		held: settled ? [] : heldBy(state),
		reportPath,
	}
}
