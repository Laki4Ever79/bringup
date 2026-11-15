import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { layoutFor } from "../system/architect.ts"
import type { Plan } from "../system/plan.ts"
import type { SystemSpec } from "../system/spec.ts"
import { planDiff, type PlanDiff } from "./plan-edit.js"

// Starters: an example (examples/<name>/example.json) plus its seed plan (starter.json), the Plan fields without the
// id, version and spend. Forking copies the seed into a new plan (PlanStore.fork); the starter file is only ever read.
// When a fork is built, one line goes to <outRoot>/starters/<name>/forks.jsonl: what the fork changed and how it ended.

export const STARTER_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/

export type StarterSeed = Omit<Plan, "id" | "version" | "spendUsd" | "builtAs" | "forkedFrom">

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status })

// The starter's seed, the short sha256 of its bytes, and its example's title. 400 for a malformed name, 404 when the
// example has no starter.json.
export function readStarter(examplesRoot: string, name: string): { seed: StarterSeed; hash: string; title: string } {
	if (!STARTER_NAME.test(name)) throw httpError(400, "a starter name is lower-case letters, digits and -")
	const file = join(examplesRoot, name, "starter.json")
	if (!existsSync(file)) throw httpError(404, `no starter named ${name}`)
	const bytes = readFileSync(file)
	let raw: unknown
	try {
		raw = JSON.parse(bytes.toString("utf8"))
	} catch {
		throw httpError(500, `examples/${name}/starter.json is not JSON`)
	}
	const bad = seedProblem(raw)
	if (bad) throw httpError(500, `examples/${name}/starter.json is not a valid seed: ${bad}`)
	// Only the seed's own fields: a stray key (builtAs, version…) must not make a fresh fork look built or edited.
	const r = raw as StarterSeed
	const seed: StarterSeed = { sentence: r.sentence, spec: r.spec, briefs: r.briefs, why: r.why ?? "", offBoard: r.offBoard ?? [], cantBuild: r.cantBuild ?? [], layout: r.layout ?? {}, optional: r.optional ?? [], ...(r.robot === true ? { robot: true } : {}) }
	let title = name
	try {
		title = (JSON.parse(readFileSync(join(examplesRoot, name, "example.json"), "utf8")) as { title?: string }).title ?? name
	} catch {
		// no example.json: the name stands for the title
	}
	return { seed, hash: createHash("sha256").update(bytes).digest("hex").slice(0, 12), title }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

// What is wrong with a seed's shape, or null. planChecks then checks it as a plan.
function seedProblem(v: unknown): string | null {
	if (!isObject(v)) return "it must be an object"
	if (typeof v.sentence !== "string") return "sentence must be text"
	if (!isObject(v.spec) || !Array.isArray(v.spec.boards) || !Array.isArray(v.spec.links)) return "spec must have boards and links lists"
	if (!isObject(v.briefs) || Object.values(v.briefs).some((b) => typeof b !== "string")) return "briefs must map board names to text"
	if (v.why !== undefined && typeof v.why !== "string") return "why must be text"
	for (const k of ["offBoard", "cantBuild", "optional"]) if (v[k] !== undefined && !Array.isArray(v[k])) return `${k} must be a list`
	if (v.layout !== undefined && !isObject(v.layout)) return "layout must be an object"
	return null
}

// The one check for "this example can be forked": the list offers Fork only where the route accepts it.
export const hasStarter = (examplesRoot: string, name: string) => STARTER_NAME.test(name) && existsSync(join(examplesRoot, name, "starter.json"))

// A seed from a system spec (its boards' briefs as text) or one brief (one board, "main"). The spec's own assembly
// is dropped: a plan places its boards at Build (buildSpec), so a fork that adds or removes a board stays consistent.
// Every designed board brings its brief's text: a board that is an existing run (no brief), or whose brief text wasn't
// given, is an error naming it, never an undefined entry in the seed's briefs (premerge review, 15 Nov).
export function starterSeed(input: { sentence: string; why: string; robot: boolean; spec?: SystemSpec; briefs: Record<string, string> }): StarterSeed {
	const designed = input.spec ? input.spec.boards.filter((b) => b.kind !== "bought") : [{ name: "main", brief: "main" } as SystemSpec["boards"][number]]
	const lacking = designed.filter((b) => !b.brief || typeof input.briefs[b.name] !== "string").map((b) => (b.brief ? `${b.name} (its brief ${b.brief} wasn't read)` : `${b.name} (no brief${b.run ? `: it is the existing run ${b.run}` : ""})`))
	if (lacking.length) throw new Error(`a starter seeds a plan from each designed board's brief; these have none: ${lacking.join(", ")}`)
	const spec: SystemSpec = input.spec
		? {
				name: input.spec.name,
				// A bought board (a compute module) stays bought, with no brief; a carrier keeps the board it carries and its choices.
				boards: input.spec.boards.map((b) =>
					b.kind === "bought"
						? { name: b.name, kind: "bought" as const, module: b.module }
						: { name: b.name, brief: `briefs/${b.name}.md`, ...(b.carries ? { carries: b.carries } : {}), ...(b.regulator ? { regulator: b.regulator } : {}), ...(b.bridge ? { bridge: b.bridge } : {}) },
				),
				links: input.spec.links,
			}
		: { name: input.sentence.slice(0, 60), boards: [{ name: "main", brief: "briefs/main.md" }], links: [] }
	const names = spec.boards.filter((b) => b.brief).map((b) => b.name)
	return {
		sentence: input.sentence,
		spec,
		briefs: Object.fromEntries(names.map((n) => [n, input.briefs[n]])),
		why: input.why,
		offBoard: [],
		cantBuild: [],
		layout: layoutFor(names),
		optional: [],
		...(input.robot ? { robot: true } : {}),
	}
}

// ── Lineage ──

export interface ForkResult {
	settled: boolean
	// The system's findings between boards; null for a one-board design (it has none of its own).
	findings: number | null
	status: string
}

export interface ForkRecord {
	at: string
	planId: string
	design: string
	starterHash: string
	// null when the fork's first version (its seed) can't be read: then diffUnknown says why. Never a false "no changes".
	diff: PlanDiff | null
	diffUnknown?: string
	result: ForkResult | null
}

// Under the plans tree (plans/starters is no plan id), so the lineage never shows up as a run or a design.
export const LINEAGE_DIR = ["plans", "starters"]
export const forksFile = (outRoot: string, starter: string) => join(outRoot, ...LINEAGE_DIR, starter, "forks.jsonl")

// The results written when a design ends without settling.
export const STOPPED = {
	exit: (code: number): ForkResult => ({ settled: false, findings: null, status: `stopped before it settled (exit ${code})` }),
	closed: { settled: false, findings: null, status: "stopped: the dashboard closed before it settled" } as ForkResult,
	restarted: { settled: false, findings: null, status: "stopped: the dashboard restarted before it settled" } as ForkResult,
}

// Every record still without a result, by starter and design.
export function openForkRecords(outRoot: string): { starter: string; design: string }[] {
	const root = join(outRoot, ...LINEAGE_DIR)
	if (!existsSync(root)) return []
	const out: { starter: string; design: string }[] = []
	for (const starter of readdirSync(root).filter((n) => STARTER_NAME.test(n))) {
		let text = ""
		try {
			text = readFileSync(forksFile(outRoot, starter), "utf8")
		} catch {
			continue
		}
		for (const l of text.split("\n").filter(Boolean)) {
			try {
				const r = JSON.parse(l) as ForkRecord
				if (r.result === null && typeof r.design === "string") out.push({ starter, design: r.design })
			} catch {
				// a broken line is left alone
			}
		}
	}
	return out
}

// A forked plan was built as `design`: one record, its result still unknown.
export function recordForkBuild(outRoot: string, plan: Plan, seed: Plan | null, design: string): ForkRecord | null {
	if (!plan.forkedFrom || !STARTER_NAME.test(plan.forkedFrom.starter)) return null
	const record: ForkRecord = { at: new Date().toISOString(), planId: plan.id, design, starterHash: plan.forkedFrom.hash, diff: seed ? planDiff(seed, plan) : null, ...(seed ? {} : { diffUnknown: "the plan's first version (history.jsonl) could not be read" }), result: null }
	mkdirSync(join(outRoot, ...LINEAGE_DIR, plan.forkedFrom.starter), { recursive: true })
	appendFileSync(forksFile(outRoot, plan.forkedFrom.starter), JSON.stringify(record) + "\n")
	return record
}

// The design's record gets its result (the first one only: a later change round doesn't rewrite how the build ended).
export function setForkResult(outRoot: string, starter: string, design: string, result: ForkResult): boolean {
	const file = forksFile(outRoot, starter)
	if (!existsSync(file)) return false
	let hit = false
	const lines = readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				const r = JSON.parse(l) as ForkRecord
				if (!hit && r.design === design && r.result === null) {
					hit = true
					return JSON.stringify({ ...r, result })
				}
			} catch {
				// a broken line stays as it is
			}
			return l
		})
	if (!hit) return false
	writeFileSync(`${file}.tmp`, lines.join("\n") + "\n")
	renameSync(`${file}.tmp`, file)
	return true
}

// How a built design ended, from its own files: a system's system-state.json once its settle loop has finished (a
// status that isn't "round N: …"), a single board's last design.settled event. Null while it is still working.
// `kind` defaults to what the folder holds (system.json marks a system).
export function designResult(designDir: string, kind: "system" | "board" = existsSync(join(designDir, "system.json")) ? "system" : "board"): ForkResult | null {
	if (kind === "system") {
		try {
			const s = JSON.parse(readFileSync(join(designDir, "system-state.json"), "utf8")) as { status?: string; settled?: boolean; findings?: unknown[] }
			if (typeof s.status !== "string" || /^round \d+:/.test(s.status)) return null
			return { settled: s.settled === true, findings: Array.isArray(s.findings) ? s.findings.length : 0, status: s.status }
		} catch {
			return null
		}
	}
	let settled: boolean | null = null
	try {
		for (const l of readFileSync(join(designDir, "trace.jsonl"), "utf8").split("\n")) {
			if (!l.includes('"design.settled"')) continue
			try {
				const e = JSON.parse(l) as { type?: string; payload?: { settled?: boolean } }
				if (e.type === "design.settled") settled = e.payload?.settled === true
			} catch {
				// a half-written line
			}
		}
	} catch {
		return null
	}
	return settled === null ? null : { settled, findings: null, status: settled ? "settled" : "unsettled" }
}
