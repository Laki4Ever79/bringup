import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import { join, sep } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { RunProcessArgs } from "../runner/spawn-run.ts"

export interface BringupMcpDeps {
	// Starts one run (by default a `tsx src/main.ts` child, see startRunProcess). Exit 0 settled, 2 unsettled.
	launch: (args: RunProcessArgs) => { done: Promise<{ code: number; stderr: string }> }
	outRoot: string
}

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
	for (const e of trace) {
		if (typeof e.payload?.revision === "number") revision = Math.max(revision, e.payload.revision)
		switch (e.type) {
			case "change.proposed": counts.proposed++; break
			case "change.decided": e.payload.approved ? counts.approved++ : counts.rejected++; break
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
	const server = new McpServer({ name: "bringup", version: "0.1.0" })

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
				mock: z.boolean().optional().describe("Use scripted models (no API key, free). Default true."),
			},
		},
		async ({ brief, mock }) => {
			const runId = newRunId()
			const outDir = join(deps.outRoot, runId)
			mkdirSync(outDir, { recursive: true })
			const briefPath = join(outDir, "brief.md")
			writeFileSync(briefPath, brief.endsWith("\n") ? brief : brief + "\n")
			runs.set(runId, { status: "running" })
			// Not awaited: the run goes on in its own process while the client polls.
			deps.launch({ briefPath, mock: mock ?? true, outDir }).done.then(
				({ code, stderr }) => runs.set(runId, exitState(code, stderr)),
				(error) => runs.set(runId, { status: "failed", error: String(error) }),
			)
			return ok({ runId, outDir })
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

	return server
}
