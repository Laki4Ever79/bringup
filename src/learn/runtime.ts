import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { createHuman, defineRuntime, RuntimeState } from "@mozaik-ai/core"
import { when } from "../change-control.ts"
import { callModel } from "../dashboard/ask.ts"
import { isEvent, makeEvent } from "../events.ts"
import { appendUsage, type UsageRecord } from "../inference/usage.ts"
import { Outbox } from "../outbox.ts"
import { Budget, BudgetedReader, BudgetExhausted, estimateUsd, learnCap } from "./budget.ts"
import { distributorsFrom, webFind } from "./distributors.ts"
import { createDocStore } from "./docs.ts"
import { findFootprint, kicadFootprintIndex } from "./footprint.ts"
import { learnPart, type LearnDeps, type LearnLog, type LearnResult } from "./learner.ts"
import { mockDistributor, mockFetch, mockFootprint, mockPropose, mockReader } from "./mock.ts"
import { MODELS_LEARN, openAiReader } from "./reader.ts"
import type { PartNeed } from "./types.ts"

class LearnState extends RuntimeState {}

// Learns every part a plan needs, at once: a planning Mozaik runtime of its own (not a board run's), one participant
// per need. Each reacts to its own part.needed by learning the part and answers part.learned or part.unavailable; a
// collector resolves when every need is answered. All share one Budget, so the spending cap is per design run.
// Events go through an Outbox (Mozaik 4.1 #115: publish is re-entrant).
export async function learnNeeds(
	needs: PartNeed[],
	opts: { deps: LearnDeps; learn?: (need: PartNeed, deps: LearnDeps) => Promise<LearnResult>; onUpdate: (u: { need: string; result?: LearnResult }) => void; tracePath?: string | null },
): Promise<Map<string, LearnResult>> {
	const learn = opts.learn ?? learnPart
	const results = new Map<string, LearnResult>()
	if (!needs.length) return results
	const rt = defineRuntime<LearnState>()
	rt.initializeRuntime({ state: new LearnState() })
	const outbox = new Outbox((event, senderId) => rt.sendEvent(event, senderId), opts.tracePath ?? null)
	let resolveAll!: () => void
	const all = new Promise<void>((r) => (resolveAll = r))

	for (const need of needs) {
		const self = { id: "" }
		const learner = createHuman({
			name: `part-learner-${need.id}`,
			capabilities: [],
			handlers: [
				{
					specification: when(({ event }) => isEvent(event, "part.needed") && event.payload.need.id === need.id),
					processor: {
						apply: () => {
							opts.onUpdate({ need: need.id })
							learn(need, opts.deps)
								.catch((e): LearnResult => ({ status: "unavailable", reasons: [{ mpn: "", reason: e instanceof BudgetExhausted ? "spending cap reached" : `learning failed: ${e instanceof Error ? e.message : e}` }] }))
								.then((r) => {
									results.set(need.id, r)
									opts.onUpdate({ need: need.id, result: r })
									outbox.emit(r.status === "learned" ? makeEvent("part.learned", self.id, { need: need.id, mpn: r.part.mpn, reused: r.reused }) : makeEvent("part.unavailable", self.id, { need: need.id, reasons: r.reasons }), self.id)
								})
						},
					},
				},
			],
		})
		self.id = learner.getId()
		rt.join(learner)
	}

	const collector = createHuman({
		name: "plan-parts",
		capabilities: [],
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "part.learned") || isEvent(event, "part.unavailable")),
				processor: { apply: () => (results.size === needs.length ? resolveAll() : undefined) },
			},
		],
	})
	rt.join(collector)
	for (const need of needs) outbox.emit(makeEvent("part.needed", collector.getId(), { need }), collector.getId())
	await all
	return results
}

// The part learner's dependencies for a plan: real (the user's OpenAI key, distributors, the repo's catalog) or mock
// (the fictional parts in examples/learn/, written under the plan's folder so the real catalog never sees them). Every
// model call is logged in the plan's usage.jsonl; every candidate tried in its learn.jsonl.
export function learnDepsFor(env: Record<string, string | undefined>, repoRoot: string, planDir: string, mock: boolean, fetchImpl: typeof fetch = fetch): LearnDeps {
	mkdirSync(planDir, { recursive: true })
	const log = (l: LearnLog) => appendFileSync(join(planDir, "learn.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...l }) + "\n")
	const budget = new Budget(learnCap(env))
	if (mock) {
		const root = join(planDir, "mock-catalog")
		return {
			root,
			kindsRoot: repoRoot,
			store: createDocStore(root, mockFetch),
			reader: new BudgetedReader(mockReader, budget),
			budget,
			distributors: [mockDistributor],
			webFind: async () => null,
			footprint: mockFootprint,
			propose: mockPropose,
			log,
		}
	}
	const onUsage = (r: UsageRecord) => appendUsage(planDir, r)
	const store = createDocStore(repoRoot, fetchImpl)
	let kicadIndex: Promise<string[]> | null = null
	return {
		root: repoRoot,
		store,
		reader: new BudgetedReader(openAiReader(env, fetchImpl, onUsage), budget),
		budget,
		distributors: distributorsFrom(env, fetchImpl),
		webFind: (mpn) => webFind(mpn, { env, fetchImpl, budget, store, onUsage }),
		footprint: async (p) => findFootprint(p, { fetchImpl, kicadIndex: await (kicadIndex ??= kicadFootprintIndex(repoRoot)) }),
		propose: (need, exclude) => proposeCandidates(need, exclude, { env, fetchImpl, budget, onUsage }),
		log,
	}
}

// Candidate parts for a need: up to three MPNs from the cheap model, charged to the same budget.
async function proposeCandidates(need: PartNeed, exclude: string[], deps: { env: Record<string, string | undefined>; fetchImpl: typeof fetch; budget: Budget; onUsage: (r: UsageRecord) => void }): Promise<string[]> {
	const est = estimateUsd(MODELS_LEARN.cheap, 0, 600)
	if (!deps.budget.reserve(est)) throw new BudgetExhausted(deps.budget.spent, deps.budget.cap)
	let usd: number | null = null
	try {
		const text = await callModel(
			{
				system: "You pick electronic parts. Answer with JSON only.",
				user: `Propose up to 3 real, currently produced parts (exact manufacturer part numbers) for this need, best first. Prefer parts in stock at LCSC/JLCPCB for parts soldered on the board, and parts with a public datasheet that gives dimensions, mount holes, pin-out and supply limits.\nKind: ${need.kind}\nRole: ${need.role}\nRequirements: ${need.requirements}${exclude.length ? `\nNot these: ${exclude.join(", ")}` : ""}\nAnswer: {"mpns": [string]}`,
			},
			deps.env,
			deps.fetchImpl,
			(r) => {
				usd = r.usd
				deps.onUsage({ ...r, source: "part-learner" })
			},
			{ role: "integrator", maxTokens: 600, json: true, source: "part-learner" },
		)
		const mpns = (JSON.parse(text) as { mpns?: unknown }).mpns
		return Array.isArray(mpns) ? mpns.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim()).slice(0, 3) : []
	} catch (e) {
		if (e instanceof SyntaxError) return []
		throw e
	} finally {
		deps.budget.settle(est, usd)
	}
}
