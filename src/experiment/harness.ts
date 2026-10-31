import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createHuman, type SemanticEvent } from "@mozaik-ai/core"
import { BuildLock, createBoardBuilder, createEnclosureBuilder, createFirmwareBuilder } from "../agents/builders.ts"
import { createConsistencyParticipant, type Settlement } from "../agents/consistency.ts"
import { createGroundingCheck } from "../agents/grounding-check.ts"
import { createArchitectAgent, createFirmwareReviewer, createPartsAgent } from "../agents/roles.ts"
import { createEngineer } from "../agents/engineer.ts"
import { createChangeDesk } from "../change-control.ts"
import { checkConsistency, type Artifacts, type Violation } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { makeEvent } from "../events.ts"
import { inferenceConfig } from "../inference/models.ts"
import { mockScripts } from "../inference/scripts.ts"
import { BringupState, emit, join as joinRuntime, sendMessage, startRuntime } from "../runtime.ts"
import { ROOT } from "../run.ts"
import { detectEnvironment, type Env } from "../tools/env.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import { createStubBuilders } from "../tools/stubs.ts"
import type { ExperimentChange } from "./changes.ts"

// The participants that do domain work in reaction to a change: N in "woken out of N".
export const WORKERS = ["architect", "parts", "firmware-reviewer", "board-builder", "enclosure-builder", "firmware-builder", "grounding-check"]

// Events that mean a participant did work: an agent turn, a build, a grounding pass.
const WORK_EVENTS = new Set(["message_received.started", "artifact.ready", "artifact.failed", "grounding.checked"])

const QUIET_MS = 1500
const SETTLE_TIMEOUT_MS = 15 * 60_000

export interface TrialRun {
	settled: boolean
	// From the first contract write of the change to design.settled.
	ms: number
	baseMs: number
	woken: string[]
	violations: Violation[]
	// Contract revisions the change itself wrote, and any later ones (agents reacting); arm B assumes there are none.
	changeRevisions: number
	laterRevisions: number
	truth: ContractSnapshot
	baseArtifacts: Artifacts
	finalArtifacts: Artifacts
}

// One trial: the mock agents settle the logger brief with the given builders, then the change's proposals are
// written to the contract by their owners, exactly as the agents' propose_contract_change tool does, and the
// situations take it from there. Arm "C" makes the builders take turns (BuildLock).
export async function runTrial(opts: { change: ExperimentChange; arm: "A" | "C"; outDir: string; noHardware?: boolean; env?: Env }): Promise<TrialRun> {
	mkdirSync(opts.outDir, { recursive: true })
	const env = opts.env ?? (await detectEnvironment(ROOT))
	const state = new BringupState(opts.outDir)
	state.contract.setCatalog(loadCatalog(ROOT))
	state.review.enabled = false
	startRuntime(state, inferenceConfig(true, mockScripts()), join(opts.outDir, "trace.jsonl"))

	const seen: { event: SemanticEvent; at: number }[] = []
	joinRuntime(createHuman({ name: "experiment-recorder", capabilities: [], handlers: [{ specification: { isSatisfiedBy: () => true } as never, processor: { apply: ({ event }) => void seen.push({ event, at: Date.now() }) } }] }))

	const settlements: Settlement[] = []
	let wake: () => void = () => {}
	const nextSettlement = (count: number) =>
		new Promise<Settlement | null>((resolve) => {
			const timer = setTimeout(() => resolve(null), SETTLE_TIMEOUT_MS)
			const check = () => {
				if (settlements.length < count) return
				clearTimeout(timer)
				resolve(settlements[count - 1])
			}
			wake = check
			check()
		})
	joinRuntime(createChangeDesk())
	joinRuntime(createConsistencyParticipant({ quietMs: QUIET_MS, keepRunning: true, onSettled: (s) => (settlements.push(s), wake()) }))
	const lock = opts.arm === "C" ? new BuildLock() : undefined
	const builders = opts.noHardware ? createStubBuilders(lock) : [createBoardBuilder(env, lock), createEnclosureBuilder(env, lock), createFirmwareBuilder(env, lock)]
	for (const b of builders) joinRuntime(b)
	joinRuntime(createGroundingCheck(env))
	createArchitectAgent({ mock: true })
	createPartsAgent({ mock: true })
	createFirmwareReviewer({ mock: true })
	const engineer = createEngineer()
	joinRuntime(engineer)

	const started = Date.now()
	sendMessage(readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), engineer.getId())
	const base = await nextSettlement(1)
	if (!base?.settled) throw new Error(`the base design did not settle (${opts.outDir})`)
	const baseMs = Date.now() - started
	const baseArtifacts = structuredClone(state.artifacts)
	const baseRevision = state.contract.revision

	const idOf = (role: string) => [...state.roles.entries()].find(([, r]) => r === role)?.[0] ?? engineer.getId()
	const mark = seen.length
	const t0 = Date.now()
	for (const p of opts.change.proposals(state.contract.snapshot())) {
		const r = state.contract.propose({ ...p, baseVersion: state.contract.version(p.field) })
		if (r.status !== "applied") throw new Error(`${opts.change.id}: ${p.field} was not applied: ${JSON.stringify(r)}`)
		emit(makeEvent("contract.changed", idOf(p.by), { field: p.field, version: r.version, revision: r.revision, by: p.by }), idOf(p.by))
	}
	const changeRevision = state.contract.revision
	const after = await nextSettlement(2)
	const ms = Date.now() - t0
	const nameOf = (id: string) => state.getParticipant(id)?.getManifest().name ?? id
	const woken = WORKERS.filter((w) => seen.slice(mark).some(({ event }) => WORK_EVENTS.has(event.type as string) && nameOf(event.producerId) === w))
	const truth = state.contract.snapshot()
	return {
		settled: after?.settled ?? false,
		ms,
		baseMs,
		woken,
		violations: checkConsistency(truth, state.artifacts),
		changeRevisions: changeRevision - baseRevision,
		laterRevisions: truth.revision - changeRevision,
		truth,
		baseArtifacts,
		finalArtifacts: structuredClone(state.artifacts),
	}
}
