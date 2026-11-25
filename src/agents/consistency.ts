import { readBrief } from "../brief-file.ts"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { OWNERS, type FieldName } from "../contract/types.ts"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { checkConsistency, type Violation } from "../contract/consistency.ts"
import { isEvent, makeEvent, type ArtifactKind, type Payloads } from "../events.ts"
import { emit, roleOf, state } from "../runtime.ts"
import { when } from "../change-control.ts"
import { ALL_KINDS, BUILD_REQUIRES, OPTIONAL_KINDS } from "./builders.ts"


export const MAX_REVISIONS = 25
// A robot (a motion field) carries more fields than a board alone: the drive, the chassis, the driver and its
// connectors are drafted after the board (real rover run 2, 15 Nov: the cap ended it mid-design). A system's boards
// get the same 40 (system/run.ts SYSTEM_BOARD_MAX_REVISIONS).
export const ROBOT_MAX_REVISIONS = 40
// At the revision cap the contract freezes and the run waits this long at most for the builds of its last revision, so
// the report judges built artifacts, not ones still building (real rover run 10, 15 Nov: 41 revisions in 2 minutes, the
// run ended with no board ever built and the firmware 15 revisions old).
export const DRAIN_MS = 15 * 60_000
export const REMIND_ROUNDS = 2
export const FROZEN_REASON = "the run's revision budget is spent: the contract takes no more changes; the builds of this revision finish, then the run ends"
const KINDS: ArtifactKind[] = ALL_KINDS

export interface Settlement {
	settled: boolean
	revision: number
}

// Plain-code participant that checks every artifact against the contract after each change and
// decides when the design has settled: every artifact built from the current versions of its
// inputs, no agent mid-turn, no change request open, and nothing changing for `quietMs`.
// A quiet design with violations or failed builds settles as unsettled, so a run always ends.
// With the brief review on, a quiet consistent design first emits design.ready and waits for the reviewer's
// review.completed: a pass settles; a fail with a fix round left waits for the owners to change the design, which
// is then reviewed again; a fail on the last round settles, unsettled only if a blocker remains.
//
// With keepRunning (run --bench), settling is not the end: a later contract change or held change un-settles the
// design, which then settles again (design.settled each time, onSettled each time). A new round of changes gets its
// own revision budget and review fix rounds.
export function createConsistencyParticipant(opts: { quietMs: number; maxRevisions?: number; keepRunning?: boolean; onSettled: (s: Settlement) => void }): Human {
	const maxRevisions = opts.maxRevisions ?? MAX_REVISIONS
	const self = { id: "" }
	const turns = new Map<string, number>()
	let lastReport = ""
	let violations: Violation[] = []
	let timer: NodeJS.Timeout | null = null
	let done = false
	// The revision handed to the reviewer, and whether its verdict is still due.
	let readyRevision = -1
	// MAX_REVISIONS counts from the start or from the last design.ready: a fix round after a review
	// legitimately needs its own budget.
	let budgetBase = 0
	// Settled false at the revision cap: agents' changes no longer re-arm it, only an engineer's request does.
	let capped = false
	// Capped and waiting for the builds of the frozen revision (until drainUntil).
	let draining = false
	let drainUntil = 0
	let awaitingReview = false
	let reviewerStarted = false

	const current = (kind: ArtifactKind): boolean => {
		const s = state()
		// An optional artifact the design hasn't asked for has nothing to build.
		const gate = OPTIONAL_KINDS[kind]
		if (gate && s.contract.version(gate) === 0) return true
		const inputs = s.artifactInputs[kind]
		return inputs !== undefined && Object.entries(inputs).every(([field, version]) => s.contract.version(field as never) === version)
	}

	// One check per burst of events, after the burst: it ran in the middle of event delivery for every contract.changed,
	// artifact.ready and artifact.failed (18 times per logger run, 41 per rover run, ~3 s of CPU during which no agent
	// heard anything; the isolation audit, 14 Nov 2026). The quiet-period evaluation runs a pending one first.
	let pending: NodeJS.Immediate | null = null
	const runCheck = () => {
		pending = null
		try {
			checkNow()
		} catch (error) {
			// A checker bug must never stop event delivery to the other participants.
			console.error("[consistency] check failed:", error)
		}
	}
	const check = () => {
		if (!pending) pending = setImmediate(runCheck)
	}
	const flushCheck = () => {
		if (!pending) return
		clearImmediate(pending)
		runCheck()
	}

	// <out>/contracts/rev-N.json for every revision so far, from the contract's own history (events can arrive
	// after the contract has moved on, so writing "the current one" would skip revisions). The dashboard diffs them.
	let written = 0
	const writeRevisions = (upTo: number) => {
		const s = state()
		if (written >= upTo) return
		mkdirSync(join(s.outDir, "contracts"), { recursive: true })
		for (let rev = written + 1; rev <= upTo; rev++) {
			const snap = s.contract.snapshotAt(rev)
			if (snap) writeFileSync(join(s.outDir, "contracts", `rev-${rev}.json`), JSON.stringify(snap, null, 2))
		}
		written = upTo
	}

	const checkNow = () => {
		const s = state()
		const snapshot = s.contract.snapshot()
		writeFileSync(join(s.outDir, "contract.json"), JSON.stringify(snapshot, null, 2))
		writeRevisions(snapshot.revision)
		violations = checkConsistency(snapshot, s.artifacts, readBrief(s.outDir), { boardStale: s.artifacts.board !== undefined && !current("board") })
		const report = JSON.stringify({ revision: snapshot.revision, violations })
		if (report !== lastReport) {
			lastReport = report
			emit(makeEvent("consistency.checked", self.id, { revision: snapshot.revision, violations, ...(draining ? { draining } : {}) }), self.id)
		}
	}

	const settle = (settled: boolean) => {
		if (done) return
		done = true
		const revision = state().contract.revision
		emit(makeEvent("design.settled", self.id, { revision, settled }), self.id)
		opts.onSettled({ settled, revision })
	}

	const nudged = new Set<FieldName>()
	// Reminders sent for open violations at quiet (reset when the contract changes: a new round of work).
	let reminders = 0
	const evaluate = () => {
		timer = null
		if (done) return
		flushCheck()
		const s = state()
		// The engineer paused the run or an agent (runner/steer.ts): nothing settles until it goes on; the resume's own
		// event re-arms this evaluation.
		if (s.steer.anyHeld()) return
		const grounding =
			!s.groundingEnabled ||
			s.contract.version("parts") === 0 ||
			(s.groundedVersions?.parts === s.contract.version("parts") && s.groundedVersions?.pins === s.contract.version("pins"))
		const agentsBusy = [...turns.values()].some((n) => n > 0) || s.approvals.openCount() > 0
		const stale = KINDS.filter((k) => !current(k))
		if (draining) {
			// Every build of the frozen revision done (or out of time): the run ends unsettled, judged on what was built.
			// A build still waiting on a field nobody wrote never comes: it isn't waited for.
			const building = stale.filter((k) => BUILD_REQUIRES[k].every((f) => s.contract.version(f) > 0))
			if (building.length > 0 && Date.now() < drainUntil) {
				timer = setTimeout(evaluate, Math.min(5_000, Math.max(0, drainUntil - Date.now())))
				return
			}
			for (const k of building) s.artifactFailures[k] = `not built: the revision budget ran out while it was building`
			flushCheck()
			return settle(false)
		}
		// Quiet, and every artifact that isn't current is only waiting for a field nobody wrote: the run is stuck.
		// End it unsettled, naming the missing fields in place of a build failure.
		const missing = (k: ArtifactKind) => BUILD_REQUIRES[k].filter((f) => s.contract.version(f) === 0)
		if (!agentsBusy && stale.length > 0 && stale.every((k) => missing(k).length > 0 && s.artifactInputs[k] === undefined)) {
			// First, once per field, ask its owner: an agent may stop with a field unwritten (real run 7, 9 Nov: the
			// architect's pins were refused once, it moved on, and nothing asked again). Only then end it unsettled.
			const fields = [...new Set(stale.flatMap(missing))].filter((f) => !nudged.has(f))
			if (fields.length > 0) {
				for (const f of fields) nudged.add(f)
				const asks = fields.map((f) => ({ kind: "field-missing" as const, message: `the contract has no ${f} yet, so ${stale.filter((k) => missing(k).includes(f)).join(" and ")} can't be built: write it with propose_contract_change (base version 0)`, fields: [f], affects: [OWNERS[f]] }))
				violations = [...violations, ...asks]
				emit(makeEvent("consistency.checked", self.id, { revision: s.contract.revision, violations }), self.id)
				return
			}
			for (const k of stale) s.artifactFailures[k] = `not built: the contract has no ${missing(k).join(", ")}`
			return settle(false)
		}
		const busy = agentsBusy || stale.length > 0 || !grounding
		if (busy) return
		const consistent = violations.length === 0 && s.groundingFindings.length === 0 && KINDS.every((k) => s.artifactFailures[k] === undefined)
		// Quiet with violations still open: the owners are told again, up to REMIND_ROUNDS times, before the run ends
		// unsettled. An agent whose turn ended without fixing its finding (its proposal timed out, or it thought it was
		// done) heard nothing more, because the report hadn't changed (real rover run 2 on the Claude subscription, 15 Nov:
		// it ended with a missing sensor part and a connector clash that nobody was working on).
		if (!consistent && violations.length > 0 && reminders < REMIND_ROUNDS) {
			reminders++
			emit(makeEvent("consistency.checked", self.id, { revision: s.contract.revision, violations }), self.id)
			return
		}
		if (!consistent || !s.review.enabled) return settle(consistent)
		reviewGate()
	}

	const noBlockers = () => !(state().review.results.at(-1)?.findings ?? []).some((f) => f.severity === "blocker")

	const reviewGate = () => {
		const s = state()
		const revision = s.contract.revision
		if (revision !== readyRevision) {
			readyRevision = revision
			budgetBase = revision
			awaitingReview = true
			reviewerStarted = false
			s.review.round++
			emit(makeEvent("design.ready", self.id, { revision, round: s.review.round }), self.id)
			return
		}
		if (awaitingReview) {
			// Quiet, and the reviewer's turn ended without submit_review: settle on the deterministic checks alone.
			if (!reviewerStarted) return
			awaitingReview = false
			s.review.missingVerdict = true
			return settle(true)
		}
		// Reviewed, failed with a fix round left, and the owners changed nothing.
		settle(noBlockers())
	}

	const onReview = (p: Payloads["review.completed"]) => {
		const s = state()
		if (!awaitingReview || p.revision !== readyRevision) return
		awaitingReview = false
		s.review.results.push({ revision: p.revision, round: s.review.round, verdict: p.verdict, findings: p.findings })
		if (p.verdict === "pass") return settle(true)
		if (s.review.round > s.review.maxRounds) return settle(noBlockers())
		// Otherwise the owners got the findings (roles.ts); the timer below re-evaluates once they are done.
	}

	const rearm = () => {
		const s = state()
		done = false
		budgetBase = s.contract.revision
		s.review.round = 0
	}

	const participant = createHuman({
		name: "consistency",
		capabilities: [],
		handlers: [
			{
				specification: when(() => !done || opts.keepRunning === true),
				processor: {
					apply: ({ event }) => {
						const type = event.type as string
						// Bring-up is post-settle and streams all the time; it is not design activity, so it must
						// neither hold up the quiet period nor re-arm a settled design.
						if (type.startsWith("bench.")) return
						// Agent turns: a loop starts with message_received and ends with its model answer. Counted even
						// once settled, so a turn that began before a re-arm still holds settling up.
						if (type === "message_received.started") turns.set(event.producerId, (turns.get(event.producerId) ?? 0) + 1)
						if (type === "model.answer") turns.set(event.producerId, Math.max(0, (turns.get(event.producerId) ?? 0) - 1))
						if (done) {
							// An engineer's change request re-arms too: one the agents meet without changing anything
							// must still settle again, or the run waits out the change timeout (real run 16).
							if (!(isEvent(event, "contract.changed") || isEvent(event, "change.proposed") || isEvent(event, "change.requested"))) return
							// After the revision cap, only the engineer re-arms it: the agents' own changes, still landing,
							// re-armed it with a fresh budget again and again (real system run, 9 Nov: 293 revisions).
							if (capped && !isEvent(event, "change.requested")) return
							capped = false
							draining = false
							state().contract.thaw()
							rearm()
						}
						if (isEvent(event, "contract.changed")) reminders = 0
						if (isEvent(event, "contract.changed") || isEvent(event, "artifact.ready") || isEvent(event, "artifact.failed")) check()
						if (type === "message_received.started" && awaitingReview && roleOf(event.producerId) === "reviewer") reviewerStarted = true
						if (isEvent(event, "review.completed")) {
							onReview(event.payload)
							if (done) return
						}
						const cap = state().contract.get("motion") ? Math.max(maxRevisions, ROBOT_MAX_REVISIONS) : maxRevisions
						if (!draining && isEvent(event, "contract.changed") && event.payload.revision - budgetBase > cap) {
							// Freeze, and let the builds of this revision finish before judging (evaluate ends the run).
							capped = true
							draining = true
							drainUntil = Date.now() + DRAIN_MS
							state().contract.freeze(FROZEN_REASON)
							check()
							if (timer) clearTimeout(timer)
							timer = setTimeout(evaluate, opts.quietMs)
							return
						}
						if (draining) {
							if (timer) clearTimeout(timer)
							timer = setTimeout(evaluate, opts.quietMs)
							return
						}
						if (timer) clearTimeout(timer)
						timer = setTimeout(evaluate, opts.quietMs)
					},
				},
			},
		],
	})
	self.id = participant.getId()
	return participant
}
