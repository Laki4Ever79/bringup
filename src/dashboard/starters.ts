import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { layoutFor } from "../system/architect.ts"
import type { Plan } from "../system/plan.ts"
import type { SystemSpec } from "../system/spec.ts"

// Starters: an example (examples/<name>/example.json) plus its seed plan (starter.json), the Plan fields without the
// id, version and spend. Forking copies the seed into a new plan (PlanStore.fork); the starter file is only ever read.

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
