import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createAgent, DeveloperMessageItem, ModelContext, type Agent, type Tool } from "@mozaik-ai/core"
import { generatedNets, supportParts, usbPadSignal, usbRef } from "../codegen/circuit.ts"
import { checkConsistency, type BoardArtifact } from "../contract/consistency.ts"
import { bleAdvertiseMs } from "../codegen/firmware.ts"
import { dutyCycleCheckLines, estimatePower, powerBudgetLines } from "../contract/power.ts"
import { FIELDS, type ContractSnapshot, type FieldName } from "../contract/types.ts"
import { isEvent, makeEvent, type ArtifactKind, type ReviewFinding } from "../events.ts"
import { BUILD_INPUTS } from "./builders.ts"
import { modelFor } from "../inference/models.ts"
import { emit, join as joinRuntime, safeRunLoop, state } from "../runtime.ts"
import { when } from "../change-control.ts"
import type { Env } from "../tools/env.ts"
import { simulatePower } from "../tools/spice.ts"
import { isStub } from "../tools/stubs.ts"
import { designFacts } from "./design-facts.ts"
export { firmwareFacts, partFactsSection } from "./design-facts.ts"

export const MAX_REVIEW_ROUNDS = 1

export const REVIEW_INSTRUCTION = `You are a demanding hardware design reviewer. Judge the design ONLY against the product brief: does the design contract meet every requirement the brief states, and does any choice clearly undermine one?
The engineer's change requests, listed after the brief, amend it and override it where they differ (the newest last): a design that follows an engineer change is not a brief violation, even where the original brief said otherwise. Judge against the brief as amended.
You see the brief, the final design contract and the results of the deterministic checks (builds, consistency, pin grounding, power simulation). You do not see how the design was made, and you do not need to.
- Check each "must have" in the brief against the contract: present, and plausibly met.
- Battery life: start from the power budget computed in code (peak vs average current, regulator quiescent current, capacity, days). Rail loadMa is the PEAK, not a continuous draw. Judge whether the stated average and duty cycle are plausible for the parts and the brief, and show your numbers where you disagree. If no average is stated, say what is missing.
- Severity: blocker = a must-have cannot be met as designed; major = a requirement is at risk or a choice clearly works against it; minor = worth improving but the brief is met.
- No style nitpicks and no requests outside the brief's scope.
- Verdict "fail" only when a brief requirement is not met or a choice clearly undermines it; otherwise "pass" (minor findings are fine with a pass).
- Wiring: the board generator wires part of every board itself, and the "Board-generated wiring" section lists it: USB-C CC pull-downs, USB D+/D- to the MCU, the power path, pull-ups, decoupling. That wiring is part of the design even though the contract does not list it. Do not report as missing anything that section shows; judge whether it meets the brief. When the section says it was checked against a built board, it is on the board.
- Name the contract fields each finding concerns (${FIELDS.join(", ")}) so it reaches their owner.
Call submit_review exactly once.`

const lines = <T>(xs: T[], show: (x: T) => string, none: string) => (xs.length === 0 ? none : xs.map((x) => `- ${show(x)}`).join("\n"))

async function powerSummary(env: Env | undefined, s: ContractSnapshot, dir: string): Promise<string> {
	if (!env?.kicad) return "Power was not simulated (no KiCad/ngspice on this machine)."
	if (!s.values.rails?.length) return "Power was not simulated (the contract has no rails)."
	try {
		const report = await simulatePower(env.root, dir, s)
		return [
			`ngspice, behavioural LDO (${report.scenarios[0]?.ldo ?? "none"}), per supply scenario:`,
			...report.scenarios.map(
				(x) => `- ${x.name} (${x.vinV} V) rail ${x.rail}: vout ${x.voutV.toFixed(3)} V, dropout headroom ${x.headroomMv} mV, regulator dissipation ${x.dissipationMw} mW, ${x.ok ? "in regulation" : "OUT OF REGULATION"}`,
			),
		].join("\n")
	} catch (error) {
		return `Power simulation failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
	}
}

// What the board generator adds on top of the contract, so the reviewer judges the board that gets built and not only
// the contract: the support passives with their jobs and the generated power and USB nets, checked against the latest
// real board build when there is one.
export function wiringSection(s: ContractSnapshot, board: BoardArtifact | undefined): string[] {
	const usb = usbRef(s)
	const show = (end: string) => {
		const [ref, pin] = end.split(".")
		const signal = ref === usb ? usbPadSignal(pin) : undefined
		return signal ? `${end} (${signal})` : end
	}
	const nets = generatedNets(s)
	const out = [
		"## Board-generated wiring (added by the board generator, not in the contract)",
		"The board generator wires this on every build. It is part of the design even though the contract does not list it.",
		"Support passives (each uses a contract part with the same LCSC number, else the generator adds one):",
		lines(supportParts(s), (p) => `${p.ref} ${p.spec.value} (${p.spec.lcsc}): ${p.job} → ${"net" in p.b ? p.b.net : `${p.b.ref}.${p.b.pin}`} [${p.added ? "added by the board generator" : "contract part"}]`, "- none"),
		"Generated power and USB nets (REF.pin; USB-C pads named):",
		lines([...nets], ([net, ends]) => `${net}: ${ends.map(show).join(", ")}`, "- none"),
	]
	if (!board) return [...out, "No board has been built yet, so this comes from the generator's rules, not from a build."]
	if (isStub(board)) return [...out, "The board is stubbed (--no-hardware), so this comes from the generator's rules, not from a build."]
	const missing = [...nets].flatMap(([net, ends]) => {
		const gone = ends.filter((e) => !(board.nets[net] ?? []).includes(e))
		return gone.length ? [`${net} is missing ${gone.join(", ")} on the board built for revision ${board.revision}`] : []
	})
	return [...out, missing.length === 0 ? `All of it checked against the board built for revision ${board.revision}: every generated net above is on it.` : lines(missing, (m) => m, "")]
}


// One artifact's status for the reviewer. An artifact built at an older revision is still current when none of its
// inputs changed since (the enclosure only depends on outline and connectors); say so, or the reviewer reads "built
// for revision 3" as stale (real run 9).
export function artifactLine(
	k: ArtifactKind,
	a: { revision: number; ok?: boolean; stub?: boolean } | undefined,
	failure: string | undefined,
	builtFrom: Partial<Record<FieldName, number>> | undefined,
	versions: Partial<Record<FieldName, number>>,
	revision: number,
): string {
	if (failure) return `${k}: build FAILED: ${failure.split("\n")[0]}`
	if (!a) return `${k}: not built`
	const fw = k === "firmware" ? (a.ok ? ", compiles" : ", does NOT compile") : ""
	const stub = isStub(a) ? " (stubbed: derived from the contract, not a real build)" : ""
	if (a.revision === revision || !builtFrom) return `${k}: built for revision ${a.revision}${fw}${stub}`
	const changed = BUILD_INPUTS[k].filter((f) => builtFrom[f] !== undefined && builtFrom[f] !== versions[f])
	if (changed.length > 0) return `${k}: built for revision ${a.revision}, OUT OF DATE: ${changed.join(", ")} changed since${fw}${stub}`
	return `${k}: current: its inputs (${BUILD_INPUTS[k].filter((f) => builtFrom[f] !== undefined).join(", ")}) unchanged since revision ${a.revision}${fw}${stub}`
}

// The reviewer's whole view of the run: the brief, the contract and the check results. Never an agent's turn.
// The engineer's change requests since the brief (typed, file edits, adopted drift: all go through requests.jsonl, line
// N being req-N), for the reviewer to read as amendments. Without them it judged a requested change as a brief
// violation and the agents undid it (af's real-model add-sensor run).
function amendmentLines(outDir: string): string[] {
	const path = join(outDir, "requests.jsonl")
	if (!existsSync(path)) return []
	const requests = readFileSync(path, "utf8").split("\n").flatMap((l) => {
		try {
			return l.trim() ? [JSON.parse(l) as { text: string; source?: { kind: string; path: string } }] : []
		} catch {
			return []
		}
	})
	if (requests.length === 0) return []
	return [
		"## Engineer changes since the brief (these override it)",
		...requests.map((r, i) => `- req-${i + 1}: ${r.text}${r.source?.kind === "file" ? ` (a file edit: ${r.source.path})` : ""}`),
		"",
	]
}

export async function reviewMessage(env: Env | undefined, revision: number, round: number): Promise<string> {
	const s = state()
	const snapshot = s.contract.snapshot()
	const briefPath = join(s.outDir, "brief.md")
	const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8").trim() : "(brief missing)"
	const artifacts = (["board", "enclosure", "firmware"] as const).map((k) =>
		artifactLine(k, s.artifacts[k], s.artifactFailures[k], s.artifactInputs[k], snapshot.versions, revision),
	)
	const violations = checkConsistency(snapshot, s.artifacts, brief)
	const power = await powerSummary(env, snapshot, join(s.outDir, "power", `rev-${revision}`))
	return [
		`Brief review of revision ${revision} (review ${round} of at most ${s.review.maxRounds + 1}).`,
		"",
		"## Product brief",
		brief,
		"",
		...amendmentLines(s.outDir),
		"## Design contract",
		"```json",
		JSON.stringify(snapshot.values, null, 2),
		"```",
		"",
		...designFacts(snapshot, brief),
		"",
		"## Check results",
		"Artifacts:",
		...artifacts.map((a) => `- ${a}`),
		"Consistency violations (artifacts against the contract):",
		lines(violations, (v) => `${v.kind}: ${v.message}`, "- none"),
		"Grounding findings (part pins against the catalog and KiCad symbols):",
		lines(s.groundingFindings, (f) => `${f.kind} on ${f.partRef}: ${f.detail}`, "- none"),
		"Power path simulation:",
		power,
		"",
		...wiringSection(snapshot, s.artifacts.board),
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
		instruction: REVIEW_INSTRUCTION,
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
