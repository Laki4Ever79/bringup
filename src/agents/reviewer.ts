import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createAgent, DeveloperMessageItem, ModelContext, type Agent, type Tool } from "@mozaik-ai/core"
import { checkConsistency } from "../contract/consistency.ts"
import { FIELDS, type ContractSnapshot } from "../contract/types.ts"
import { isEvent, makeEvent, type ReviewFinding } from "../events.ts"
import { modelFor } from "../inference/models.ts"
import { emit, join as joinRuntime, safeRunLoop, state } from "../runtime.ts"
import { when } from "../change-control.ts"
import type { Env } from "../tools/env.ts"
import { simulatePower } from "../tools/spice.ts"
import { isStub } from "../tools/stubs.ts"

export const MAX_REVIEW_ROUNDS = 1

const INSTRUCTION = `You are a demanding hardware design reviewer. Judge the design ONLY against the product brief: does the design contract meet every requirement the brief states, and does any choice clearly undermine one?
You see the brief, the final design contract and the results of the deterministic checks (builds, consistency, pin grounding, power simulation). You do not see how the design was made, and you do not need to.
- Check each "must have" in the brief against the contract: present, and plausibly met.
- Battery life: do the arithmetic and show the numbers (capacity in mAh, average current in µA or mA, including regulator quiescent current and the duty cycle the brief implies, then days).
- Severity: blocker = a must-have cannot be met as designed; major = a requirement is at risk or a choice clearly works against it; minor = worth improving but the brief is met.
- No style nitpicks and no requests outside the brief's scope.
- Verdict "fail" only when a brief requirement is not met or a choice clearly undermines it; otherwise "pass" (minor findings are fine with a pass).
- Name the contract fields each finding concerns (${FIELDS.join(", ")}) so it reaches their owner.
Call submit_review exactly once.`

const lines = <T>(xs: T[], show: (x: T) => string, none: string) => (xs.length === 0 ? none : xs.map((x) => `- ${show(x)}`).join("\n"))

async function powerSummary(env: Env | undefined, s: ContractSnapshot, dir: string): Promise<string> {
	if (!env?.kicad) return "Power was not simulated (no KiCad/ngspice on this machine)."
	if (!s.values.rails?.length) return "Power was not simulated (the contract has no rails)."
	try {
		const report = await simulatePower(env.root, dir, s)
		return [
			"ngspice, behavioural LDO with worst-case dropout, per supply scenario:",
			...report.scenarios.map(
				(x) => `- ${x.name} (${x.vinV} V) rail ${x.rail}: vout ${x.voutV.toFixed(3)} V, dropout headroom ${x.headroomMv} mV, regulator dissipation ${x.dissipationMw} mW, ${x.ok ? "in regulation" : "OUT OF REGULATION"}`,
			),
		].join("\n")
	} catch (error) {
		return `Power simulation failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
	}
}

// The reviewer's whole view of the run: the brief, the contract and the check results. Never an agent's turn.
export async function reviewMessage(env: Env | undefined, revision: number, round: number): Promise<string> {
	const s = state()
	const snapshot = s.contract.snapshot()
	const briefPath = join(s.outDir, "brief.md")
	const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8").trim() : "(brief missing)"
	const artifacts = (["board", "enclosure", "firmware"] as const).map((k) => {
		const a = s.artifacts[k]
		const failure = s.artifactFailures[k]
		if (failure) return `${k}: build FAILED: ${failure.split("\n")[0]}`
		if (!a) return `${k}: not built`
		const fw = k === "firmware" ? ((a as { ok: boolean }).ok ? ", compiles" : ", does NOT compile") : ""
		return `${k}: built for revision ${a.revision}${fw}${isStub(a) ? " (stubbed: derived from the contract, not a real build)" : ""}`
	})
	const violations = checkConsistency(snapshot, s.artifacts)
	const power = await powerSummary(env, snapshot, join(s.outDir, "power", `rev-${revision}`))
	return [
		`Brief review of revision ${revision} (review ${round} of at most ${s.review.maxRounds + 1}).`,
		"",
		"## Product brief",
		brief,
		"",
		"## Design contract",
		"```json",
		JSON.stringify(snapshot.values, null, 2),
		"```",
		"",
		"## Check results",
		"Artifacts:",
		...artifacts.map((a) => `- ${a}`),
		"Consistency violations (artifacts against the contract):",
		lines(violations, (v) => `${v.kind}: ${v.message}`, "- none"),
		"Grounding findings (part pins against the catalog and KiCad symbols):",
		lines(s.groundingFindings, (f) => `${f.kind} on ${f.partRef}: ${f.detail}`, "- none"),
		"Power:",
		power,
	].join("\n")
}

function submitReviewTool(self: { id: string }, pending: { revision: number | null }): Tool {
	return {
		type: "function",
		name: "submit_review",
		description: "Submit your verdict on the design against the brief. Call exactly once.",
		parameters: {
			type: "object",
			properties: {
				verdict: { type: "string", enum: ["pass", "fail"] },
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							severity: { type: "string", enum: ["blocker", "major", "minor"] },
							fields: { type: "array", items: { type: "string", enum: [...FIELDS] } },
							issue: { type: "string" },
							suggestion: { type: "string" },
						},
						required: ["severity", "fields", "issue", "suggestion"],
					},
				},
			},
			required: ["verdict", "findings"],
		},
		strict: false,
		invoke: async (args: { verdict: string; findings: ReviewFinding[] }) => {
			if (pending.revision === null) return { error: "no review is open; your verdict was already submitted" }
			if (args.verdict !== "pass" && args.verdict !== "fail") return { error: 'verdict must be "pass" or "fail"' }
			const findings = (Array.isArray(args.findings) ? args.findings : []).map((f) => ({
				severity: (["blocker", "major", "minor"] as const).find((x) => x === f.severity) ?? "major",
				fields: (Array.isArray(f.fields) ? f.fields : []).filter((x) => (FIELDS as readonly string[]).includes(x)),
				issue: String(f.issue ?? ""),
				suggestion: String(f.suggestion ?? ""),
			}))
			const revision = pending.revision
			pending.revision = null
			emit(makeEvent("review.completed", self.id, { revision, verdict: args.verdict, findings }), self.id)
			return { recorded: true, revision, verdict: args.verdict, findings: findings.length }
		},
	}
}

// The LLM brief reviewer: on design.ready it judges the design in a fresh context that holds only its
// instruction and one message (reviewMessage), then answers with submit_review. It owns no contract field and has
// no contract tools, so it can only judge, never edit.
export function createBriefReviewer(opts: { mock: boolean; env?: Env }): Agent {
	const self = { id: "" }
	const pending: { revision: number | null } = { revision: null }
	const reviewed = new Set<number>()
	const agent = createAgent({
		name: "reviewer",
		capabilities: [],
		instruction: INSTRUCTION,
		tools: [submitReviewTool(self, pending)],
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "design.ready")),
				processor: {
					apply: ({ event }) => {
						if (!isEvent(event, "design.ready") || reviewed.has(event.payload.revision)) return
						reviewed.add(event.payload.revision)
						const { revision, round } = event.payload
						void reviewMessage(opts.env, revision, round).then((message) => {
							pending.revision = revision
							const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))
							safeRunLoop(self.id, message, { model: modelFor("reviewer", opts.mock), context, tools: agent.getTools() })
						})
					},
				},
			},
		],
	})
	self.id = agent.getId()
	state().roles.set(self.id, "reviewer")
	joinRuntime(agent)
	return agent
}
