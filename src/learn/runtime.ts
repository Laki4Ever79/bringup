import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { createHuman, defineRuntime, RuntimeState } from "@mozaik-ai/core"
import { when } from "../change-control.ts"
import { NoModelKey } from "../dashboard/ask.ts"
import { isEvent, makeEvent } from "../events.ts"
import { appendUsage, usageRecord, type UsageRecord } from "../inference/usage.ts"
import { Outbox } from "../outbox.ts"
import { Budget, BudgetedReader, BudgetExhausted, estimateUsd, learnCap } from "./budget.ts"
import { distributorsFrom, SEARCH_FEE_USD, webFind } from "./distributors.ts"
import { createDocStore } from "./docs.ts"
import { findFootprint, kicadFootprintIndex } from "./footprint.ts"
import { loadKinds } from "./kinds.ts"
import { learnPart, type KnownPart, type LearnDeps, type LearnLog, type LearnResult } from "./learner.ts"
import { mockDistributor, mockFetch, mockFootprint, mockPropose, mockReader } from "./mock.ts"
import { MODELS_LEARN, openAiReader } from "./reader.ts"
import type { Candidate, PartNeed } from "./types.ts"

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
	// A failing progress callback (a full disk, a deleted plan folder) must not stop learning or leave it unresolved.
	const update = (u: { need: string; result?: LearnResult }) => {
		try {
			opts.onUpdate(u)
		} catch (e) {
			console.error(`[learn] progress update for ${u.need} failed:`, e instanceof Error ? e.message : e)
		}
	}
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
							update({ need: need.id })
							learn(need, opts.deps)
								.catch((e): LearnResult => ({ status: "unavailable", reasons: [{ mpn: "", reason: e instanceof BudgetExhausted ? "spending cap reached" : `learning failed: ${e instanceof Error ? e.message : e}` }] }))
								.then((r) => {
									results.set(need.id, r)
									update({ need: need.id, result: r })
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
export function learnDepsFor(env: Record<string, string | undefined>, repoRoot: string, planDir: string, mock: boolean, fetchImpl: typeof fetch = fetch, budget: Budget = new Budget(learnCap(env))): LearnDeps {
	mkdirSync(planDir, { recursive: true })
	const log = (l: LearnLog) => appendFileSync(join(planDir, "learn.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...l }) + "\n")
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
		propose: (need, exclude, known) => proposeCandidates(need, exclude, known ?? [], { env, fetchImpl, budget, onUsage, repoRoot }),
		log,
		onClaim: (t) => appendFileSync(join(planDir, "claims.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...t }) + "\n"),
	}
}

// What the proposer is asked: the kind's plain description first (a kind's name alone misleads: "speaker-driver" read
// as a driver IC gave amplifier chips for a loudspeaker), then the need.
export function candidatePrompt(need: PartNeed, repoRoot: string, exclude: string[], known: KnownPart[] = []): string {
	const description = loadKinds(repoRoot).get(need.kind)?.description
	return `Propose up to 3 real, currently produced parts (exact manufacturer part numbers) for this need, best first. Prefer parts listed at LCSC (the distributor Bringup can look up without keys; JLCPCB assembles from its stock), with a public datasheet that gives dimensions, pin-out and supply limits. For parts soldered on the board: leaded or QFN/SON packages, no BGA or WLCSP. The board is small, powered by USB 5 V and/or one Li-ion cell, 3.3 V logic: choose parts that run from those and are sized for the need, not far beyond it.\nThe part: ${description ?? `a part of kind "${need.kind}"`}\nKind: ${need.kind}\nRole: ${need.role}\nRequirements: ${need.requirements}${exclude.length ? `\nNot these: ${exclude.join(", ")}` : ""}${known.length ? `\nAlready learned (free to reuse: propose one first if it fits the need, with no datasheet link): ${known.map((k) => `${k.mpn} (${k.summary})`).join("; ")}` : ""}\nAnswer: {"parts": [{"manufacturer": string, "mpn": the manufacturer part number only, without the maker's name, "datasheet": the datasheet PDF's URL}]}`
}

// Candidate parts for a need, found by a web search (OpenAI Responses with web_search), each with the datasheet PDF the
// search found: part numbers recalled from memory were often variants that don't exist (run 5, 6: three speakers with
// no datasheet anywhere). Charged to the same budget, search fee included.
async function proposeCandidates(need: PartNeed, exclude: string[], known: KnownPart[], deps: { env: Record<string, string | undefined>; fetchImpl: typeof fetch; budget: Budget; onUsage: (r: UsageRecord) => void; repoRoot: string }): Promise<Candidate[]> {
	const model = MODELS_LEARN.cheap
	const est = estimateUsd(model, 0, PROPOSE_TOKENS) + SEARCH_FEE_USD
	if (!deps.env.OPENAI_API_KEY) throw new NoModelKey()
	if (!deps.budget.reserve(est)) throw new BudgetExhausted(deps.budget.spent, deps.budget.cap)
	let usd: number | null = null
	try {
		const res = await deps.fetchImpl("https://api.openai.com/v1/responses", {
			method: "POST",
			signal: AbortSignal.timeout(180_000),
			headers: { "content-type": "application/json", authorization: `Bearer ${deps.env.OPENAI_API_KEY}` },
			body: JSON.stringify({
				model,
				tools: [{ type: "web_search" }],
				max_output_tokens: PROPOSE_TOKENS,
				input: `${candidatePrompt(need, deps.repoRoot, exclude, known)}\nSearch the web. Give only parts whose datasheet PDF you found, with its direct URL in "datasheet"; copy each part number exactly as that datasheet prints it. Answer with the JSON only.`,
			}),
		})
		const body = (await res.json()) as { output_text?: string; output?: { content?: { text?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }; error?: { message?: string } }
		const record = usageRecord(model, "part-learner", body.usage?.input_tokens, body.usage?.input_tokens_details?.cached_tokens, body.usage?.output_tokens)
		deps.onUsage(record)
		usd = record.usd === null ? null : record.usd + SEARCH_FEE_USD
		if (!res.ok) throw new Error(`proposing parts: ${body.error?.message ?? res.statusText}`)
		return parseCandidateList(body.output_text ?? (body.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("\n"))
	} finally {
		deps.budget.settle(est, usd)
	}
}
const PROPOSE_TOKENS = 1500

// The model's candidates with their datasheet links: {"parts": [{manufacturer, mpn, datasheet}]}, a code fence or text
// around the JSON allowed, the maker's name in front of the number removed. Up to three.
export function parseCandidateList(text: string): Candidate[] {
	const json = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/gi, ""))?.[0] ?? ""
	const mpns = parseCandidates(json)
	let parts: { mpn?: unknown; datasheet?: unknown }[] = []
	try {
		const o = JSON.parse(json) as { parts?: { mpn?: unknown; datasheet?: unknown }[] }
		parts = Array.isArray(o?.parts) ? o.parts : []
	} catch {
		// parseCandidates already gave nothing.
	}
	return mpns.map((mpn) => {
		const p = parts.find((x) => typeof x?.mpn === "string" && x.mpn.trim().endsWith(mpn))
		const url = typeof p?.datasheet === "string" && /^https?:\/\//.test(p.datasheet) ? p.datasheet : undefined
		return url ? { mpn, datasheetUrl: url } : { mpn }
	})
}

// The model's candidates as bare part numbers: {"parts": [{manufacturer, mpn}]} (or {"mpns": [...]}), a code fence
// allowed, a maker's name written in front of the number removed ("Texas Instruments TPA2005D1DGN" → "TPA2005D1DGN").
export function parseCandidates(text: string): string[] {
	let raw: unknown
	try {
		raw = JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""))
	} catch {
		return []
	}
	const o = raw as { parts?: { manufacturer?: unknown; mpn?: unknown }[]; mpns?: unknown[] }
	const items = Array.isArray(o?.parts) ? o.parts.map((p) => ({ maker: typeof p?.manufacturer === "string" ? p.manufacturer : "", mpn: p?.mpn })) : Array.isArray(o?.mpns) ? o.mpns.map((m) => ({ maker: "", mpn: m })) : []
	const out: string[] = []
	for (const { maker, mpn } of items) {
		if (typeof mpn !== "string" || !mpn.trim()) continue
		let m = mpn.trim()
		if (maker && m.toLowerCase().startsWith(maker.toLowerCase())) m = m.slice(maker.length).trim()
		// Still words before the number: keep the last word that has a digit in it.
		if (/\s/.test(m)) m = m.split(/\s+/).filter((w) => /\d/.test(w)).at(-1) ?? m
		if (m && !out.includes(m)) out.push(m)
	}
	return out.slice(0, 3)
}
