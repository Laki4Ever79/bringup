import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { checkConsistency, type Violation } from "../contract/consistency.ts"
import { isEvent, makeEvent, type ArtifactKind } from "../events.ts"
import { emit, state } from "../runtime.ts"
import { when } from "../change-control.ts"

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
export function createConsistencyParticipant(opts: { quietMs: number; maxRevisions?: number; onSettled: (s: Settlement) => void }): Human {
	const maxRevisions = opts.maxRevisions ?? MAX_REVISIONS
	const self = { id: "" }
	const turns = new Map<string, number>()
	let lastReport = ""
	let violations: Violation[] = []
	let timer: NodeJS.Timeout | null = null
	let done = false

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
		const busy = [...turns.values()].some((n) => n > 0) || s.approvals.openCount() > 0 || !KINDS.every(current) || !grounding
		if (busy) return
		settle(violations.length === 0 && s.groundingFindings.length === 0 && KINDS.every((k) => s.artifactFailures[k] === undefined))
	}

	const participant = createHuman({
		name: "consistency",
		capabilities: [],
		handlers: [
			{
				specification: when(() => !done),
				processor: {
					apply: ({ event }) => {
						const type = event.type as string
						// Agent turns: a loop starts with message_received and ends with its model answer.
						if (type === "message_received.started") turns.set(event.producerId, (turns.get(event.producerId) ?? 0) + 1)
						if (type === "model.answer") turns.set(event.producerId, Math.max(0, (turns.get(event.producerId) ?? 0) - 1))
						if (isEvent(event, "contract.changed") || isEvent(event, "artifact.ready") || isEvent(event, "artifact.failed")) check()
						if (isEvent(event, "contract.changed") && event.payload.revision > maxRevisions) {
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
