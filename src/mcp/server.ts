import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import { join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { appendRequest } from "../runner/requests.ts"
import type { RunProcessArgs } from "../runner/spawn-run.ts"
import { runSummary } from "../runner/summary.ts"

export interface BringupMcpDeps {
	// Starts one run (by default a `tsx src/main.ts` child, see startRunProcess). Exit 0 settled, 2 unsettled.
	launch: (args: RunProcessArgs) => { done: Promise<{ code: number; stderr: string }>; kill?: () => void }
	outRoot: string
	// Where the bundled briefs, systems and examples are (the package root); the environment that says whether a model
	// provider is configured (process.env by default).
	root?: string
	env?: Record<string, string | undefined>
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url))

// A real-model run spends money or a subscription's quota, so it needs an explicit yes and a provider; the default is
// the scripted mock (free, no key). The user's rule: no paid run without an explicit flag.
export function paidRunRefusal(mock: boolean | undefined, realModels: boolean | undefined, env: Record<string, string | undefined>): string | null {
	if (mock !== false) return null
	if (realModels !== true) return "mock: false starts real models, which cost money or quota: pass realModels: true as well to confirm (the default, mock, is scripted and free)"
	if (!(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.BRINGUP_PROVIDER === "claude-code")) return "no model provider is configured: set OPENAI_API_KEY or ANTHROPIC_API_KEY in the server's environment, or BRINGUP_PROVIDER=claude-code to use this machine's Claude Code login"
	return null
}

// The reference a click on the case or chassis names (src/dashboard/scene3d.js refPrefix: the same text, so the
// agents read one form).
const refText = (r: { ref: string; label: string; madeBy: string }) => `[${r.ref}: ${r.label}; made by ${r.madeBy}] `

type RunState =
	| { status: "running" }
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
export function createBringupMcpServer(deps: BringupMcpDeps): McpServer {
	const runs = new Map<string, RunState>()
	const kills = new Map<string, () => void>()
	const root = deps.root ?? ROOT
	const server = new McpServer({ name: "bringup", version: SERVER_VERSION })
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
		"start_design",
		{
			description: "Start a Bringup run: concurrent agents turn the brief into parts, a routed PCB, an enclosure and firmware. Returns at once with the runId; poll design_status.",
			inputSchema: {
				brief: z.string().min(1).describe("Short product brief, e.g. 'BLE temperature logger, USB-C, 50x30 mm'"),
				mock: z.boolean().optional().describe("Scripted agents: free, no API key, a complete design in minutes. Default true."),
				realModels: z.boolean().optional().describe("Required with mock: false. Real models cost money or quota; the server refuses without it."),
				stay: z.boolean().optional().describe("Keep the run up after it settles so request_change can reach it; end it with stop_design. Default false."),
			},
		},
		async ({ brief, mock, realModels, stay }) => {
			const refused = paidRunRefusal(mock, realModels, deps.env ?? process.env)
			if (refused) return fail(refused)
			const runId = newRunId()
			const outDir = join(deps.outRoot, runId)
			mkdirSync(outDir, { recursive: true })
			const briefPath = join(outDir, "brief.md")
			writeFileSync(briefPath, brief.endsWith("\n") ? brief : brief + "\n")
			runs.set(runId, { status: "running" })
			// Not awaited: the run goes on in its own process while the client polls.
			track(runId, deps.launch({ briefPath, mock: mock ?? true, outDir, ...(stay ? { extraArgs: ["--stay"] } : {}) }))
			return ok({ runId, outDir, mock: mock ?? true, stay: Boolean(stay) })
		},
	)

	server.registerTool(
		"design_status",
		{
			description: "Status of a run (running, settled, unsettled, failed, or unknown for runs from an earlier server), its revision, the latest violations and event counts.",
			inputSchema: { runId: z.string() },
		},
		async ({ runId }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const { counts, revision, violations, settled } = summarise(await readTrace(r.dir))
			const state = runs.get(runId)
			// For runs this server did not start, the trace's design.settled is all there is to go on.
			const status = state?.status ?? (settled ? (settled.settled ? "settled" : "unsettled") : "unknown")
			return ok({
				runId,
				status,
				revision,
				violations,
				counts,
				...(state?.status === "failed" ? { error: state.error } : {}),
			})
		},
	)

	server.registerTool(
		"read_contract",
		{ description: "The run's current design contract (contract.json): outline, connectors, rails, parts, pins, with versions.", inputSchema: { runId: z.string() } },
		async ({ runId }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const text = await readFile(join(r.dir, "contract.json"), "utf8").catch(() => null)
			if (text === null) return fail(`run ${runId} has no contract.json yet`)
			return ok(text)
		},
	)

	server.registerTool(
		"get_report",
		{ description: "The run's consistency report (report.md), written when the run ends.", inputSchema: { runId: z.string() } },
		async ({ runId }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const text = await readFile(join(r.dir, "report.md"), "utf8").catch(() => null)
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
			const system = existsSync(join(r.dir, "boards"))
			if (board !== undefined && (!SYSTEM_NAME.test(board) || !system)) return fail(board && system ? `invalid board ${JSON.stringify(board)}` : `run ${runId} is a single design: leave board out`)
			const dir = system ? join(r.dir, "boards", board ?? "main") : r.dir
			if (!existsSync(dir)) return fail(`run ${runId} has no board ${board ?? "main"}`)
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
			inputSchema: { runId: z.string(), sinceSeq: z.number().int().optional() },
		},
		async ({ runId, sinceSeq }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const after = (await readTrace(r.dir)).filter((e) => sinceSeq === undefined || e.seq > sinceSeq)
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
				stay: z.boolean().optional().describe("Keep the system up after it settles, for request_change. Default false."),
			},
		},
		async ({ system, mock, realModels, stay }) => {
			const refused = paidRunRefusal(mock, realModels, deps.env ?? process.env)
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
			runs.set(runId, { status: "running" })
			track(runId, deps.launch({ briefPath: "system", mock: false, outDir, extraArgs: [specPath, ...(mock === false ? [] : ["--mock"]), ...(stay ? ["--stay"] : [])] }))
			return ok({ runId, outDir, mock: mock ?? true, stay: Boolean(stay) })
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
			inputSchema: { runId: z.string(), board: z.string().optional().describe("For a system run: the board (default main).") },
		},
		async ({ runId, board }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			if (board !== undefined && !SYSTEM_NAME.test(board)) return fail(`invalid board ${JSON.stringify(board)}`)
			const dir = existsSync(join(r.dir, "boards")) ? join(r.dir, "boards", board ?? "main") : r.dir
			return ok(partRefs(dir))
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
		"export_package",
		{
			description: "Build a run's manufacturing package (fabrication files, BOM, firmware, printed parts, assembly notes) into <run>/package. Refused for an unfinished design unless force is true. Needs the full toolchain (npm run setup).",
			inputSchema: { runId: z.string(), force: z.boolean().optional() },
		},
		async ({ runId, force }) => {
			const r = await runDir(runId)
			if ("error" in r) return fail(r.error)
			const contract = join(r.dir, "contract.json")
			if (!existsSync(contract)) return fail(`run ${runId} has no contract.json (a system run: package each board's run under boards/<name>)`)
			const out = join(r.dir, "package")
			const run = deps.launch({ briefPath: "package", mock: false, outDir: r.dir, extraArgs: [contract, out, ...(force ? ["--force"] : [])] })
			const { code, stderr } = await run.done
			if (code !== 0) return fail(code === 3 ? `not packaged, the design isn't finished: ${stderr.trim()}` : `packaging failed: ${stderr.trim().split("\n").slice(-ERROR_TAIL_LINES).join("\n")}`)
			return ok({ runId, package: out, files: existsSync(out) ? readdirSync(out) : [] })
		},
	)

	return server
}

interface PartRef { ref: string; kind: string; label: string; atMm?: number[]; madeBy: string }
