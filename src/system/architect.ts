import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { callModel, NoModelKey } from "../dashboard/ask.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import type { UsageRecord } from "../inference/usage.ts"
import { specErrors, type SystemSpec } from "./spec.ts"
import { boardNameIssue, type Plan } from "./plan.ts"

// The system architect: a sentence (or a plan plus a change in words) becomes a plan of boards, cables and briefs. One
// model call on the fast model; scripted mode answers from fixed plans so the whole flow is free to try and test.

export type ProposedPlan = Omit<Plan, "id" | "version" | "spendUsd">

export class PlanInvalid extends Error {
	readonly code = "PLAN_INVALID"
	constructor(readonly errors: string[]) {
		super(`the architect's plan is still invalid after a retry: ${errors.join("; ")}`)
	}
}

const ROOT = resolve(import.meta.dirname, "../..")
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8")

// What a board can be made of, from the catalog itself so it never drifts from what the pipeline can build.
export const BUILDABLE: string = (() => {
	const byRole = new Map<string, string[]>()
	for (const p of loadCatalog(ROOT)) byRole.set(p.role, [...(byRole.get(p.role) ?? []), p.mpn])
	const parts = [...byRole].map(([role, mpns]) => `- ${role}: ${mpns.join(", ")}`).join("\n")
	return `Every board is a small ESP32-C3 board (BLE, one free UART, one I2C bus), powered from USB-C and/or one Li-ion cell, built only from these catalog parts:\n${parts}\nBoards connect by cable links of kind "uart" (at most one per board) or "i2c" (one board is the controller, the others targets with 7-bit addresses 0x08-0x77; exactly one board fits the pull-ups). Nothing else can be built yet: no motors, motor drivers, servos, wheels, cameras, screens, speakers or relays.`
})()

// Things people ask for that no board can have yet, and why.
const CANT: [RegExp, string, string][] = [
	[/\bmotors?\b|\bmotor driver\b/i, "motors", "needs project 2 (mechanics): motor data, drivers and drive checks"],
	[/\bservos?\b/i, "servos", "needs project 2 (mechanics)"],
	[/\bwheels?\b|\brover\b|\brobot\b/i, "wheels and chassis", "needs project 2 (mechanics)"],
	[/\bcamera\b/i, "a camera", "no such part in the catalog yet"],
	[/\bscreen\b|\bdisplay\b/i, "a screen", "no such part in the catalog yet"],
	[/\bspeaker\b|\bbuzzer\b/i, "a speaker", "no such part in the catalog yet"],
	[/\brelay\b/i, "a relay", "no such part in the catalog yet"],
]
export const cantBuildFrom = (sentence: string) => CANT.filter(([re]) => re.test(sentence)).map(([, what, reason]) => ({ what, reason }))

// Card positions for the plan drawing: a row, keeping positions the user already dragged.
export function layoutFor(names: string[], keep: Record<string, { x: number; y: number }> = {}): Record<string, { x: number; y: number }> {
	return Object.fromEntries(names.map((n, i) => [n, keep[n] ?? { x: 40 + i * 260, y: 120 }]))
}

const withPlanBriefs = (spec: SystemSpec): SystemSpec => ({ ...spec, boards: spec.boards.map((b) => ({ name: b.name, brief: `briefs/${b.name}.md` })) })

export function scriptedPlan(sentence: string): ProposedPlan {
	const cantBuild = cantBuildFrom(sentence)
	const several = /\band\b|\btwo\b|\bboth\b|\bplus\b|\bseveral\b|\bboards\b/i.test(sentence)
	if (!several) {
		const name = /beacon/i.test(sentence) ? "beacon" : "logger"
		return {
			sentence,
			spec: { name: sentence.slice(0, 60), boards: [{ name, brief: `briefs/${name}.md` }], links: [] },
			briefs: { [name]: read(`briefs/${name}.md`) },
			why: "One device, so one board. (Scripted architect: it knows the logger and the beacon only.)",
			offBoard: [],
			cantBuild,
			layout: layoutFor([name]),
			optional: [],
		}
	}
	const spec = withPlanBriefs(JSON.parse(read("briefs/systems/logger-beacon-uart.json")) as SystemSpec)
	return {
		sentence,
		spec,
		briefs: { logger: read("briefs/logger.md"), beacon: read("briefs/beacon.md") },
		why: "The logger measures and keeps the history; the beacon is the small part people carry or stick somewhere, so it is its own board, joined by a UART cable that carries each reading. (Scripted architect: it always proposes this split.)",
		offBoard: [],
		cantBuild,
		layout: layoutFor(["logger", "beacon"]),
		optional: [],
	}
}

// The scripted architect understands one change in words: "remove <board>".
function scriptedChange(plan: Plan, instruction: string): ProposedPlan {
	const base: ProposedPlan = { sentence: plan.sentence, spec: plan.spec, briefs: plan.briefs, why: plan.why, offBoard: plan.offBoard, cantBuild: plan.cantBuild, layout: plan.layout, optional: plan.optional }
	const gone = /\b(?:remove|drop|delete)\s+(?:the\s+)?([\w-]+)/i.exec(instruction)?.[1]
	if (!gone || !plan.spec.boards.some((b) => b.name === gone)) return { ...base, why: `${plan.why}\n\n(The scripted architect can only "remove <board>"; "${instruction}" needs real models.)` }
	const { [gone]: _b, ...briefs } = plan.briefs
	const { [gone]: _l, ...layout } = plan.layout
	return {
		...base,
		spec: { ...plan.spec, boards: plan.spec.boards.filter((b) => b.name !== gone), links: plan.spec.links.filter((l) => l.a.board !== gone && l.b.board !== gone) },
		briefs,
		layout,
		optional: plan.optional.filter((n) => n !== gone),
		why: `${plan.why}\n\nRemoved ${gone} as asked.`,
	}
}

const SYSTEM = `You are the system architect of Bringup, which designs small electronic devices made of one or more custom boards joined by cables. Split the user's device into boards and cable links. Use as few boards as the device needs: a second board only when a part must sit elsewhere (a remote sensor, a carried tag) or to keep noise or power apart. Say plainly what can't be built.

${BUILDABLE}

Answer with one JSON object, no prose around it:
{"spec": {"name": string, "boards": [{"name": lowercase-id}], "links": [{"id": "L1", "kind": "uart"|"i2c", "a": {"board": name}, "b": {"board": name}, "baud"?: 115200, "i2c"?: {"controller": name, "targets": {name: address}, "pullupsOn": name, "khz"?: 100}, "power"?: {"from": name}, "cable": {"lengthMm": number}, "messages"?: [{"name": string, "from": name, "fields": [{"name": string, "type": "u8"|"u16"|"i16"|"u32"|"f32"}]}]}]},
 "briefs": {name: markdown brief: "# Brief: <title>", "## What we want" (2-3 sentences), "## Must have" (bullets with numbers: battery life, size in mm, sensing accuracy)},
 "why": one or two plain sentences on why this split,
 "offBoard": [{"name": a bought part like a battery, "attachesTo": board name}],
 "cantBuild": [{"what": string, "reason": string}],
 "optional": [board names that are nice to have]}`

const stripFence = (t: string) => t.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "")

function validate(raw: unknown): { plan: Omit<ProposedPlan, "sentence" | "layout"> | null; errors: string[] } {
	const o = raw as Partial<ProposedPlan> | null
	if (!o || typeof o !== "object" || !o.spec || !Array.isArray(o.spec.boards) || !Array.isArray(o.spec.links)) return { plan: null, errors: ["the answer must be a JSON object with spec.boards and spec.links arrays"] }
	const spec = withPlanBriefs(o.spec)
	const briefs = (o.briefs ?? {}) as Record<string, string>
	const errors = specErrors(spec)
	for (const b of spec.boards) {
		const bad = boardNameIssue(b.name)
		if (bad) errors.push(bad)
	}
	for (const b of spec.boards) if (typeof briefs[b.name] !== "string" || !briefs[b.name].trim()) errors.push(`board ${b.name}: write its brief`)
	if (!spec.boards.length) errors.push("the plan needs at least one board")
	if (errors.length) return { plan: null, errors }
	return { plan: { spec, briefs, why: String(o.why ?? ""), offBoard: Array.isArray(o.offBoard) ? o.offBoard : [], cantBuild: Array.isArray(o.cantBuild) ? o.cantBuild : [], optional: Array.isArray(o.optional) ? o.optional : [] }, errors: [] }
}

export async function proposePlan(
	input: { sentence: string } | { plan: Plan; instruction: string },
	deps: { mock: boolean; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; onUsage?: (r: UsageRecord) => void },
): Promise<ProposedPlan> {
	if (deps.mock) return "sentence" in input ? scriptedPlan(input.sentence) : scriptedChange(input.plan, input.instruction)
	const env = deps.env ?? process.env
	if (!env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY) throw new NoModelKey()
	const sentence = "sentence" in input ? input.sentence : input.plan.sentence
	const ask =
		"sentence" in input
			? `The device: ${input.sentence}`
			: `The device: ${input.plan.sentence}\n\nThe current plan:\n${JSON.stringify({ spec: input.plan.spec, briefs: input.plan.briefs, why: input.plan.why, offBoard: input.plan.offBoard, cantBuild: input.plan.cantBuild, optional: input.plan.optional })}\n\nChange it as asked, keeping everything else: ${input.instruction}`
	let errors: string[] = []
	for (let attempt = 0; attempt < 2; attempt++) {
		const user = attempt === 0 ? ask : `${ask}\n\nYour previous answer was invalid: ${errors.join("; ")}. Answer again with a corrected JSON object.`
		const text = await callModel({ system: SYSTEM, user }, env, deps.fetchImpl ?? fetch, deps.onUsage, { role: "integrator", maxTokens: 6000, json: true, source: "architect" })
		let raw: unknown = null
		try {
			raw = JSON.parse(stripFence(text))
		} catch {
			errors = ["the answer was not valid JSON"]
			continue
		}
		const v = validate(raw)
		if (v.plan) {
			const keep = "plan" in input ? input.plan.layout : {}
			// What the sentence asks for that no board can have stays listed even when the model leaves it out.
			const named = new Set(v.plan.cantBuild.map((c) => String(c.what).toLowerCase()))
			const cantBuild = [...v.plan.cantBuild, ...cantBuildFrom(sentence).filter((c) => ![...named].some((n) => n.includes(c.what.replace(/s$/, ""))))]
			return { ...v.plan, cantBuild, sentence, layout: layoutFor(v.plan.spec.boards.map((b) => b.name), keep) }
		}
		errors = v.errors
	}
	throw new PlanInvalid(errors)
}
