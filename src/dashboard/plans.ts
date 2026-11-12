import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appendUsage, readSpend, type Spend } from "../inference/usage.ts"
import { proposePlan } from "../system/architect.ts"
import { estimate } from "../system/estimate.ts"
import { planChecks, type Plan, type PlanIssue } from "../system/plan.ts"
import { planDiff, type PlanDiff } from "./plan-edit.js"
import { learnDepsFor, learnNeeds } from "../learn/runtime.ts"
import type { LearnResult } from "../learn/learner.ts"

// Plans live in <outRoot>/plans/<id>/: plan.json, briefs/<board>.md (what the system run reads), history.jsonl (every
// saved version) and usage.jsonl (the architect's calls). Nothing here is a run until Build.

export const PLAN_ID = /^plan-[\w-]+$/

export class PlanConflict extends Error {
	readonly status = 409
	constructor() {
		super("the plan was updated elsewhere; reload it")
	}
}

export interface PlanView {
	plan: Plan
	issues: PlanIssue[]
	// GET only: it reads every recorded run, too slow for each drag save.
	estimate?: ReturnType<typeof estimate>
	// What planning has spent (the architect's calls): calls 0 means scripted, usd null with calls means unknown.
	spend?: Spend
	// The part learner's progress on the plan's needs (learning.json).
	learning?: LearningStatus[]
}

// One need's state: being learned, learned (which part, how many red defaults, reused from the catalog or not), or
// unavailable (each candidate's reason).
export interface LearningStatus {
	need: string
	status: "learning" | "learned" | "unavailable"
	mpn?: string
	reds?: number
	reused?: boolean
	reasons?: { mpn: string; reason: string }[]
}

const REPO_ROOT = join(import.meta.dirname, "../..")

export class PlanStore {
	constructor(
		private readonly outRoot: string,
		private readonly deps: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; repoRoot?: string } = {},
	) {}

	learning(id: string): LearningStatus[] {
		try {
			return JSON.parse(readFileSync(join(this.dir(id), "learning.json"), "utf8")) as LearningStatus[]
		} catch {
			return []
		}
	}

	private writeLearning(id: string, all: LearningStatus[]) {
		const file = join(this.dir(id), "learning.json")
		writeFileSync(`${file}.tmp`, JSON.stringify(all, null, "\t"))
		renameSync(`${file}.tmp`, file)
	}

	// Learns the plan's needs in the background (src/learn/runtime.ts); learning.json follows each one. Needs already
	// learned or found unavailable for this plan aren't learned again.
	private startLearning(plan: Plan, mock: boolean) {
		const known = new Map(this.learning(plan.id).filter((l) => l.status !== "learning").map((l) => [l.need, l]))
		const needs = (plan.needs ?? []).filter((n) => !known.has(n.id))
		const status: LearningStatus[] = [...(plan.needs ?? []).filter((n) => known.has(n.id)).map((n) => known.get(n.id)!), ...needs.map((n) => ({ need: n.id, status: "learning" as const }))]
		this.writeLearning(plan.id, status)
		if (!needs.length) return
		const asStatus = (need: string, r: LearnResult): LearningStatus =>
			r.status === "learned" ? { need, status: "learned", mpn: r.part.mpn, reds: r.part.facts.filter((f) => f.status === "default").length, reused: r.reused } : { need, status: "unavailable", reasons: r.reasons }
		const deps = learnDepsFor(this.deps.env ?? process.env, this.deps.repoRoot ?? REPO_ROOT, this.dir(plan.id), mock, this.deps.fetchImpl)
		learnNeeds(needs, {
			deps,
			tracePath: join(this.dir(plan.id), "learn-trace.jsonl"),
			onUpdate: (u) => {
				if (!u.result) return
				this.writeLearning(plan.id, this.learning(plan.id).map((l) => (l.need === u.need ? asStatus(u.need, u.result!) : l)))
			},
		}).catch((e) => {
			const reason = `learning failed: ${e instanceof Error ? e.message : e}`
			this.writeLearning(plan.id, this.learning(plan.id).map((l) => (l.status === "learning" ? { need: l.need, status: "unavailable", reasons: [{ mpn: "", reason }] } : l)))
		})
	}

	private dir(id: string) {
		return join(this.outRoot, "plans", id)
	}

	private write(plan: Plan): Plan {
		const dir = this.dir(plan.id)
		mkdirSync(join(dir, "briefs"), { recursive: true })
		const saved = { ...plan, spendUsd: readSpend(dir).usd }
		// A drag moves only the drawing positions: record just those, not the whole plan on every move. Any other change
		// records the whole plan, so every version can still be rebuilt from the history.
		const before = this.get(plan.id)
		const onlyMoved = before !== null && JSON.stringify({ ...before, layout: null, version: null }) === JSON.stringify({ ...saved, layout: null, version: null })
		writeFileSync(join(dir, "plan.json"), JSON.stringify(saved, null, "\t"))
		const at = new Date().toISOString()
		appendFileSync(join(dir, "history.jsonl"), JSON.stringify(onlyMoved ? { at, version: saved.version, layout: saved.layout } : { at, version: saved.version, plan: saved }) + "\n")
		return saved
	}

	get(id: string): Plan | null {
		if (!PLAN_ID.test(id)) return null
		try {
			return JSON.parse(readFileSync(join(this.dir(id), "plan.json"), "utf8")) as Plan
		} catch {
			return null
		}
	}

	view(id: string): PlanView | null {
		const plan = this.get(id)
		return plan ? { plan, issues: planChecks(plan), estimate: estimate(plan, this.outRoot), spend: readSpend(this.dir(id)), learning: this.learning(id) } : null
	}

	async create(sentence: string, mock: boolean): Promise<Plan> {
		const id = `plan-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomBytes(3).toString("hex")}`
		const dir = this.dir(id)
		mkdirSync(dir, { recursive: true })
		try {
			const proposed = await proposePlan({ sentence }, { mock, env: this.deps.env, fetchImpl: this.deps.fetchImpl, onUsage: (r) => appendUsage(dir, r) })
			const saved = this.write({ ...proposed, id, version: 1, spendUsd: null })
			this.startLearning(saved, mock)
			return saved
		} catch (e) {
			// A failed first call leaves no half plan behind (its usage, if any, is lost with it: there is no plan to show).
			if (!existsSync(join(dir, "plan.json"))) rmSync(dir, { recursive: true, force: true })
			throw e
		}
	}

	// A direct edit from the drawing; the version guards against overwriting a newer save.
	put(id: string, plan: Plan): PlanView {
		const current = this.get(id)
		if (!current) throw Object.assign(new Error("unknown plan"), { status: 404 })
		if (plan.version !== current.version) throw new PlanConflict()
		const saved = this.write({ ...plan, id, sentence: current.sentence, version: current.version + 1 })
		return { plan: saved, issues: planChecks(saved) }
	}

	// A change in words against `version` (the page's): refused if the plan moved on, before or during the model call,
	// so it can't undo a drag saved meanwhile.
	async change(id: string, instruction: string, mock: boolean, version?: number): Promise<PlanView & { diff: PlanDiff }> {
		const current = this.get(id)
		if (!current) throw Object.assign(new Error("unknown plan"), { status: 404 })
		if (version !== undefined && version !== current.version) throw new PlanConflict()
		const proposed = await proposePlan({ plan: current, instruction }, { mock, env: this.deps.env, fetchImpl: this.deps.fetchImpl, onUsage: (r) => appendUsage(this.dir(id), r) })
		if (this.get(id)?.version !== current.version) throw new PlanConflict()
		const saved = this.write({ ...proposed, id, version: current.version + 1, spendUsd: null })
		this.startLearning(saved, mock)
		return { plan: saved, issues: planChecks(saved), estimate: estimate(saved, this.outRoot), spend: readSpend(this.dir(id)), diff: planDiff(current, saved) }
	}

	// Real models need a key on this machine (the same rule proposePlan applies).
	hasModelKey(): boolean {
		const env = this.deps.env ?? process.env
		return Boolean(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY)
	}

	// What Build starts: a system run on the plan's own system.json, or for one board an ordinary run on its brief.
	buildTarget(id: string): { kind: "system"; specPath: string; usagePath: string } | { kind: "board"; brief: string } {
		const plan = this.get(id)
		if (!plan) throw Object.assign(new Error("unknown plan"), { status: 404 })
		const issues = planChecks(plan)
		if (issues.length) throw Object.assign(new Error(`fix the plan first: ${issues.map((i) => i.message).join("; ")}`), { status: 409 })
		const learning = this.learning(id).filter((l) => l.status === "learning")
		if (learning.length) throw Object.assign(new Error(`parts are still being learned: ${learning.map((l) => l.need).join(", ")}`), { status: 409 })
		if (plan.spec.boards.length === 1) return { kind: "board", brief: plan.briefs[plan.spec.boards[0].name] }
		const dir = this.dir(id)
		for (const b of plan.spec.boards) writeFileSync(join(dir, "briefs", `${b.name}.md`), plan.briefs[b.name])
		const specPath = join(dir, "system.json")
		writeFileSync(specPath, JSON.stringify(plan.spec, null, "\t"))
		return { kind: "system", specPath, usagePath: join(dir, "usage.jsonl") }
	}
}
