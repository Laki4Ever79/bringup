import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
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
	let seed: StarterSeed
	try {
		seed = JSON.parse(bytes.toString("utf8")) as StarterSeed
	} catch {
		throw httpError(500, `examples/${name}/starter.json is not JSON`)
	}
	let title = name
	try {
		title = (JSON.parse(readFileSync(join(examplesRoot, name, "example.json"), "utf8")) as { title?: string }).title ?? name
	} catch {
		// no example.json: the name stands for the title
	}
	return { seed, hash: createHash("sha256").update(bytes).digest("hex").slice(0, 12), title }
}

export const hasStarter = (examplesRoot: string, name: string) => STARTER_NAME.test(name) && existsSync(join(examplesRoot, name, "starter.json"))

// A seed from a system spec (its boards' briefs as text) or one brief (one board, "main"). The spec's own assembly
// is dropped: a plan places its boards at Build (buildSpec), so a fork that adds or removes a board stays consistent.
export function starterSeed(input: { sentence: string; why: string; robot: boolean; spec?: SystemSpec; briefs: Record<string, string> }): StarterSeed {
	const spec: SystemSpec = input.spec
		? { name: input.spec.name, boards: input.spec.boards.map((b) => ({ name: b.name, brief: `briefs/${b.name}.md` })), links: input.spec.links }
		: { name: input.sentence.slice(0, 60), boards: [{ name: "main", brief: "briefs/main.md" }], links: [] }
	const names = spec.boards.map((b) => b.name)
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
	diff: PlanDiff
	result: ForkResult | null
}

export const forksFile = (outRoot: string, starter: string) => join(outRoot, "starters", starter, "forks.jsonl")

// A forked plan was built as `design`: one record, its result still unknown.
export function recordForkBuild(outRoot: string, plan: Plan, seed: Plan, design: string): ForkRecord | null {
	if (!plan.forkedFrom || !STARTER_NAME.test(plan.forkedFrom.starter)) return null
	const record: ForkRecord = { at: new Date().toISOString(), planId: plan.id, design, starterHash: plan.forkedFrom.hash, diff: planDiff(seed, plan), result: null }
	mkdirSync(join(outRoot, "starters", plan.forkedFrom.starter), { recursive: true })
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
export function designResult(designDir: string): ForkResult | null {
	if (existsSync(join(designDir, "system.json"))) {
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
