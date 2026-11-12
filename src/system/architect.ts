import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { callModel, NoModelKey } from "../dashboard/ask.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import type { UsageRecord } from "../inference/usage.ts"
import { specErrors, type SystemSpec } from "./spec.ts"
import { BUILT_KINDS } from "../contract/link-kinds.ts"
import { boardNameIssue, type Plan } from "./plan.ts"
import { loadKinds } from "../learn/kinds.ts"
import type { PartNeed } from "../learn/types.ts"

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
	return `Every board is a small board on one MCU, by default an ESP32-C3 (BLE, one free UART, one I2C bus); a board's brief may name another catalog MCU (an STM32 has no radio, and its own UART and I2C counts). Boards are powered from USB-C and/or one Li-ion cell, built only from these catalog parts:\n${parts}\nBoards connect by cable links of kind "uart" (at most one per board) or "i2c" (one board is the controller, the others targets with 7-bit addresses 0x08-0x77; exactly one board fits the pull-ups). A board can also drive a small wheeled robot (one board on a printed chassis): differential drive with two DC gearmotors, a caster, a DRV8833 motor driver and a VL53L0X distance sensor, from catalog/mechanics.json (the mechanics checks and a simulated drive prove it). A part the catalog lacks can still be used when it is of a kind Bringup learns by itself from its datasheet (list it under "needs"): ${[...learnableKinds()].join(", ")}. Nothing else can be built yet: no servos, cameras, screens or relays.`
})()

// Things people ask for that no board can have yet, and why.
// The fourth entry, when there is one, is the part kind that would make it buildable: once catalog/kinds/ has that kind,
// the part learner learns such a part at plan time and it is no longer can't-build.
const CANT: [RegExp, string, string, string?][] = [
	// Motors, wheels and a chassis are buildable since the mechanics backend (a wheeled robot); servos are not.
	[/\bservos?\b/i, "servos", "no servo in the mechanics catalog yet (a wheeled robot's DC gearmotors are)"],
	[/\bcamera\b/i, "a camera", "no such part in the catalog yet"],
	[/\bscreen\b|\bdisplay\b/i, "a screen", "no such part in the catalog yet"],
	[/\bspeaker\b|\bbuzzer\b/i, "a speaker", "no such part in the catalog yet", "speaker-driver"],
	[/\brelay\b/i, "a relay", "no such part in the catalog yet"],
]
// Kinds the part learner may learn for a plan: those with a kind file but no role in the hand catalog (a learned part
// must not become an alternative for a role the board code already wires, until plan 2 wires learned parts), and never
// a chip (the chip learner is a separate tool).
export function learnableKinds(): Set<string> {
	const roles = new Set((JSON.parse(read("catalog/parts.json")) as { role: string }[]).map((p) => p.role))
	return new Set([...loadKinds(ROOT).keys()].filter((k) => k !== "mcu" && !roles.has(k)))
}
const LEARNABLE = learnableKinds()
export const cantBuildFrom = (sentence: string) => CANT.filter(([re, , , kind]) => re.test(sentence) && !(kind && LEARNABLE.has(kind))).map(([, what, reason]) => ({ what, reason }))

// The parts a sentence asks for that the part learner can learn (the scripted architect's needs): a speaker and the
// amplifier that drives it.
export function scriptedNeeds(sentence: string, board: string): PartNeed[] {
	if (!/\bspeaker\b|\bchime\b|\btalking\b/i.test(sentence) || !LEARNABLE.has("speaker-driver") || !LEARNABLE.has("amplifier")) return []
	return [
		{ id: "speaker", role: "speaker", kind: "speaker-driver", requirements: "a small speaker, about 40 mm, 8 ohm, 2-3 W, for spoken prompts and chimes", board },
		{ id: "amplifier", role: "amplifier", kind: "amplifier", requirements: "an I2S class-D amplifier that drives the speaker from the board's supply", board },
	]
}

// Card positions for the plan drawing: a row, keeping positions the user already dragged.
export function layoutFor(names: string[], keep: Record<string, { x: number; y: number }> = {}): Record<string, { x: number; y: number }> {
	return Object.fromEntries(names.map((n, i) => [n, keep[n] ?? { x: 40 + i * 260, y: 120 }]))
}

const withPlanBriefs = (spec: SystemSpec): SystemSpec => ({ ...spec, boards: spec.boards.map((b) => ({ name: b.name, brief: `briefs/${b.name}.md` })) })

export function scriptedPlan(sentence: string): ProposedPlan {
	const cantBuild = cantBuildFrom(sentence)
	// The scripted architect knows the designs the scripted agents can build: the logger, the beacon and the rover. It
	// splits into two boards only when the sentence names both known boards, or asks for boards joined by a cable: "and"
	// alone is not two boards (the rover example's sentence got a logger and a beacon, 11 Nov).
	const robot = /\b(rover|robot|wheels?|wheeled|drives?)\b/i.test(sentence)
	const both = /logger|climate|temperature/i.test(sentence) && /beacon|tag/i.test(sentence)
	const several = !robot && (both || /\btwo\b.*\bboards?\b|\bboards\b|\bcable\b|\bseveral\b/i.test(sentence))
	if (!several) {
		const name = robot ? "rover" : /beacon/i.test(sentence) ? "beacon" : "logger"
		const needs = scriptedNeeds(sentence, name)
		return {
			...(needs.length ? { needs } : {}),
			sentence,
			spec: { name: sentence.slice(0, 60), boards: [{ name, brief: `briefs/${name}.md` }], links: [] },
			briefs: { [name]: read(`briefs/${name}.md`) },
			why: `One device, so one board: the ${name}. (Scripted architect: it picks one of the designs the free agents can build, the logger, the beacon or the rover; for your own design, untick "Try for free".)`,
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
{"spec": {"name": string, "boards": [{"name": lowercase-id}], "links": [{"id": "L1", "kind": ${BUILT_KINDS.map((k) => `"${k}"`).join("|")}, "a": {"board": name}, "b": {"board": name}, "baud"?: 115200, "i2c"?: {"controller": name, "targets": {name: address}, "pullupsOn": name, "khz"?: 100}, "power"?: {"from": name}, "cable": {"lengthMm": number}, "messages"?: [{"name": string, "from": name, "fields": [{"name": string, "type": "u8"|"u16"|"i16"|"u32"|"f32"}]}]}]},
 "briefs": {name: markdown brief: "# Brief: <title>", "## What we want" (2-3 sentences), "## Must have" (bullets with numbers: battery life, size in mm, sensing accuracy)},
 "why": one or two plain sentences on why this split,
 "offBoard": [{"name": a bought part like a battery, "attachesTo": board name}],
 "cantBuild": [{"what": string, "reason": string}],
 "needs": [{"id": short-id, "role": string, "kind": one of the learnable kinds, "requirements": what it must do, with numbers, "board": board name}],
 "optional": [board names that are nice to have]}`

const stripFence = (t: string) => t.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "")

// The architect's needs, kept only when their kind can be learned; ids made unique and safe.
export function validNeeds(raw: unknown, spec: SystemSpec): PartNeed[] {
	if (!Array.isArray(raw)) return []
	const out: PartNeed[] = []
	for (const n of raw as Record<string, unknown>[]) {
		if (typeof n?.kind !== "string" || !LEARNABLE.has(n.kind) || typeof n.requirements !== "string") continue
		const base = String(n.id ?? n.kind).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30) || n.kind
		let id = base
		for (let i = 2; out.some((x) => x.id === id); i++) id = `${base}-${i}`
		const board = typeof n.board === "string" && spec.boards.some((b) => b.name === n.board) ? n.board : spec.boards[0]?.name
		out.push({ id, role: typeof n.role === "string" && n.role ? n.role : n.kind, kind: n.kind, requirements: n.requirements, ...(board ? { board } : {}) })
	}
	return out
}

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
	const needs = validNeeds((o as { needs?: unknown }).needs, spec)
	return { plan: { spec, briefs, why: String(o.why ?? ""), offBoard: Array.isArray(o.offBoard) ? o.offBoard : [], cantBuild: Array.isArray(o.cantBuild) ? o.cantBuild : [], optional: Array.isArray(o.optional) ? o.optional : [], ...(needs.length ? { needs } : {}) }, errors: [] }
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
