// Approve the plan before a paid run (design: docs/superpowers/specs/2026-11-26-plan-approval-design.md; the user, 26
// Nov 2026: "user should be presented the solution, so we are made sure they are happy with it" and "We do as much as
// possible to not waste user's money on useless iterations"). A real-model run starts only from a plan the person
// approved: what it will design, what the brief leaves open and the agents would assume, and its estimated time and
// cost. Making the plan costs nothing: plain code over the brief and the recorded runs, no model call. Mock runs are
// untouched.
//
// Run plans live machine-wide in <bringup home>/run-plans/<id>.json, so the MCP server, the CLI it launches and the
// page all see the same approval.
import { PRODUCT } from "../brand/names.js"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { bringupHome } from "../tools/env.ts"
import { resolveProvider } from "../inference/providers.ts"
import { estimate } from "./estimate.ts"
import { briefKind } from "../contract/design-kind.ts"
import { runTimeText } from "../runner/run-time.ts"
import type { Plan } from "./plan.ts"

export interface BriefQuestion {
	topic: "size" | "power" | "environment" | "job"
	answered: boolean
	// What the agents would assume when the brief doesn't say, so the person can say it before paying.
	assumption?: string
}
export interface RunPlan {
	id: string
	kind: "brief" | "system"
	subjectHash: string // sha256 of the brief text or the system spec's JSON: an approval is for exactly that
	title: string
	questions: BriefQuestion[]
	boards: number
	estimate: { minutes: [number, number] | null; usd: [number, number] | null; basis: string }
	provider: string | null
	planCostUsd: number
	// How long the run may take (runner/run-time.ts): read at the plan, so the person approves the time too.
	runTime?: string
	createdAt: string
	approvedAt: string | null
}

const PLAN_ID = /^rp-[0-9a-f]{12}$/
// BRINGUP_RUN_PLANS moves them (the tests keep theirs in a temporary folder: test/helpers.ts).
export const runPlansDir = () => process.env.BRINGUP_RUN_PLANS ?? join(bringupHome(), "run-plans")
export const subjectHash = (subject: string) => createHash("sha256").update(subject.replace(/\r\n/g, "\n").trim()).digest("hex")

// What a brief leaves open, found in plain code. Each topic is "answered" when the brief states it.
export function briefQuestions(brief: string): BriefQuestion[] {
	const t = brief.toLowerCase()
	const size = /\b\d+(?:[.,]\d+)?\s*(?:mm|cm|m)\b|\b\d+\s*[x×]\s*\d+\b|\bpocket|\bdesktop|\bhandheld|\bsmall as\b/.test(t)
	const power = /\bbatter(?:y|ies)|\bli-?(?:ion|po)\b|\b\d+s\b.*cell|\bcell\b|\busb\b|\busb-c\b|\bmains\b|\bbrick\b|\badapter\b|\bsolar\b|\b\d+(?:[.,]\d+)?\s*v\b|\bvolt/.test(t)
	const env = /\bindoor|\boutdoor|\bwaterproof|\bsplash|\bip\d\d\b|\bhumid|\bdust|\b-?\d+\s*°?c\b|\btemperature range|\bkitchen|\bgarden|\bgreenhouse|\bfloor|\btable\b|\barena|\bdesk\b|\bhome\b|\boffice\b|\bfield\b/.test(t)
	const job = /\bmeasur|\bsens(?:e|or)|\blog(?:s|ger|ging)?\b|\bcarr(?:y|ies)|\bpayload|\bpick|\bdrive|\bmove|\bfollow|\bdetect|\bcontrol|\bdisplay|\bblink|\bmonitor|\breport|\bsend/.test(t)
	return [
		size ? { topic: "size", answered: true } : { topic: "size", answered: false, assumption: "the smallest board that fits the parts (compact by default), in a case unless the brief says otherwise" },
		power ? { topic: "power", answered: true } : { topic: "power", answered: false, assumption: "USB-C power, no battery" },
		env ? { topic: "environment", answered: true } : { topic: "environment", answered: false, assumption: "indoors, room temperature, no water or dust protection" },
		job ? { topic: "job", answered: true } : { topic: "job", answered: false, assumption: "the agents infer what it senses or does from the brief's words; a vague job is the most likely reason for a second paid run" },
	]
}

function save(p: RunPlan): RunPlan {
	mkdirSync(runPlansDir(), { recursive: true })
	writeFileSync(join(runPlansDir(), `${p.id}.json`), JSON.stringify(p, null, 1))
	return p
}

export function readRunPlan(id: string): RunPlan | null {
	if (!PLAN_ID.test(id)) return null
	const f = join(runPlansDir(), `${id}.json`)
	return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as RunPlan) : null
}

// A system spec names each board's brief as a file (briefs/main.md, relative to the repo or the cwd) or gives the text:
// the questions read the text either way (a path's words would make every topic look open).
const REPO = resolve(import.meta.dirname, "../..")
export function briefText(brief: string | undefined): string {
	if (!brief) return ""
	if (/\.md$/.test(brief.trim())) for (const base of [REPO, process.cwd()]) {
		const f = resolve(base, brief.trim())
		if (existsSync(f)) return readFileSync(f, "utf8")
	}
	return brief
}

// The plan for a brief (one board) or a system spec (its boards), estimated from the runs recorded under outRoot.
export function makeRunPlan(subject: { brief: string } | { system: { name?: string; boards: { name: string; brief?: string }[] }; briefs?: string[] }, outRoot: string, env: Record<string, string | undefined> = process.env, now = new Date(), subjectText?: string): RunPlan {
	const isBrief = "brief" in subject
	const text = subjectText ?? (isBrief ? subject.brief : JSON.stringify(subject.system))
	const briefs = isBrief ? [subject.brief] : (subject.briefs ?? subject.system.boards.map((b) => briefText(b.brief)))
	const boards = isBrief ? 1 : Math.max(1, subject.system.boards.length)
	// Each board's open questions together: a topic is open when any board's brief leaves it open.
	const perBoard = briefs.map(briefQuestions)
	const questions = perBoard[0].map((q, i) => (perBoard.every((b) => b[i].answered) ? q : perBoard.find((b) => !b[i].answered)![i]))
	const title = isBrief ? (/^#\s*(?:Brief:\s*)?(.+)$/m.exec(subject.brief)?.[1] ?? subject.brief.split("\n")[0]).slice(0, 120) : (subject.system.name ?? "a system")
	const est = estimate({ spec: { boards: Array.from({ length: boards }, (_, i) => ({ name: `b${i}` })) } } as unknown as Plan, outRoot, isBrief ? briefKind(subject.brief) : undefined)
	return save({ id: `rp-${randomBytes(6).toString("hex")}`, kind: isBrief ? "brief" : "system", subjectHash: subjectHash(text), title, questions, boards, estimate: est, provider: resolveProvider(env)?.id ?? null, planCostUsd: 0, runTime: runTimeText(env), createdAt: now.toISOString(), approvedAt: null })
}

export function approveRunPlan(id: string, now = new Date()): RunPlan | null {
	const p = readRunPlan(id)
	if (!p) return null
	return p.approvedAt ? p : save({ ...p, approvedAt: now.toISOString() })
}

// Why a paid run may not start (null: it may): no plan, a plan not yet approved, or a plan for something else.
export function paidStartRefusal(planId: string | undefined, subject: string): string | null {
	if (!planId) return "a real-model run starts from an approved plan: call plan_design first, show the plan to your user, and approve_plan only once they say yes (the design-only mock run needs none)"
	const p = readRunPlan(planId)
	if (!p) return `no plan ${planId}: call plan_design again`
	if (!p.approvedAt) return `plan ${planId} isn't approved yet: show it to your user and call approve_plan only once they say yes`
	if (p.subjectHash !== subjectHash(subject)) return `plan ${planId} was made for a different brief or system: make a plan for this one (plan_design)`
	return null
}

const money = (r: [number, number] | null) => (r ? (r[0] === r[1] ? `$${r[0].toFixed(2)}` : `$${r[0].toFixed(2)}–$${r[1].toFixed(2)}`) : "no estimate yet")
const mins = (r: [number, number] | null) => (r ? `${Math.round(r[0])}–${Math.round(r[1])} min` : "no estimate yet")

// The plan as a person reads it (the CLI prints it; the MCP returns it for the agent to show).
export function planText(p: RunPlan): string {
	const open = p.questions.filter((q) => !q.answered)
	return [
		`Plan ${p.id}: ${p.title} (${p.boards} board${p.boards > 1 ? "s" : ""})`,
		`Estimate: ${mins(p.estimate.minutes)}, ${money(p.estimate.usd)} on ${p.provider ?? "no AI configured"}. ${p.estimate.basis}`,
		...(p.runTime ? [p.runTime] : []),
		open.length ? `The brief leaves open (the agents would assume this; say it in the brief to change it):\n${open.map((q) => `  - ${q.topic}: ${q.assumption}`).join("\n")}` : "The brief states its size, power, environment and job.",
		`${PRODUCT} does its best and runs every check, but a first design isn't guaranteed to work; the clearer the brief, the fewer paid runs.`,
		`This plan cost $${p.planCostUsd.toFixed(2)} (plain code, no model call).`,
	].join("\n")
}

// The CLI's gate for a real-model run: an approved --plan for this subject; or the plan printed and a yes (on a terminal,
// or --yes for scripts that accept what they printed); or the plan a parent run approved (a system's board runs inherit
// BRINGUP_PLAN_APPROVED). Returns the approved plan's id, or why the run doesn't start.
export async function cliPaidGate(subject: Parameters<typeof makeRunPlan>[0], subjectText: string, o: { argv: string[]; outRoot: string; env: Record<string, string | undefined>; isTTY: boolean; ask: (q: string) => Promise<string>; log: (s: string) => void }): Promise<{ planId: string } | { refused: string }> {
	const inherited = o.env.BRINGUP_PLAN_APPROVED
	if (inherited && readRunPlan(inherited)?.approvedAt) return { planId: inherited }
	const i = o.argv.indexOf("--plan")
	if (i >= 0) {
		const id = o.argv[i + 1]
		const why = paidStartRefusal(id, subjectText)
		return why ? { refused: why } : { planId: id }
	}
	const p = makeRunPlan(subject, o.outRoot, o.env, new Date(), subjectText)
	o.log(planText(p))
	if (o.argv.includes("--yes")) return { planId: approveRunPlan(p.id)!.id }
	if (!o.isTTY) return { refused: `a real-model run starts from an approved plan: rerun with --yes to approve the plan above, or approve it elsewhere and pass --plan ${p.id} (or --mock for the free design-only run)` }
	const money = p.estimate.usd ? `about $${p.estimate.usd[0].toFixed(2)}–$${p.estimate.usd[1].toFixed(2)}` : "an unknown cost (no estimate yet)"
	const answer = (await o.ask(`Build this for ${money}? [y/N] `)).trim().toLowerCase()
	return answer === "y" || answer === "yes" ? { planId: approveRunPlan(p.id)!.id } : { refused: `not approved: plan ${p.id} is kept; change the brief and run again, or pass --plan ${p.id} after approving` }
}
