import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { FieldName } from "../contract/types.ts"

// Steering a run while it builds (spec 2026-11-25, goal 4; the user: "we can allow them to pause and make changes but we
// should compile them and verify the changes aren't breaking, if they are suggest fixes unless they insist otherwise",
// and "Pause, stop or redo" one agent or step without restarting the whole design).
//
// Everything is cooperative: nothing is killed. A held agent waits at its next step boundary (Mozaik interception sees
// every loop transition; a builder waits before its next build), the consistency participant doesn't settle while
// anything is held, and held changes don't time out. The hub queues commands in <out>/steer.jsonl; the run carries them
// out and keeps <out>/steer.json current (runner/steer-run.ts).

export const STEER_FILE = "steer.json"
export const STEER_COMMANDS_FILE = "steer.jsonl"

export type AgentSteerState = "running" | "paused" | "stopped"
export type AgentKind = "agent" | "builder"

export interface AgentSteer {
	// The participant's name: architect, parts, firmware-reviewer, board-builder…
	name: string
	kind: AgentKind
	state: AgentSteerState
	// What it was last doing (an agent's turn message, a builder's revision), shown beside Redo.
	lastStep?: { at: string; summary: string }
	// Whether Redo has a step to rerun.
	canRedo: boolean
}

export type EditInput = { kind: "field"; field: FieldName; value: unknown } | { kind: "file"; path: string; content: string }

export interface VerifyCheck {
	name: string
	ok: boolean
	detail: string
}

export interface VerifyBuild {
	kind: string
	ok: boolean
	// Not built, and why (a run without hardware tools, a design without that domain).
	skipped?: string
	detail: string
	ms?: number
}

export interface Breakage {
	kind: string
	message: string
	fields?: string[]
}

export interface SuggestedFix {
	// One line: what the fix changes in the user's edit.
	summary: string
	// Where it came from: the checks' own search, the compiler's error, or a plain revert.
	source: "checks" | "compiler" | "revert"
	// The edit with the fix applied, ready to verify and apply.
	edit: EditInput
	// What the fix was checked with (the checks it clears; builds run when it is applied).
	checkedWith: string
}

export interface VerifyResult {
	ok: boolean
	at: string
	// The contract revision the edit was checked against.
	revision: number
	checks: VerifyCheck[]
	builds: VerifyBuild[]
	broke: Breakage[]
	fix: SuggestedFix | null
	// A file edit that is a contract change (pins.h's pin numbers): resume applies it as this field's value.
	asField?: { field: FieldName; value: unknown }
	// Facts about the edit that are not breakage (a pins.h line the contract can't take, the files a rebuild overwrites).
	notes: string[]
}

export type EditStatus = "draft" | "verifying" | "ok" | "broken" | "discarded" | "applied"

export interface SteerEdit {
	id: string
	at: string
	edit: EditInput
	// What the edit replaced, so the page can show a diff (the field's value or the file's text when it was made).
	before?: unknown
	status: EditStatus
	result?: VerifyResult
	// The user's choice on a broken edit: their own value ("Use mine anyway") or the suggested fix (applied in place).
	decision?: "mine" | "fix"
	// Once applied at resume: the change request it went out as.
	requestId?: string
	error?: string
}

export interface SteerFile {
	// The run is up and acts on commands; false after run.ended.
	live: boolean
	paused: boolean
	pausedAt?: string
	agents: AgentSteer[]
	edits: SteerEdit[]
}

export type SteerCommand =
	| { at: string; action: "pause" | "resume" }
	| { at: string; action: "agent-pause" | "agent-resume" | "agent-stop" | "agent-redo"; agent: string }
	| { at: string; action: "edit"; id?: string; edit: EditInput }
	| { at: string; action: "verify" | "discard" | "use-mine" | "apply-fix"; id: string }

// A command as the hub receives it, before it is stamped with its time.
export type SteerRequest = SteerCommand extends infer C ? (C extends SteerCommand ? Omit<C, "at"> : never) : never

export function readSteer(outDir: string): SteerFile {
	const path = join(outDir, STEER_FILE)
	if (!existsSync(path)) return { live: false, paused: false, agents: [], edits: [] }
	return JSON.parse(readFileSync(path, "utf8")) as SteerFile
}

export function writeSteer(outDir: string, s: SteerFile): void {
	const path = join(outDir, STEER_FILE)
	// Written whole and renamed, so a reader never sees half of it.
	writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2))
	renameSync(`${path}.tmp`, path)
}

// Why the hub must refuse a command now, or null. The run checks again when it carries it out.
export function commandRefused(s: SteerFile, command: SteerRequest): string | null {
	const c = command as { action: SteerCommand["action"]; agent?: string; id?: string }
	if (!s.live) return "the run is not running, so nothing can be steered"
	switch (c.action) {
		case "pause":
			return s.paused ? "the run is already paused" : null
		case "resume":
			if (!s.paused) return "the run is not paused"
			return s.edits.some((e) => e.status === "verifying") ? "an edit is still being verified" : null
		case "agent-pause":
		case "agent-resume":
		case "agent-stop":
		case "agent-redo": {
			const a = s.agents.find((x) => x.name === c.agent)
			if (!a) return `no agent named ${c.agent} in this run`
			if (c.action === "agent-pause" && a.state !== "running") return `${a.name} is already ${a.state}`
			if (c.action === "agent-resume" && a.state === "running") return `${a.name} is running`
			if (c.action === "agent-stop" && a.state === "stopped") return `${a.name} is already stopped`
			if (c.action === "agent-redo" && !a.canRedo) return `${a.name} has no step to redo yet`
			return null
		}
		case "edit":
			return s.paused ? null : "pause the run first: edits are made while it is paused"
		default: {
			const e = s.edits.find((x) => x.id === c.id)
			if (!e) return "unknown edit"
			if (e.status === "applied" || e.status === "discarded") return `that edit is already ${e.status}`
			if (e.status === "verifying") return "that edit is being verified"
			if (c.action === "use-mine" && e.status !== "broken") return "only a broken edit needs \"Use mine anyway\""
			if (c.action === "apply-fix" && !e.result?.fix) return "that edit has no suggested fix"
			return null
		}
	}
}

// The edits resume applies: verified ok, or broken and decided (the user's own value, or the fix already swapped in).
export function editsToApply(edits: SteerEdit[]): SteerEdit[] {
	return edits.filter((e) => e.status === "ok" || (e.status === "broken" && e.decision === "mine"))
}

// One line for an edit, as the change request it goes out as.
export function editSummary(e: EditInput): string {
	if (e.kind === "file") return `edited ${e.path}`
	return `set ${e.field} by hand`
}

interface AgentEntry {
	kind: AgentKind
	state: AgentSteerState
	// Bumped by Stop and Redo: a loop that started under an older epoch ends at its next step.
	epoch: number
	lastStep?: { at: string; summary: string }
	redo?: () => void
}

// The run's steering state, in memory (on BringupState). Waiters wake on every change and look again.
export class Steering {
	private runPaused = false
	private pausedSince: string | undefined
	private readonly agents = new Map<string, AgentEntry>()
	private waiters: (() => void)[] = []
	private listeners: (() => void)[] = []

	get paused(): boolean {
		return this.runPaused
	}

	get pausedAt(): string | undefined {
		return this.pausedSince
	}

	// Called on every change (steer-run.ts writes steer.json).
	onChange(listener: () => void): void {
		this.listeners.push(listener)
	}

	register(name: string, kind: AgentKind): void {
		if (!this.agents.has(name)) {
			this.agents.set(name, { kind, state: "running", epoch: 0 })
			this.changed()
		}
	}

	private entry(name: string): AgentEntry {
		let a = this.agents.get(name)
		if (!a) {
			a = { kind: "agent", state: "running", epoch: 0 }
			this.agents.set(name, a)
		}
		return a
	}

	// Whether `name` must wait now: the run is paused, or the agent is paused or stopped.
	held(name: string): boolean {
		const a = this.agents.get(name)
		return this.runPaused || (a !== undefined && a.state !== "running")
	}

	// Anything held anywhere: settling waits, approvals don't time out.
	anyHeld(): boolean {
		return this.runPaused || [...this.agents.values()].some((a) => a.state !== "running")
	}

	epochOf(name: string): number {
		return this.agents.get(name)?.epoch ?? 0
	}

	// Resolves once `name` may go on, or once `cancelled` says to stop waiting (the step was stopped while it waited).
	async gate(name: string, cancelled: () => boolean = () => false): Promise<void> {
		while (this.held(name) && !cancelled()) await new Promise<void>((r) => this.waiters.push(r))
	}

	setRunPaused(paused: boolean): void {
		if (this.runPaused === paused) return
		this.runPaused = paused
		this.pausedSince = paused ? new Date().toISOString() : undefined
		this.changed()
	}

	pauseAgent(name: string): void {
		const a = this.entry(name)
		if (a.state === "running") a.state = "paused"
		this.changed()
	}

	resumeAgent(name: string): void {
		this.entry(name).state = "running"
		this.changed()
	}

	// Ends the agent's step in flight (at its next step boundary) and holds it until Resume or Redo.
	stopAgent(name: string): void {
		const a = this.entry(name)
		a.epoch++
		a.state = "stopped"
		this.changed()
	}

	// Ends the step in flight and runs the agent's last step again. False when there is no step to rerun.
	redoAgent(name: string): boolean {
		const a = this.entry(name)
		if (!a.redo) return false
		a.epoch++
		a.state = "running"
		this.changed()
		a.redo()
		return true
	}

	// The agent's latest step and how to rerun it.
	noteStep(name: string, summary: string, redo: () => void): void {
		const a = this.entry(name)
		a.lastStep = { at: new Date().toISOString(), summary: summary.slice(0, 200) }
		a.redo = redo
		this.changed()
	}

	snapshot(): { paused: boolean; pausedAt?: string; agents: AgentSteer[] } {
		return {
			paused: this.runPaused,
			...(this.pausedSince ? { pausedAt: this.pausedSince } : {}),
			agents: [...this.agents.entries()].map(([name, a]) => ({ name, kind: a.kind, state: a.state, ...(a.lastStep ? { lastStep: a.lastStep } : {}), canRedo: a.redo !== undefined })),
		}
	}

	private changed(): void {
		for (const w of this.waiters.splice(0)) w()
		for (const l of this.listeners) l()
	}
}
