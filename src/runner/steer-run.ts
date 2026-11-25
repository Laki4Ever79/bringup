import { mkdtemp, rm } from "node:fs/promises"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { OWNERS, type FieldName } from "../contract/types.ts"
import { readBrief } from "../brief-file.ts"
import { makeEvent, type Payloads } from "../events.ts"
import { emit, state } from "../runtime.ts"
import { TEMP_PREFIX } from "../tmp.ts"
import { watchJsonl } from "./requests.ts"
import { editsToApply, editSummary, STEER_COMMANDS_FILE, writeSteer, type EditInput, type SteerCommand, type SteerEdit } from "./steer.ts"
import { verifyEdit, type VerifyTools } from "./steer-verify.ts"

const ACTIONS = new Set(["pause", "resume", "agent-pause", "agent-resume", "agent-stop", "agent-redo", "edit", "verify", "discard", "use-mine", "apply-fix"])

// Pure: one steer.jsonl line to a command, or null for a line that isn't one.
export function parseCommand(raw: unknown): SteerCommand | null {
	const c = raw as Record<string, unknown>
	if (!c || typeof c !== "object" || typeof c.action !== "string" || !ACTIONS.has(c.action)) return null
	const at = typeof c.at === "string" ? c.at : new Date().toISOString()
	if (c.action === "pause" || c.action === "resume") return { at, action: c.action }
	if (c.action.startsWith("agent-")) return typeof c.agent === "string" ? ({ at, action: c.action, agent: c.agent } as SteerCommand) : null
	if (c.action === "edit") {
		const e = c.edit as Record<string, unknown> | undefined
		if (!e || typeof e !== "object") return null
		const edit: EditInput | null =
			e.kind === "field" && typeof e.field === "string" && OWNERS[e.field as FieldName] !== undefined ? { kind: "field", field: e.field as FieldName, value: e.value } : e.kind === "file" && typeof e.path === "string" && typeof e.content === "string" ? { kind: "file", path: e.path, content: e.content } : null
		return edit ? { at, action: "edit", ...(typeof c.id === "string" ? { id: c.id } : {}), edit } : null
	}
	return typeof c.id === "string" ? ({ at, action: c.action, id: c.id } as SteerCommand) : null
}

// The run's side of steering: carries out the hub's commands (<out>/steer.jsonl), verifies edits one at a time, applies
// the decided ones at resume as the engineer's changes, and keeps <out>/steer.json current for the hub and the page.
export function createSteerDesk(opts: { outDir: string; tools: VerifyTools | null }): Human & { close(): void } {
	const self = { id: "" }
	const edits: SteerEdit[] = []
	let live = true
	let n = 0
	let applied = 0
	const steer = state().steer
	const write = () => writeSteer(opts.outDir, { live, ...steer.snapshot(), edits })
	steer.onChange(write)

	const readFile = (path: string) => {
		const p = join(opts.outDir, path)
		return existsSync(p) ? readFileSync(p, "utf8") : null
	}
	const beforeOf = (e: EditInput) => (e.kind === "field" ? (state().contract.get(e.field) ?? null) : readFile(e.path))

	// Verifications run one after another: each may compile firmware or route a board.
	let chain: Promise<void> = Promise.resolve()
	const verify = (e: SteerEdit) => {
		e.status = "verifying"
		delete e.result
		write()
		chain = chain.then(async () => {
			const s = state()
			const scratch = await mkdtemp(join(tmpdir(), `${TEMP_PREFIX}steer-`))
			try {
				e.result = await verifyEdit(e.edit, {
					snapshot: s.contract.snapshot(),
					artifacts: s.artifacts,
					brief: readBrief(opts.outDir),
					outDir: opts.outDir,
					validate: (field, value) => s.contract.validate({ field, value: value as never, by: OWNERS[field] }),
					tools: opts.tools,
					scratch,
					readFile,
					writeFile: (path, content) => {
						mkdirSync(dirname(path), { recursive: true })
						writeFileSync(path, content)
					},
				})
				e.status = e.result.ok ? "ok" : "broken"
			} catch (error) {
				e.status = "broken"
				e.error = error instanceof Error ? error.message : String(error)
			} finally {
				await rm(scratch, { recursive: true, force: true }).catch(() => {})
			}
			emit(makeEvent("edit.verified", self.id, { id: e.id, ok: e.status === "ok", broke: (e.result?.broke ?? []).map((b) => b.message).slice(0, 5), fix: e.result?.fix?.summary ?? null }), self.id)
			write()
		})
	}

	// One decided edit, as the engineer's change: a field written with its owner's authority (the engineer outranks the
	// agents), announced as change.requested edit-N, so the builders, the checks and the agents it affects wake as for a
	// typed change. A file is written in place: file-sync and the drift list record it.
	const apply = (e: SteerEdit): Payloads["run.resumed"]["applied"][number] | null => {
		const s = state()
		const requestId = `edit-${++applied}`
		const asField = e.result?.asField ?? (e.edit.kind === "field" ? { field: e.edit.field, value: e.edit.value } : null)
		const summary = `${editSummary(e.edit)}${e.decision === "mine" ? " (kept against the checks: the engineer's call)" : e.decision === "fix" ? " (with the suggested fix)" : ""}`
		emit(makeEvent("change.requested", self.id, { id: requestId, text: summary }), self.id)
		if (asField) {
			const before = s.contract.get(asField.field) ?? null
			const owner = OWNERS[asField.field]
			const r = s.contract.propose({ field: asField.field, value: asField.value as never, by: "engineer", approvedBy: owner, baseVersion: s.contract.version(asField.field) })
			if (r.status === "applied") {
				emit(makeEvent("contract.changed", self.id, { field: asField.field, version: r.version, revision: r.revision, by: "engineer", reason: summary, before, after: asField.value, cause: { kind: "request", id: requestId, text: summary } }), self.id)
			} else if (r.status !== "unchanged") {
				e.error = `not applied: ${JSON.stringify(r)}`
				return null
			}
		} else if (e.edit.kind === "file") {
			const p = join(opts.outDir, e.edit.path)
			mkdirSync(dirname(p), { recursive: true })
			writeFileSync(p, e.edit.content)
		}
		e.status = "applied"
		e.requestId = requestId
		return { id: e.id, requestId, summary, ...(e.decision ? { decision: e.decision } : {}) }
	}

	const handle = (c: SteerCommand) => {
		if (!live) return
		switch (c.action) {
			case "pause":
				if (steer.paused) return
				steer.setRunPaused(true)
				emit(makeEvent("run.paused", self.id, { at: c.at }), self.id)
				return
			case "resume": {
				if (!steer.paused) return
				// Every edit still being verified finishes first; nothing half-checked goes in.
				void chain.then(() => {
					const done = editsToApply(edits).map(apply).filter((x) => x !== null)
					const dropped: string[] = []
					for (const e of edits) {
						if (e.status === "draft" || e.status === "broken") {
							e.error ??= e.status === "draft" ? "not verified when the run resumed" : "broken and not decided when the run resumed"
							e.status = "discarded"
							dropped.push(e.id)
						}
					}
					steer.setRunPaused(false)
					emit(makeEvent("run.resumed", self.id, { at: new Date().toISOString(), applied: done, dropped }), self.id)
					write()
				})
				return
			}
			case "agent-pause":
				steer.pauseAgent(c.agent)
				emit(makeEvent("agent.steered", self.id, { agent: c.agent, action: "pause" }), self.id)
				return
			case "agent-resume":
				steer.resumeAgent(c.agent)
				emit(makeEvent("agent.steered", self.id, { agent: c.agent, action: "resume" }), self.id)
				return
			case "agent-stop":
				steer.stopAgent(c.agent)
				emit(makeEvent("agent.steered", self.id, { agent: c.agent, action: "stop" }), self.id)
				return
			case "agent-redo":
				if (steer.redoAgent(c.agent)) emit(makeEvent("agent.steered", self.id, { agent: c.agent, action: "redo" }), self.id)
				return
			case "edit": {
				if (!steer.paused) return
				const old = c.id ? edits.find((e) => e.id === c.id && e.status !== "applied" && e.status !== "discarded") : undefined
				if (old) {
					old.edit = c.edit
					old.status = "draft"
					delete old.result
					delete old.decision
					delete old.error
				} else edits.push({ id: `e${++n}`, at: c.at, edit: c.edit, before: beforeOf(c.edit), status: "draft" })
				write()
				return
			}
			default: {
				const e = edits.find((x) => x.id === c.id)
				if (!e || e.status === "applied" || e.status === "discarded" || e.status === "verifying") return
				if (c.action === "verify") return verify(e)
				if (c.action === "discard") {
					e.status = "discarded"
					return write()
				}
				if (c.action === "use-mine") {
					if (e.status !== "broken") return
					e.decision = "mine"
					return write()
				}
				// apply-fix: the fix becomes the edit, verified again in full (builds included) before it can go in.
				if (!e.result?.fix) return
				e.edit = e.result.fix.edit
				e.decision = "fix"
				return verify(e)
			}
		}
	}

	const watcher = watchJsonl(opts.outDir, STEER_COMMANDS_FILE, parseCommand, handle)
	const participant = createHuman({ name: "steer", capabilities: [], handlers: [] })
	self.id = participant.getId()
	write()
	return Object.assign(participant, {
		close: () => {
			watcher.close()
			live = false
			// A run that ends paused lets everything go, so nothing waits on a pause nobody can lift.
			steer.setRunPaused(false)
			write()
		},
	})
}
