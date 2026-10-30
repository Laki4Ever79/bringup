import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { checkConsistency, type Violation } from "../contract/consistency.ts"
import { isEvent, makeEvent, type ArtifactKind, type Payloads } from "../events.ts"
import { emit, roleOf, state } from "../runtime.ts"
import { when } from "../change-control.ts"
import { BUILD_REQUIRES } from "./builders.ts"

export const MAX_REVISIONS = 25
const KINDS: ArtifactKind[] = ["board", "enclosure", "firmware"]

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
	let awaitingReview = false
	let reviewerStarted = false

	const current = (kind: ArtifactKind): boolean => {
		const s = state()
		const inputs = s.artifactInputs[kind]
		return inputs !== undefined && Object.entries(inputs).every(([field, version]) => s.contract.version(field as never) === version)
	}

	const check = () => {
		try {
			checkNow()
		} catch (error) {
			// A checker bug must never stop event delivery to the other participants.
			console.error("[consistency] check failed:", error)
		}
	}

	const checkNow = () => {
		const s = state()
		const snapshot = s.contract.snapshot()
		writeFileSync(join(s.outDir, "contract.json"), JSON.stringify(snapshot, null, 2))
		violations = checkConsistency(snapshot, s.artifacts)
		const report = JSON.stringify({ revision: snapshot.revision, violations })
		if (report !== lastReport) {
			lastReport = report
			emit(makeEvent("consistency.checked", self.id, { revision: snapshot.revision, violations }), self.id)
		}
	}

	const settle = (settled: boolean) => {
		if (done) return
		done = true
		const revision = state().contract.revision
		emit(makeEvent("design.settled", self.id, { revision, settled }), self.id)
		opts.onSettled({ settled, revision })
	}

	const evaluate = () => {
		timer = null
		if (done) return
		const s = state()
		const grounding =
			!s.groundingEnabled ||
			s.contract.version("parts") === 0 ||
			(s.groundedVersions?.parts === s.contract.version("parts") && s.groundedVersions?.pins === s.contract.version("pins"))
		const agentsBusy = [...turns.values()].some((n) => n > 0) || s.approvals.openCount() > 0
		const stale = KINDS.filter((k) => !current(k))
		// Quiet, and every artifact that isn't current is only waiting for a field nobody wrote: the run is stuck.
		// End it unsettled, naming the missing fields in place of a build failure.
		const missing = (k: ArtifactKind) => BUILD_REQUIRES[k].filter((f) => s.contract.version(f) === 0)
		if (!agentsBusy && stale.length > 0 && stale.every((k) => missing(k).length > 0 && s.artifactInputs[k] === undefined)) {
			for (const k of stale) s.artifactFailures[k] = `not built: the contract has no ${missing(k).join(", ")}`
			return settle(false)
		}
		const busy = agentsBusy || stale.length > 0 || !grounding
		if (busy) return
		const consistent = violations.length === 0 && s.groundingFindings.length === 0 && KINDS.every((k) => s.artifactFailures[k] === undefined)
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
						// Agent turns: a loop starts with message_received and ends with its model answer. Counted even
						// once settled, so a turn that began before a re-arm still holds settling up.
						if (type === "message_received.started") turns.set(event.producerId, (turns.get(event.producerId) ?? 0) + 1)
						if (type === "model.answer") turns.set(event.producerId, Math.max(0, (turns.get(event.producerId) ?? 0) - 1))
						if (done) {
							if (!(isEvent(event, "contract.changed") || isEvent(event, "change.proposed"))) return
							rearm()
						}
						if (isEvent(event, "contract.changed") || isEvent(event, "artifact.ready") || isEvent(event, "artifact.failed")) check()
						if (type === "message_received.started" && awaitingReview && roleOf(event.producerId) === "reviewer") reviewerStarted = true
						if (isEvent(event, "review.completed")) {
							onReview(event.payload)
							if (done) return
						}
						if (isEvent(event, "contract.changed") && event.payload.revision - budgetBase > maxRevisions) {
							settle(false)
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
