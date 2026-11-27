import { providerProblem } from "../inference/providers.ts"
import { continueSeed } from "../runner/continue.ts"
import { armPictures, armSimPictures, assemblyPictures, casePictures, cncSimPictures, drivePictures } from "../package/assembly-pictures.ts"
import { approveRunPlan, makeRunPlan, paidStartRefusal, planText, readRunPlan } from "../system/plan-gate.ts"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import { basename, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describeDomain, installDomain, type Domain } from "../setup/domains.ts"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { dockerUsable } from "../tools/toolchain.ts"
import { appendRequest } from "../runner/requests.ts"
import type { RunProcessArgs } from "../runner/spawn-run.ts"
import { runSummary } from "../runner/summary.ts"
import { detectEnvironment } from "../tools/env.ts"

export interface BringupMcpDeps {
	// Starts one run (by default a `tsx src/main.ts` child, see startRunProcess). Exit 0 settled, 2 unsettled.
	launch: (args: RunProcessArgs) => { done: Promise<{ code: number; stderr: string }>; kill?: () => void }
	outRoot: string
	// Where the bundled briefs, systems and examples are (the package root); the environment that says whether a model
	// provider is configured (process.env by default).
	root?: string
	env?: Record<string, string | undefined>
	// Which hardware tools this machine has (src/tools/env.ts detectEnvironment by default), for hardware: "auto".
	detect?: () => Promise<{ tsci: string | null; python: string | null; pio: string | null; kicad?: "docker" | "local" | null; toolchain?: { image: string; tools: string[] } }>
	// Whether Docker works here without sudo (src/tools/toolchain.ts dockerUsable by default): then a machine without the
	// tools builds in the toolchain image instead of stubbing.
	docker?: () => Promise<boolean>
	// Installs one setup domain into the tools home (src/setup/domains.ts installDomain by default), for installTools.
	install?: (domain: Domain) => Promise<{ installed: boolean; note: string }>
}

// hardware "auto": the real builds where the toolchain is (tscircuit, Python with build123d, PlatformIO, KiCad); where it
// isn't but Docker is, the builds run in Bringup's toolchain image (--docker-toolchain; src/tools/toolchain.ts); with
// neither, the builds stubbed (--no-hardware) so the design still settles: an `npx bringup-mcp` with nothing else installed ran a
// mock to "UNSETTLED: missing tools" in 10 s (22 Nov 2026). The result says which it was.
const HARDWARE = z.enum(["auto", "build", "stub"]).optional().describe('"build": board, case, chassis and firmware built for real (needs the toolchain: npm run setup); "stub": the contract and its checks only, builds stubbed; "auto" (default): build when the toolchain is there, else build in Docker (Bringup\'s toolchain image, built on the first run), else stub')

const ROOT = fileURLToPath(new URL("../..", import.meta.url))

// The setup domains (src/setup/domains.ts) a machine lacks, from its detected tools.
function domainsLacking(env: { tsci: string | null; python: string | null; pio: string | null }): Domain[] {
	return [...(!env.tsci ? ["board" as const] : []), ...(!env.python ? ["case" as const] : []), ...(!env.pio ? ["firmware" as const] : [])]
}

// A real-model run spends money or a subscription's quota, so it needs an explicit yes and a provider; the default is
// the scripted mock (free, no key). The user's rule: no paid run without an explicit flag.
export function paidRunRefusal(mock: boolean | undefined, realModels: boolean | undefined, env: Record<string, string | undefined>): string | null {
	if (mock !== false) return null
	if (realModels !== true) return "mock: false starts real models, which cost money or quota: pass realModels: true as well to confirm (the default, mock, is scripted and free)"
	const problem = providerProblem(env)
	if (problem) return `${problem} (in the MCP server's environment)`
	return null
}

// The reference a click on the case or chassis names (src/dashboard/scene3d.js refPrefix: the same text, so the
// agents read one form).
const refText = (r: { ref: string; label: string; madeBy: string }) => `[${r.ref}: ${r.label}; made by ${r.madeBy}] `

type RunState =
	| { status: "running" }
	// Installing the missing tools first (start_design installTools); the run starts after.
	| { status: "installing"; installing: string[] }
	| { status: "settled" | "unsettled" }
	| { status: "failed"; error: string }

interface TraceLine {
	seq: number
	at: string
	type: string
	producerId: string
	payload: any
}

const RUN_ID = /^[\w-]+$/
const SYSTEM_NAME = /^[\w-]+$/
const BOARD = z.string().optional().describe("For a system run: the board (default main when it has one; design_status lists them).")

// A system run keeps each board's run under boards/<name>; a single design is the run folder itself.
function boardDir(dir: string, runId: string, board: string | undefined): { dir: string; system: boolean } | { error: string } {
	const system = existsSync(join(dir, "boards"))
	if (board !== undefined && !SYSTEM_NAME.test(board)) return { error: `invalid board ${JSON.stringify(board)}` }
	if (board !== undefined && !system) return { error: `run ${runId} is a single design: leave board out` }
	if (!system) return { dir, system }
	// A system's boards carry their own names (logger, beacon): "main" is only the default when there is one.
	const names = readdirSync(join(dir, "boards")).filter((n) => SYSTEM_NAME.test(n)).sort()
	const pick = board ?? (names.includes("main") ? "main" : names.length === 1 ? names[0] : undefined)
	if (pick === undefined) return { error: `run ${runId} is a system: pass board, one of ${names.join(", ") || "(none yet)"}` }
	const sub = join(dir, "boards", pick)
	if (!existsSync(sub)) return { error: `run ${runId} has no board ${pick} yet${names.length ? ` (it has ${names.join(", ")})` : ""}` }
	return { dir: sub, system }
}
export const SERVER_VERSION = (() => {
	try { return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string } catch { return "0.0.0" }
})()
const MAX_EVENTS = 500
const ERROR_TAIL_LINES = 20

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] })
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] })

function newRunId(): string {
	const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
	return `${t}-${randomBytes(3).toString("hex")}`
}

async function readTrace(dir: string): Promise<TraceLine[]> {
	const text = await readFile(join(dir, "trace.jsonl"), "utf8").catch(() => "")
	const lines: TraceLine[] = []
	for (const raw of text.split("\n")) {
		if (raw.trim() === "") continue
		try {
			lines.push(JSON.parse(raw))
		} catch {
			// A half-written last line while the run is still appending.
		}
	}
	return lines
}

function summarise(trace: TraceLine[]) {
	const counts = { events: trace.length, proposed: 0, approved: 0, rejected: 0, artifactsBuilt: 0, artifactsFailed: 0, checks: 0, halted: 0 }
	let revision = 0
	let violations: unknown[] = []
	let settled: { revision: number; settled: boolean } | null = null
	// change.resolved is the outcome; change.decided is one vote (there can be two). Older traces have only votes.
	const resolved = trace.some((e) => e.type === "change.resolved")
	for (const e of trace) {
		// A bench event carries the board's booted rev (a replay's recorded one), not the contract's.
		if (typeof e.payload?.revision === "number" && !e.type.startsWith("bench.")) revision = Math.max(revision, e.payload.revision)
		switch (e.type) {
			case "change.proposed": counts.proposed++; break
			case "change.resolved": e.payload.approved ? counts.approved++ : counts.rejected++; break
			case "change.decided": if (!resolved) e.payload.approved ? counts.approved++ : counts.rejected++; break
			case "artifact.ready": counts.artifactsBuilt++; break
			case "artifact.failed": counts.artifactsFailed++; break
			case "consistency.checked": counts.checks++; violations = e.payload.violations; break
			case "design.settled": settled = e.payload; break
			case "agent.halted": counts.halted++; break
		}
	}
	return { counts, revision, violations, settled: settled as { revision: number; settled: boolean } | null }
}

function exitState(code: number, stderr: string): RunState {
	if (code === 0) return { status: "settled" }
	if (code === 2) return { status: "unsettled" }
	const tail = stderr.trimEnd().split("\n").slice(-ERROR_TAIL_LINES).join("\n")
	return { status: "failed", error: tail || `run exited with code ${code}` }
}

// MCP face of Bringup: a coding agent starts runs and reads their contract, report and trace. Runs go on
// in the background; every read comes from out/<runId>/ and never leaves outRoot.
// What the agent reads first (a newcomer's first run through Claude Code, 27 Nov 2026, got no overview: 15 tools and
// nothing saying which comes first, that runs are free by default, or that installs need the user's yes).
export const SERVER_INSTRUCTIONS = `Bringup turns a short product brief into a hardware design whose parts agree: parts list, schematic and routed PCB, printed case or robot parts, firmware, simulation, and a report of every check.

Usual flow: start_design with the user's brief (it returns a runId at once), poll design_status every few seconds until it is no longer running, then run_summary for what was built and the files to open. To change a design, start it with stay: true and use request_change ("make it 50 mm wide"); a design whose run has ended is changed through continue_design. list_starters has example briefs.

Cost: runs are scripted mocks by default, free and offline. Real models cost money: they need mock: false, realModels: true and a plan from plan_design that the user approved through approve_plan. Never start one without the user asking for it.

Tools: without the hardware tools installed, the design is complete but the board, case and firmware are stubbed; start_design and run_summary say which command installs each. Installing downloads hundreds of MB, so ask the user first, then run \`npx bringup-mcp setup <board|case|firmware|sim>\` or start again with installTools: true.`

export function createBringupMcpServer(deps: BringupMcpDeps): McpServer {
	const runs = new Map<string, RunState>()
	const kills = new Map<string, () => void>()
	const stays = new Set<string>()
	const root = deps.root ?? ROOT
	const server = new McpServer({ name: "bringup", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS })
	async function hardwareFlags(hardware: "auto" | "build" | "stub" | undefined): Promise<{ flags: string[]; said: string }> {
		if (hardware === "stub") return { flags: ["--no-hardware"], said: "stubbed (asked)" }
		const env = await (deps.detect ?? (() => detectEnvironment(root)))()
		const missing = [!env.tsci && "tscircuit", !env.python && "Python with build123d", !env.pio && "PlatformIO", env.kicad === null && "KiCad"].filter(Boolean)
		const inDocker = env.toolchain ? ` (${env.toolchain.tools.join(", ")} in Docker, ${env.toolchain.image})` : ""
		if (missing.length === 0) return { flags: [], said: `built${hardware === "build" ? " (asked)" : ""}${inDocker}` }
		// The toolchain image (docker/toolchain/Dockerfile) stands in for what is missing: the run builds it first.
		if (await (deps.docker ?? dockerUsable)())
			return { flags: ["--docker-toolchain"], said: `built in Docker${hardware === "build" ? " (asked)" : ""}: this machine lacks ${missing.join(", ")}, so they run in Bringup's toolchain image; the first run builds it and pulls KiCad's (several minutes and a few GB, once)` }
		// Without Docker: build what is installed, stub the rest, and say per domain what one command would add and what it
		// downloads, so the calling agent can ask its user (an agent never says yes to ~1 GB on a person's behalf).
		const lacking = domainsLacking(env)
		const offer = lacking.length ? ` To build ${lacking.length > 1 ? "them" : "it"} for real, ask your user first, then either run \`npx bringup-mcp setup ${lacking.join(" ")}\` or start the design again with installTools: true: ${lacking.map(describeDomain).join("; ")}.` : ""
		if (hardware === "build") return { flags: ["--stub-missing"], said: `built where the tools are (asked), stubbed where this machine lacks ${missing.join(", ")} (no Docker).${offer}` }
		return { flags: ["--stub-missing"], said: `${lacking.length === 3 ? "stubbed" : `partly stubbed (${lacking.join(", ")})`}: this machine lacks ${missing.join(", ")} and Docker.${offer}` }
	}
	// Not awaited: a run goes on in its own process while the client polls.
	function track(runId: string, run: ReturnType<BringupMcpDeps["launch"]>) {
		if (run.kill) kills.set(runId, run.kill)
		run.done.then(
			({ code, stderr }) => { runs.set(runId, exitState(code, stderr)); kills.delete(runId) },
			(error) => { runs.set(runId, { status: "failed", error: String(error) }); kills.delete(runId) },
		)
	}

	// The run directory for runId, or an error message. Accepts runs this server started and existing
	// directories under outRoot; the realpath check stops a symlinked run dir from leading outside.
	async function runDir(runId: string): Promise<{ dir: string } | { error: string }> {
		if (!RUN_ID.test(runId)) return { error: `invalid runId ${JSON.stringify(runId)}: letters, digits, _ and - only` }
		const dir = join(deps.outRoot, runId)
		if (runs.has(runId)) return { dir }
		const s = await stat(dir).catch(() => null)
		if (!s?.isDirectory()) return { error: `unknown runId ${runId}` }
		const [root, real] = await Promise.all([realpath(deps.outRoot), realpath(dir)])
		if (!real.startsWith(root + sep)) return { error: `unknown runId ${runId}` }
		return { dir }
	}

	server.registerTool(
		"plan_design",
		{
			description: "Before a paid (real-model) run: the plan your user approves. Give the brief (or a system: a bundled name or a spec). Returns what will be designed, what the brief leaves open and the agents would assume, and the estimated time and cost, plus a planId. Free: plain code, no model call. Show the plan text to your user and ask; call approve_plan only once they say yes. Clearer briefs mean fewer paid runs.",
			inputSchema: {
				brief: z.string().min(1).optional().describe("The brief start_design would get"),
				system: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("Or the system start_system would get"),
			},
		},
		async ({ brief, system }) => {
			if (!brief === !system) return fail("give either brief or system")
			const plan = brief
				? makeRunPlan({ brief }, deps.outRoot, deps.env ?? process.env)
				: (() => {
						const subject = systemSubject(root, system!)
						const spec = JSON.parse(subject) as { name?: string; boards: { name: string; brief?: string }[] }
						// A bundled system names its boards' brief files; the questions read their text.
						const briefs = spec.boards.map((b) => (b.brief && /\.md$/.test(b.brief) && existsSync(join(root, b.brief)) ? readFileSync(join(root, b.brief), "utf8") : (b.brief ?? "")))
						return makeRunPlan({ system: spec, briefs }, deps.outRoot, deps.env ?? process.env, new Date(), subject)
					})()
			return ok({ planId: plan.id, plan: planText(plan), questions: plan.questions, estimate: plan.estimate, approved: false })
		},
	)

	server.registerTool(
		"approve_plan",
		{
			description: "Approve a plan from plan_design, ONLY after your user has seen it and said yes. A paid start_design or start_system needs an approved planId. Never approve on your user's behalf.",
			inputSchema: { planId: z.string() },
		},
		async ({ planId }) => {
			const p = approveRunPlan(planId)
			return p ? ok({ planId, approvedAt: p.approvedAt }) : fail(`no plan ${planId}`)
		},
	)

	server.registerTool(
		"start_design",
		{
			description: "Start a Bringup run: concurrent agents turn the brief into parts, a routed PCB, an enclosure and firmware. Returns at once with the runId; poll design_status.",
			inputSchema: {
				brief: z.string().min(1).describe("Short product brief, e.g. 'BLE temperature logger, USB-C, 50x30 mm'"),
				mock: z.boolean().optional().describe("Scripted agents: free, no API key, a complete design in minutes. Default true."),
				realModels: z.boolean().optional().describe("Required with mock: false. Real models cost money or quota; the server refuses without it."),
				planId: z.string().optional().describe("Required with mock: false: the id of a plan made by plan_design for this exact brief and approved by your user through approve_plan."),
				stay: z.boolean().optional().describe("Keep the run up after it settles so request_change can reach it; end it with stop_design. Default false."),
				hardware: HARDWARE,
				installTools: z.boolean().optional().describe("Install the missing tools first (into ~/.bringup), only after the user said yes: start_design without it says per domain what would be downloaded and how big (about 1 GB each for board and case). Never pass it on the user's behalf without asking. The run starts when the install is done; design_status says installing meanwhile."),
			},
		},
		async ({ brief, mock, realModels, planId, stay, hardware, installTools }) => {
			const refused = paidRunRefusal(mock, realModels, deps.env ?? process.env) ?? (mock === false ? paidStartRefusal(planId, brief) : null)
			if (refused) return fail(refused)
			const runId = newRunId()
			const outDir = join(deps.outRoot, runId)
			mkdirSync(outDir, { recursive: true })
			const briefPath = join(outDir, "brief.md")
			writeFileSync(briefPath, brief.endsWith("\n") ? brief : brief + "\n")
			runs.set(runId, { status: "running" })
			if (stay) stays.add(runId)
			// The missing tools, installed first on the user's yes (installTools): the run starts after, so the call returns now.
			const lacking = installTools && hardware !== "stub" ? domainsLacking(await (deps.detect ?? (() => detectEnvironment(root)))()) : []
			if (lacking.length) {
				runs.set(runId, { status: "installing", installing: lacking })
				void (async () => {
					const notes: string[] = []
					for (const d of lacking) {
						try {
							notes.push(`${d}: ${(await (deps.install ?? ((x: Domain) => installDomain(x, { log: () => {} })))(d)).note}`)
						} catch (e) {
							notes.push(`${d}: not installed (${(e as Error).message})`)
						}
					}
					writeFileSync(join(outDir, "setup.log"), notes.join("\n") + "\n")
					const hw = await hardwareFlags(hardware)
					const extraArgs = [...(stay ? ["--stay"] : []), ...hw.flags, ...(mock === false && planId ? ["--plan", planId] : [])]
					runs.set(runId, { status: "running" })
					track(runId, deps.launch({ briefPath, mock: mock ?? true, outDir, ...(extraArgs.length ? { extraArgs } : {}) }))
				})()
				return ok({ runId, outDir, mock: mock ?? true, stay: Boolean(stay), hardware: `installing ${lacking.map(describeDomain).join("; ")}; the run starts when that's done (design_status says installing until then)` })
			}
			// Not awaited: the run goes on in its own process while the client polls.
			const hw = await hardwareFlags(hardware)
			const extraArgs = [...(stay ? ["--stay"] : []), ...hw.flags, ...(mock === false && planId ? ["--plan", planId] : [])]
			track(runId, deps.launch({ briefPath, mock: mock ?? true, outDir, ...(extraArgs.length ? { extraArgs } : {}) }))
			return ok({ runId, outDir, mock: mock ?? true, stay: Boolean(stay), hardware: hw.said })
		},
	)

	server.registerTool(
		"continue_design",
		{
			description: "Continue a design whose run has ended: a new run starts from its contract (the latest, or `revision` to branch from an earlier one), settles as it was, then takes request_change. Returns the new runId; the ended run is kept as it is.",
			inputSchema: {
				runId: z.string().describe("The ended run to continue"),
				revision: z.number().int().positive().optional().describe("Branch from this revision (its contracts/rev-N.json) instead of the latest"),
				mock: z.boolean().optional().describe("Scripted agents: free, no API key. Default true."),
				realModels: z.boolean().optional().describe("Required with mock: false. Real models cost money or quota; the server refuses without it."),
				planId: z.string().optional().describe("Required with mock: false: a plan made by plan_design for this design's brief and approved by your user through approve_plan."),
				stay: z.boolean().optional().describe("Keep the run up for request_change after it settles; end it with stop_design. Default true."),
				hardware: HARDWARE,
			},
		},
		async ({ runId: fromId, revision, mock, realModels, planId, stay, hardware }) => {
			const from = await runDir(fromId)
			if ("error" in from) return fail(from.error)
			const seed = continueSeed(from.dir, revision)
			if ("error" in seed) return fail(seed.error)
			const brief = readFileSync(join(from.dir, "brief.md"), "utf8")
			const refused = paidRunRefusal(mock, realModels, deps.env ?? process.env) ?? (mock === false ? paidStartRefusal(planId, brief) : null)
			if (refused) return fail(refused)
			const runId = newRunId()
			const outDir = join(deps.outRoot, runId)
			mkdirSync(outDir, { recursive: true })
			const keep = stay ?? true
			runs.set(runId, { status: "running" })
			if (keep) stays.add(runId)
			const hw = await hardwareFlags(hardware)
			const extraArgs = ["--from", from.dir, ...(revision ? ["--rev", String(revision)] : []), ...(keep ? ["--stay"] : []), ...hw.flags, ...(mock === false && planId ? ["--plan", planId] : [])]
			track(runId, deps.launch({ briefPath: "continue", mock: mock ?? true, outDir, extraArgs }))
			return ok({ runId, outDir, continuedFrom: fromId, revision: seed.contract.revision, mock: mock ?? true, stay: keep, hardware: hw.said })
		},
	)

	server.registerTool(
		"design_status",
		{
			description: "Status of a run (running, settled, unsettled, failed, or unknown for runs from an earlier server), its revision, the latest violations and event counts.",
			inputSchema: { runId: z.string(), board: BOARD },
		},
		async ({ runId, board }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const system = existsSync(join(r.dir, "boards"))
			const b = system && board === undefined ? { dir: r.dir, system } : boardDir(r.dir, runId, board)
			if ("error" in b) return fail(b.error)
			const state = runs.get(runId)
			const failed = state?.status === "failed" ? { error: state.error } : {}
			const one = async (dir: string) => {
				const { counts, revision, violations, settled } = summarise(await readTrace(dir))
				// For runs this server did not start, the trace's design.settled is all there is to go on.
				return { status: settled ? (settled.settled ? "settled" : "unsettled") : "unknown", revision, violations, counts, settledAt: settled?.revision }
			}
			// A run kept up for changes (stay) is still running after it settles: report the settle of its latest revision,
			// and that it stays up (25 Nov 2026: an npx probe saw "running" for 8 minutes after the logger settled).
			const live = (s: { status: string; revision: number; settledAt?: number }) => stays.has(runId) && state?.status === "running" && s.settledAt !== undefined && s.settledAt >= s.revision ? { status: s.status, staying: true } : { status: state?.status ?? s.status }
			// A whole system: one block per board it has so far.
			if (b.system && board === undefined) {
				const names = readdirSync(join(r.dir, "boards")).filter((n) => SYSTEM_NAME.test(n)).sort()
				const boards = await Promise.all(names.map(async (n) => ({ board: n, ...(await one(join(r.dir, "boards", n))) })))
				const traced = boards.length && boards.every((x) => x.status === "settled") ? "settled" : boards.some((x) => x.status === "unsettled") ? "unsettled" : "unknown"
				const allSettled = boards.length > 0 && boards.every((x) => x.settledAt !== undefined && x.settledAt >= x.revision)
				const sys = stays.has(runId) && state?.status === "running" && allSettled ? { status: traced, staying: true } : { status: state?.status ?? traced }
				return ok({ runId, ...sys, boards: boards.map(({ settledAt: _s, ...x }) => x), ...failed })
			}
			const { settledAt: _s, ...s } = await one(b.dir)
			return ok({ runId, ...(board ? { board } : {}), ...s, ...live({ ...s, settledAt: _s }), ...failed })
		},
	)

	server.registerTool(
		"read_contract",
		{ description: "The run's current design contract (contract.json): outline, connectors, rails, parts, pins, with versions.", inputSchema: { runId: z.string(), board: BOARD } },
		async ({ runId, board }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const b = boardDir(r.dir, runId, board)
			if ("error" in b) return fail(b.error)
			const text = await readFile(join(b.dir, "contract.json"), "utf8").catch(() => null)
			if (text === null) return fail(`run ${runId} has no contract.json yet`)
			return ok(text)
		},
	)

	server.registerTool(
		"get_report",
		{ description: "The run's consistency report (report.md), written when the run ends.", inputSchema: { runId: z.string(), board: BOARD } },
		async ({ runId, board }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const b = boardDir(r.dir, runId, board)
			if ("error" in b) return fail(b.error)
			const text = await readFile(join(b.dir, "report.md"), "utf8").catch(() => null)
			if (text === null) return fail(`run ${runId} has no report.md yet`)
			return ok(text)
		},
	)

	server.registerTool(
		"request_change",
		{
			description: "Send a mid-run change request to a running design, as the engineer would (e.g. 'make the board 60 mm wide'). The architect picks it up and changes the fields it owns; poll design_status or list_events to watch the effect.",
			inputSchema: {
				runId: z.string(),
				text: z.string().min(1),
				board: z.string().optional().describe("For a system run: the board the change is for (default main)."),
				ref: z.string().optional().describe("A part reference from list_part_refs (e.g. 'chassis#sensor-bracket', 'case#feature:gland'): the change is about that printed feature."),
			},
		},
		async ({ runId, text, board, ref }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const state = runs.get(runId)
			if (state && state.status !== "running") return fail(`run ${runId} is ${state.status}; change requests only reach a running design (start it with stay: true)`)
			const b = boardDir(r.dir, runId, board)
			if ("error" in b) return fail(b.error)
			const { dir, system } = b
			let prefix = ""
			if (ref) {
				const found = [...partRefs(dir).case, ...partRefs(dir).chassis].find((x) => x.ref === ref)
				if (!found) return fail(`no part ${ref} in run ${runId}${system ? ` board ${board ?? "main"}` : ""}: list_part_refs gives the ones there are`)
				prefix = refText(found)
			}
			return ok(appendRequest(dir, prefix + text))
		},
	)

	server.registerTool(
		"list_events",
		{
			description: `Trace events of a run with seq greater than sinceSeq (all when omitted), at most ${MAX_EVENTS} per call.`,
			inputSchema: { runId: z.string(), sinceSeq: z.number().int().optional(), board: BOARD },
		},
		async ({ runId, sinceSeq, board }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const b = boardDir(r.dir, runId, board)
			if ("error" in b) return fail(b.error)
			const after = (await readTrace(b.dir)).filter((e) => sinceSeq === undefined || e.seq > sinceSeq)
			const events = after.slice(0, MAX_EVENTS)
			return ok({ events, more: after.length > events.length })
		},
	)

	// The newest built case's and chassis' refs.json (py/enclosure.py case_refs, py/chassis.py chassis_refs).
	function partRefs(dir: string): { case: PartRef[]; chassis: PartRef[] } {
		const newest = (kind: string): PartRef[] => {
			const base = join(dir, kind)
			if (!existsSync(base)) return []
			const revs = readdirSync(base).map((n) => /^rev-(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a)
			for (const rev of revs) {
				const p = join(base, `rev-${rev}`, "refs.json")
				if (existsSync(p)) try { return JSON.parse(readFileSync(p, "utf8")) } catch { return [] }
			}
			return []
		}
		return { case: newest("enclosure"), chassis: newest("chassis") }
	}

	server.registerTool(
		"list_starters",
		{
			description: "What Bringup ships to start from: example devices and robots (examples/), multi-board systems (briefs/systems/, for start_system) and plain briefs (briefs/, text to pass to start_design).",
			inputSchema: {},
		},
		async () => {
			const dir = (d: string) => (existsSync(join(root, d)) ? readdirSync(join(root, d)) : [])
			const examples = dir("examples").filter((n) => existsSync(join(root, "examples", n, "example.json"))).map((n) => {
				const e = JSON.parse(readFileSync(join(root, "examples", n, "example.json"), "utf8"))
				return { name: n, title: e.title ?? n, sentence: e.sentence ?? "", boards: (e.boards ?? []).map((b: { name: string }) => b.name) }
			})
			const systems = dir("briefs/systems").filter((n) => n.endsWith(".json")).map((n) => {
				const s = JSON.parse(readFileSync(join(root, "briefs/systems", n), "utf8"))
				return { name: n.replace(/\.json$/, ""), description: s.name ?? "", boards: (s.boards ?? []).map((b: { name: string }) => b.name) }
			})
			const briefs = dir("briefs").filter((n) => n.endsWith(".md")).map((n) => ({ name: n.replace(/\.md$/, ""), firstLine: readFileSync(join(root, "briefs", n), "utf8").split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "" }))
			return ok({ examples, systems, briefs })
		},
	)

	server.registerTool(
		"start_system",
		{
			description: "Start a multi-board system (a robot's boards on one chassis, a sensor board on a cable, a Pi with its HAT): each board is designed by its own run and the links between them are checked. Give a bundled system's name from list_starters (e.g. 'rover-pi') or a system spec object. Returns the runId at once; poll design_status or run_summary.",
			inputSchema: {
				system: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("A bundled system name (list_starters) or a system spec: {name, boards: [{name, brief}], links: [...]}"),
				mock: z.boolean().optional().describe("Scripted agents: free, no API key. Default true."),
				realModels: z.boolean().optional().describe("Required with mock: false. Real models cost money or quota."),
				planId: z.string().optional().describe("Required with mock: false: a plan_design plan for this system, approved by your user through approve_plan."),
				stay: z.boolean().optional().describe("Keep the system up after it settles, for request_change. Default false."),
				hardware: HARDWARE,
			},
		},
		async ({ system, mock, realModels, planId, stay, hardware }) => {
			const refused = paidRunRefusal(mock, realModels, deps.env ?? process.env) ?? (mock === false ? paidStartRefusal(planId, systemSubject(root, system)) : null)
			if (refused) return fail(refused)
			let specPath: string
			const runId = newRunId()
			const outDir = join(deps.outRoot, runId)
			if (typeof system === "string") {
				if (!SYSTEM_NAME.test(system) || !existsSync(join(root, "briefs/systems", `${system}.json`))) return fail(`no bundled system ${JSON.stringify(system)}: list_starters gives the names`)
				specPath = join(root, "briefs/systems", `${system}.json`)
			} else {
				mkdirSync(outDir, { recursive: true })
				specPath = join(outDir, "system-spec.json")
				writeFileSync(specPath, JSON.stringify(system, null, 1))
			}
			mkdirSync(outDir, { recursive: true })
			const hw = await hardwareFlags(hardware)
			runs.set(runId, { status: "running" })
			if (stay) stays.add(runId)
			track(runId, deps.launch({ briefPath: "system", mock: false, outDir, extraArgs: [specPath, ...(mock === false ? [] : ["--mock"]), ...(stay ? ["--stay"] : []), ...hw.flags, ...(mock === false && planId ? ["--plan", planId] : [])] }))
			return ok({ runId, outDir, mock: mock ?? true, stay: Boolean(stay), hardware: hw.said })
		},
	)

	server.registerTool(
		"run_summary",
		{
			description: "One screen about a run: its status, the open violations, and each built artifact's own verdict (board DRC, the case's print check, the chassis' interference, the simulated drive, the ROS test), with the files worth opening. A system run gives one block per board.",
			inputSchema: { runId: z.string() },
		},
		async ({ runId }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const s = runSummary(r.dir, runId)
			const state = runs.get(runId)
			return ok({ ...s, ...(state ? { process: state.status } : {}) })
		},
	)

	server.registerTool(
		"list_part_refs",
		{
			description: "The printed features of a run's newest case and chassis that a change can name (each connector opening, hole, tab, standoff, motor mount, rail, bracket...), with where each is and the line of code that makes it. Pass one as request_change's ref.",
			inputSchema: { runId: z.string(), board: BOARD },
		},
		async ({ runId, board }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const b = boardDir(r.dir, runId, board)
			if ("error" in b) return fail(b.error)
			return ok(partRefs(b.dir))
		},
	)

	server.registerTool(
		"stop_design",
		{ description: "End a run this server started (one started with stay: true keeps running until stopped).", inputSchema: { runId: z.string() } },
		async ({ runId }) => {
			const kill = kills.get(runId)
			if (!kill) return fail(runs.has(runId) ? `run ${runId} has already ended (${runs.get(runId)!.status})` : `run ${runId} wasn't started by this server`)
			kill()
			return ok({ runId, stopping: true })
		},
	)

	server.registerTool(
		"get_pictures",
		{
			description: "Pictures of a run's design, to show the user: the newest board's 3D picture (returned as an image), its PCB and schematic (SVG paths), and with stills: true 3D stills of the board in its case, or of a robot or arm (needs the case tools; 10-25 s). A robot's simulation (its firmware in QEMU driving the MuJoCo model: a rover's drive, an arm's pick-and-place; a CNC's grblHAL in Renode) comes back as its verdict; with drive: true also as pictures of it moving and a GIF (a CNC: its toolpath; 2-90 s). Every file is also listed by path.",
			inputSchema: {
				runId: z.string(),
				board: BOARD,
				stills: z.boolean().optional().describe("Render 3D stills into <run>/pictures (py/stills.py, the case tools): the board in its case, or a robot or arm step by step. Default false."),
				drive: z.boolean().optional().describe("Render the robot's simulation into <run>/pictures (the case tools): a rover's drive (drive/: the course from above with its path, three frames following the robot, drive.gif) an arm's pick-and-place (armsim/: pick, carry, drop, the landings from above, arm.gif) or a CNC's toolpath (cncsim/: from above on a mm grid with the bed, from the front left, cnc.gif). Default false."),
			},
		},
		async ({ runId, board, stills, drive }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const b = boardDir(r.dir, runId, board)
			if ("error" in b) return fail(b.error)
			const newest = (dir: string, has: string): string | null => {
				if (!existsSync(dir)) return null
				const revs = readdirSync(dir).map((n) => /^rev-(\d+)$/.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).sort((x, y) => y - x)
				const rev = revs.find((n) => existsSync(join(dir, `rev-${n}`, has)))
				return rev === undefined ? null : join(dir, `rev-${rev}`)
			}
			const files: { what: string; path: string }[] = []
			// Which still shows the design best: a robot or arm finished (its last step); a case exploded, since the closed
			// lid hides the board.
			let showExploded = false
			const notes: string[] = []
			const boardRev = newest(join(b.dir, "board"), "board.png") ?? newest(join(b.dir, "board"), "board-pcb.svg")
			if (boardRev) {
				for (const [f, what] of [["board.png", "board, 3D"], ["board-pcb.svg", "PCB layout"], ["board-schematic.svg", "schematic"]] as const)
					if (existsSync(join(boardRev, f))) files.push({ what, path: join(boardRev, f) })
			} else notes.push("no board pictures: the board wasn't built (`npx bringup-mcp setup board`, after your user says yes)")
			const caseRev = newest(join(b.dir, "enclosure"), "case.stl")
			if (caseRev) files.push({ what: "case (STL, open in a 3D viewer or slicer)", path: join(caseRev, "case.stl") })
			if (stills) {
				const env = await (deps.detect ?? (() => detectEnvironment(root)))()
				const chassis = newest(join(b.dir, "chassis"), "chassis.stl")
				const arm = newest(join(b.dir, "arm"), join("arm", "posed", "groups.json"))
				const out = join(b.dir, "pictures")
				if (!env.python) notes.push("no 3D stills: they need the case tools (`npx bringup-mcp setup case`, after your user says yes)")
				else if (!chassis && !arm && !caseRev) notes.push("no 3D stills: stills are drawn for a case, a robot's chassis or an arm, and this design has none of them built")
				else {
					const p = chassis ? await assemblyPictures(env.python, root, chassis, out) : arm ? await armPictures(env.python, root, join(arm, "arm", "posed"), out) : await casePictures(env.python, root, caseRev!, out)
					showExploded = !chassis && !arm
					if (p.note) notes.push(p.note)
					for (const f of p.files) files.push({ what: `3D still: ${basename(f, ".png").replace(/[-_]/g, " ")}`, path: join(out, f) })
				}
			}
			// The robot's simulated drive (src/tools/drive.ts): its verdict always, its pictures on request.
			const driveRev = newest(join(b.dir, "drive"), "drive.json")
			let driveVerdict: Record<string, unknown> | undefined
			if (driveRev) {
				try {
					const d = JSON.parse(readFileSync(join(driveRev, "drive.json"), "utf8")) as { result: string; reason?: string; segments?: { name: string; pass: boolean; detail: string }[]; topSpeedMps?: number; peakA?: number; closestWallMm?: number }
					driveVerdict = { result: d.result, reason: d.reason, segments: (d.segments ?? []).map((x) => `${x.pass ? "pass" : "FAIL"} ${x.name}: ${x.detail}`), ...(d.topSpeedMps !== undefined ? { topSpeedMps: d.topSpeedMps } : {}), ...(d.peakA !== undefined ? { peakA: d.peakA } : {}), ...(d.closestWallMm !== undefined ? { closestWallMm: d.closestWallMm } : {}) }
				} catch {
					notes.push(`the drive's result (${join(driveRev, "drive.json")}) couldn't be read`)
				}
			}
			// An arm's pick-and-place (py/mech/arm_drive.py): its verdict always too.
			const armsimRev = newest(join(b.dir, "armsim"), "arm.json")
			let armVerdict: Record<string, unknown> | undefined
			if (armsimRev) {
				try {
					const a = JSON.parse(readFileSync(join(armsimRev, "arm.json"), "utf8")) as { result: string; reason?: string; landed?: number; attempts?: number; worstMm?: number; cycleS?: number[] }
					armVerdict = { result: a.result, reason: a.reason, ...(a.landed !== undefined ? { landed: a.landed, attempts: a.attempts, worstMm: a.worstMm } : {}), ...(a.cycleS?.length ? { cycleS: a.cycleS } : {}) }
				} catch {
					notes.push(`the pick-and-place's result (${join(armsimRev, "arm.json")}) couldn't be read`)
				}
			}
			// A CNC's simulated machine (grblHAL in Renode, src/tools/cnc-sim.ts): its checks always, and the toolpath it ran.
			const cncRev = newest(join(b.dir, "cncsim"), "result.json")
			let cncVerdict: Record<string, unknown> | undefined
			if (cncRev) {
				try {
					const c = JSON.parse(readFileSync(join(cncRev, "result.json"), "utf8")) as { result: string; checks?: { name: string; ok: boolean; detail: string }[] }
					const t = existsSync(join(cncRev, "toolpath.json")) ? (JSON.parse(readFileSync(join(cncRev, "toolpath.json"), "utf8")) as { travelMm?: Record<string, number>; pulseCheck?: { axis: string; ok: boolean; detail: string }[]; finished?: boolean }) : null
					cncVerdict = { result: c.result, checks: (c.checks ?? []).map((x) => `${x.ok ? "pass" : "FAIL"} ${x.name}: ${x.detail}`), ...(t ? { toolpath: { finished: t.finished, travelMm: t.travelMm, pulses: (t.pulseCheck ?? []).map((x) => `${x.ok ? "ok" : "MISMATCH"} ${x.axis.toUpperCase()}: ${x.detail}`) } } : {}) }
				} catch {
					notes.push(`the simulated machine's result (${join(cncRev, "result.json")}) couldn't be read`)
				}
			}
			const drivePngs: { what: string; path: string }[] = []
			const armPosed = newest(join(b.dir, "arm"), join("arm", "posed", "groups.json"))
			const armTraj = newest(join(b.dir, "armsim"), "trajectory.json")
			const cncTool = newest(join(b.dir, "cncsim"), "toolpath.json")
			if (drive && (cncRev || cncTool)) {
				const env = await (deps.detect ?? (() => detectEnvironment(root)))()
				if (!cncTool) notes.push("no toolpath pictures: the simulated machine recorded no toolpath (it runs grblHAL on an STM32F4 in Renode; a run from before toolpaths were recorded has none)")
				else if (!env.python) notes.push("no toolpath pictures: they need the case tools (`npx bringup-mcp setup case`, after your user says yes)")
				else {
					const out = join(b.dir, "pictures")
					const p = await cncSimPictures(env.python, root, cncTool, out)
					if (p.note) notes.push(p.note)
					for (const f of p.files) {
						const entry = { what: f.endsWith(".gif") ? "the toolpath, animated (GIF)" : f.endsWith("-3d.png") ? "toolpath: from the front left" : "toolpath: from above, on the bed", path: join(out, f) }
						files.push(entry)
						if (/cnc-toolpath(-3d)?\.png$/.test(f)) drivePngs.push(entry)
					}
				}
			} else if (drive && (armPosed || armsimRev) && !newest(join(b.dir, "chassis"), "chassis.stl")) {
				const env = await (deps.detect ?? (() => detectEnvironment(root)))()
				if (!armPosed || !armTraj) notes.push(!armPosed ? "no pick-and-place pictures: the arm's parts weren't built" : "no pick-and-place pictures: the arm's simulation didn't run (it needs `npx bringup-mcp setup firmware sim`, after your user says yes)")
				else if (!env.python) notes.push("no pick-and-place pictures: they need the case tools (`npx bringup-mcp setup case`, after your user says yes)")
				else {
					const out = join(b.dir, "pictures")
					const p = await armSimPictures(env.python, root, join(armPosed, "arm", "posed"), armTraj, out)
					if (p.note) notes.push(p.note)
					for (const f of p.files) {
						const entry = { what: f.endsWith(".gif") ? "the pick-and-place, animated (GIF)" : `pick-and-place: ${basename(f, ".png").replace(/^arm-(\d-)?/, "").replace(/[-_]/g, " ")}`, path: join(out, f) }
						files.push(entry)
						if (/arm-(1-pick|3-drop)\.png$/.test(f)) drivePngs.push(entry)
					}
				}
			} else if (drive) {
				const env = await (deps.detect ?? (() => detectEnvironment(root)))()
				const chassis = newest(join(b.dir, "chassis"), "chassis.stl")
				const trajRev = newest(join(b.dir, "drive"), "trajectory.json")
				if (!chassis || !trajRev) notes.push(!chassis ? "no drive pictures: this design has no robot chassis built" : "no drive pictures: the robot's drive didn't run (it needs `npx bringup-mcp setup firmware sim`, after your user says yes)")
				else if (!env.python) notes.push("no drive pictures: they need the case tools (`npx bringup-mcp setup case`, after your user says yes)")
				else {
					const out = join(b.dir, "pictures")
					const p = await drivePictures(env.python, root, chassis, trajRev, out)
					if (p.note) notes.push(p.note)
					for (const f of p.files) {
						const entry = { what: f.endsWith(".gif") ? "the drive, animated (GIF)" : `drive: ${basename(f, ".png").replace(/^drive-(\d-)?/, "").replace(/[-_]/g, " ")}`, path: join(out, f) }
						files.push(entry)
						if (/drive-(track|2-farthest)\.png$/.test(f)) drivePngs.push(entry)
					}
				}
			}
			// The PNGs themselves, so a client that shows images can put them in front of the user: the board and the
			// finished robot (the last assembly step), each at most 2 MB; with drive, the course from above and the robot
			// at its farthest.
			const pngs = files.filter((f) => f.path.endsWith(".png") && !drivePngs.includes(f))
			const steps = pngs.filter((f) => /[\\/]step-\d+[^\\/]*\.png$/.test(f.path))
			const exploded = pngs.find((f) => /[\\/]exploded\.png$/.test(f.path))
			const finished = showExploded && exploded ? exploded : steps.length ? steps.reduce((x, y) => (Number(/step-(\d+)/.exec(y.path)![1]) > Number(/step-(\d+)/.exec(x.path)![1]) ? y : x)) : pngs.length > 1 ? pngs[pngs.length - 1] : undefined
			const shown = [pngs[0], finished, ...drivePngs].filter((f): f is { what: string; path: string } => Boolean(f) && statSync(f!.path).size <= 2_000_000)
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify({ runId, files, ...(driveVerdict ? { drive: driveVerdict } : {}), ...(armVerdict ? { pickAndPlace: armVerdict } : {}), ...(cncVerdict ? { machine: cncVerdict } : {}), ...(notes.length ? { notes } : {}) }, null, 2) },
					...shown.map((f) => ({ type: "image" as const, data: readFileSync(f.path).toString("base64"), mimeType: "image/png" })),
				],
			}
		},
	)

	server.registerTool(
		"export_package",
		{
			description: "Build a run's manufacturing package (fabrication files, BOM, firmware, printed parts, assembly notes) into <run>/package (a system run: one board at a time). Refused for an unfinished design unless force is true. Needs the full toolchain (npm run setup).",
			inputSchema: { runId: z.string(), force: z.boolean().optional(), board: BOARD },
		},
		async ({ runId, force, board }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const b = boardDir(r.dir, runId, board)
			if ("error" in b) return fail(b.error)
			const contract = join(b.dir, "contract.json")
			if (!existsSync(contract)) return fail(`run ${runId}${b.system ? ` board ${board ?? "main"}` : ""} has no contract.json yet`)
			const out = join(b.dir, "package")
			const run = deps.launch({ briefPath: "package", mock: false, outDir: b.dir, extraArgs: [contract, out, ...(force ? ["--force"] : [])] })
			const { code, stderr } = await run.done
			if (code !== 0) return fail(code === 3 ? `not packaged, the design isn't finished:\n${stderr.trim().replace(/^bringup: not packaged: the design isn't finished:\n/, "").replace("pass --force", "pass force: true")}` : `packaging failed: ${stderr.trim().split("\n").slice(-ERROR_TAIL_LINES).join("\n")}`)
			return ok({ runId, package: out, files: existsSync(out) ? readdirSync(out) : [] })
		},
	)

	return server
}

interface PartRef { ref: string; kind: string; label: string; atMm?: number[]; madeBy: string }

// The text a system's plan approval is for: the bundled system's spec file, or the given spec, as JSON.
export function systemSubject(root: string, system: string | Record<string, unknown>): string {
	if (typeof system === "string") {
		const f = join(root, "briefs/systems", `${system}.json`)
		return existsSync(f) ? JSON.stringify(JSON.parse(readFileSync(f, "utf8"))) : JSON.stringify({ name: system, boards: [] })
	}
	return JSON.stringify(system)
}
