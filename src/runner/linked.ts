import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import { dirname, join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { BUILD_INPUTS } from "../agents/builders.ts"
import type { ContractSnapshot, FieldName } from "../contract/types.ts"
import { FIELDS } from "../contract/types.ts"
import { isEvent, makeEvent, type ArtifactKind, type Payloads } from "../events.ts"
import { emit, state } from "../runtime.ts"
import { readBoardEdits } from "../tools/kicad-read.ts"
import { DRIFT_ACTIONS_FILE, writeDrift, type DriftAction, type DriftEntry } from "./drift.ts"
import { boardEdits, pinsEdits } from "./file-sync.ts"
import { commitPaths, ensureRepo, git, lastBringupCommit, showAt } from "./git.ts"
import { appendRequest, REQUESTS_FILE, watchJsonl } from "./requests.ts"
import { changeRipples, type TraceEvent } from "./ripple.ts"

// One working copy: a git repo the engineer owns. The contract is the only truth; the files are views of it. Each view
// has a generator (the builders' output for the settled revision) and, for some, a reader that maps edits back to
// contract fields. Bringup commits each settled revision; git's hashes are the fingerprints and the last Bringup commit
// is the base every edit is compared with (three ways: base, the file on disk, the contract now).

export const LINKED_FILE = "linked.json"

export interface View {
	// Path in the linked folder.
	path: string
	kind: ArtifactKind
	reader?: "pins" | "board"
}

export const VIEWS: View[] = [
	{ path: "firmware/pins.h", kind: "firmware", reader: "pins" },
	{ path: "board/board.kicad_pcb", kind: "board", reader: "board" },
	{ path: "enclosure/case.step", kind: "enclosure" },
	{ path: "enclosure/case.stl", kind: "enclosure" },
]

export type Classified =
	| { action: "untouched" }
	| { action: "resaved" }
	| { action: "drift"; drift: string[] }
	| { action: "request" | "rebase" | "conflict"; mapped: string[]; fields: FieldName[]; drift: string[]; movedSince: FieldName[] }

const same = (a: string | Buffer | null, b: string | Buffer | null) => a !== null && b !== null && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

// A KiCad file with what a plain re-save changes taken out: whitespace and the uuids it re-stamps.
function kicadCore(text: string): string {
	return text.replace(/\((uuid|tstamp)\s+"?[0-9a-fA-F-]+"?\)/g, "").replace(/"/g, "").replace(/\s+/g, " ").trim()
}

// Pure. yours: the file on disk; base: the same file at the last Bringup commit (generated from baseSnap); now: the
// contract HEAD. The reader says what changed; the field versions say whether the design moved under it.
export function classifyView(view: View, yours: string | Buffer, base: string | Buffer, baseSnap: ContractSnapshot, now: ContractSnapshot): Classified {
	if (same(yours, base)) return { action: "untouched" }
	let mapped: string[] = []
	let fields: FieldName[] = []
	let drift: string[] = []
	if (view.reader === "pins") {
		const e = pinsEdits(String(yours), String(base), baseSnap)
		if (e.mapped.length === 0 && e.drift.length === 0) return { action: "resaved" }
		mapped = e.mapped
		drift = e.drift
		if (mapped.length > 0) fields = ["pins"]
	} else if (view.reader === "board") {
		const e = boardEdits(readBoardEdits(String(yours)), baseSnap)
		mapped = e.mapped
		if (e.outline) fields.push("outline")
		if (e.connectors) fields.push("connectors")
		if (mapped.length === 0) return kicadCore(String(yours)) === kicadCore(String(base)) ? { action: "resaved" } : { action: "drift", drift: ["board edits outside the outline and connector positions (tracks, silkscreen or other footprints)"] }
	} else {
		return { action: "drift", drift: [`${view.path} edited; Bringup has no reader for it`] }
	}
	if (mapped.length === 0) return { action: "drift", drift }
	const movedSince = FIELDS.filter((f) => (baseSnap.versions[f] ?? 0) !== (now.versions[f] ?? 0))
	const inputsMoved = BUILD_INPUTS[view.kind].some((f) => movedSince.includes(f)) || fields.some((f) => movedSince.includes(f))
	if (!inputsMoved) return { action: "request", mapped, fields, drift, movedSince: [] }
	return { action: fields.some((f) => movedSince.includes(f)) ? "conflict" : "rebase", mapped, fields, drift, movedSince }
}

const DEBOUNCE_MS = 300
const DRIFT_MESSAGE = "this edit isn't in the design contract; the next rebuild will overwrite it"
const SKIPPED = "regeneration skipped: unadopted edits"

// The settled revision's views: linked path → the file the builders made.
function sources(outDir: string): Map<string, string> {
	const a = state().artifacts
	const out = new Map<string, string>()
	if (a.firmware?.ok) out.set("firmware/pins.h", join(outDir, "firmware", `rev-${a.firmware.revision}`, "include/pins.h"))
	if (a.board?.pcbPath) out.set("board/board.kicad_pcb", a.board.pcbPath)
	const fab = (a.board as { fabDir?: string } | undefined)?.fabDir
	if (fab && existsSync(fab)) for (const f of readdirSync(fab)) out.set(`fab/${f}`, join(fab, f))
	if (a.enclosure?.stepPath) out.set("enclosure/case.step", a.enclosure.stepPath)
	if (a.enclosure?.stlPath) out.set("enclosure/case.stl", a.enclosure.stlPath)
	return out
}

const viewOf = (rel: string): View | undefined => VIEWS.find((v) => v.path === rel) ?? (rel.startsWith("fab/") ? { path: rel, kind: "board" } : undefined)

// The commit message for a settled revision: the ripple that led to it, in words.
export function rippleMessage(events: TraceEvent[], revision: number): string {
	const ripples = changeRipples(events)
	const last = ripples.at(-1)
	const checked = events.findLast((e) => e.type === "consistency.checked")
	const review = events.findLast((e) => e.type === "review.completed")
	const lines = [last ? `Bringup rev ${revision}: ${last.text}` : `Bringup rev ${revision}: the design from the brief`, ""]
	if (last) {
		lines.push(`Fields: ${last.fieldsChanged.join(", ") || "none"}`)
		lines.push(`Woke: ${last.woke.join(", ") || "none"}${last.checked.length ? ` (checked, no change: ${last.checked.join(", ")})` : ""}`)
		lines.push(`Consistent again: ${last.durationMs === null ? "not reached" : `${(last.durationMs / 1000).toFixed(1)} s`}`)
	}
	lines.push(`Checks: ${checked ? `${checked.payload.violations.length} violation(s)` : "none run"}${review ? `; brief review ${review.payload.verdict}` : ""}`)
	// Trailers: the revision (the base for every later save), and the request with where it came from (the Files panel).
	const request = events.findLast((e) => e.type === "change.requested")
	const source = !request ? "brief" : request.payload.source?.kind === "file" ? "file" : "typed"
	lines.push("", `Bringup-Revision: ${revision}`, ...(request ? [`Bringup-Request: ${request.payload.id}`] : []), `Bringup-Source: ${source}`)
	return lines.join("\n")
}

export type LinkedSync = Human & { close(): void; attach(dir: string): void }

// The participant: attaches to a linked folder (at start with --link, or when `bringup link` writes linked.json),
// commits each settled revision there, and turns the engineer's saves into requests, rebases, conflicts or drift.
export function createLinkedSync(opts: { outDir: string; linkDir?: string; debounceMs?: number; onAttach?: () => void }): LinkedSync {
	const self = { id: "" }
	const seen: TraceEvent[] = []
	let dir: string | null = null
	let watcher: FSWatcher | null = null
	let poll: NodeJS.Timeout | null = null
	const timers = new Map<string, NodeJS.Timeout>()
	// What Bringup itself just wrote (so the doorbell ignores it), and the last content handled per path.
	const written = new Map<string, Buffer>()
	const handled = new Map<string, Buffer>()
	// Paths whose edit has gone into the contract since the base (adopted, rebased, re-saved): free to regenerate.
	const settledEdits = new Set<string>()
	const entries: DriftEntry[] = []
	const pending = new Map<string, { request: string; source: { path: string; revision: number; items: string[] } }>()
	let live = true
	let actions: { close(): void } | null = null
	const save = () => writeDrift(opts.outDir, { live, entries })
	const read = (rel: string): Buffer | null => {
		try {
			return readFileSync(join(dir!, rel))
		} catch {
			return null
		}
	}

	const request = (text: string, source: { path: string; revision: number; items: string[] }): string => {
		appendRequest(opts.outDir, text, { kind: "file", ...source })
		return `req-${readFileSync(join(opts.outDir, REQUESTS_FILE), "utf8").split("\n").filter((l) => l.trim()).length}`
	}
	const addEntry = (e: Omit<DriftEntry, "id" | "savedAt">) => {
		const entry: DriftEntry = { id: `drift-${entries.length + 1}`, savedAt: new Date().toISOString(), ...e }
		entries.push(entry)
		save()
		return entry
	}
	const resolve = (entry: DriftEntry, status: "adopted" | "reverted", requestId?: string) => {
		entry.status = status
		if (requestId) entry.requestId = requestId
		save()
		emit(makeEvent("drift.resolved", self.id, { id: entry.id, status, ...(requestId ? { requestId } : {}) }), self.id)
	}

	const commitRevision = () => {
		if (!dir) return
		const revision = state().contract.revision
		const base = lastBringupCommit(dir)
		const changed: string[] = []
		for (const [rel, src] of sources(opts.outDir)) {
			if (!existsSync(src)) continue
			const content = readFileSync(src)
			const disk = read(rel)
			const baseContent = base ? showAt(dir, base.hash, rel) : null
			const free = disk === null || (baseContent !== null && same(disk, baseContent)) || settledEdits.has(rel)
			if (!free) {
				for (const e of entries) if (e.path === rel && e.status === "open" && !e.note?.includes(SKIPPED)) e.note = `${e.note ?? ""}${e.note ? "; " : ""}${SKIPPED}`
				continue
			}
			if (disk !== null && same(disk, content)) continue
			mkdirSync(dirname(join(dir, rel)), { recursive: true })
			written.set(rel, content)
			writeFileSync(join(dir, rel), content)
			changed.push(rel)
		}
		const message = rippleMessage(seen, revision)
		const commit = commitPaths(dir, changed, message)
		emit(makeEvent("linked.committed", self.id, { commit: commit.slice(0, 7), revision, subject: message.split("\n")[0], files: changed }), self.id)
		settledEdits.clear()
		save()
	}

	const handle = (rel: string) => {
		if (!dir) return
		const view = viewOf(rel)
		const yours = view ? read(rel) : null
		if (!view || yours === null) return
		const mine = written.get(rel)
		if (mine && same(yours, mine)) return
		const before = handled.get(rel)
		if (before && same(yours, before)) return
		handled.set(rel, yours)
		const base = lastBringupCommit(dir)
		const baseContent = base ? showAt(dir, base.hash, rel) : null
		const contract = state().contract
		const baseSnap = base ? contract.snapshotAt(base.revision) : undefined
		if (!base || baseContent === null || !baseSnap) return
		const now = contract.snapshot()
		const c = classifyView(view, yours, baseContent, baseSnap, now)
		const at = { path: rel, savedRevision: base.revision, designRevision: now.revision }
		const file = rel.split("/").at(-1)!
		if (c.action === "untouched") {
			for (const e of entries) if (e.path === rel && e.status === "open") resolve(e, "reverted")
			return
		}
		if (c.action === "resaved") {
			settledEdits.add(rel)
			addEntry({ ...at, kind: "resaved", items: ["re-saved, no design change"], status: "re-saved", adoptable: false, note: "re-saved, no design change; ignored" })
			return
		}
		if (c.action === "drift") {
			const p: Payloads["file.drift"] = { ...at, reason: "not-in-contract", items: c.drift, message: DRIFT_MESSAGE }
			emit(makeEvent("file.drift", self.id, p), self.id)
			addEntry({ ...at, kind: "not-in-contract", items: c.drift, status: "open", adoptable: false, note: DRIFT_MESSAGE })
			return
		}
		const source = { path: rel, revision: base.revision, items: c.mapped }
		const items = c.mapped.join("; ")
		if (c.action === "request") {
			settledEdits.add(rel)
			addEntry({ ...at, kind: "adopted", items: c.mapped, status: "adopted", adoptable: true, requestId: request(`edited ${file}: ${items}`, source) })
		} else if (c.action === "rebase") {
			settledEdits.add(rel)
			const note = `rebased: ${c.movedSince.join(", ")} changed since rev ${base.revision}, independent of ${c.fields.join(", ")}`
			addEntry({ ...at, kind: "rebased", items: c.mapped, status: "rebased", adoptable: true, note, requestId: request(`edited ${file} at rev ${base.revision}, rebased onto rev ${now.revision}: ${items}`, source) })
		} else {
			// The same field changed since the base: the edit goes to that field's owner, who decides.
			settledEdits.add(rel)
			const clash = c.fields.filter((f) => c.movedSince.includes(f))
			const note = `conflict: ${clash.join(", ")} changed since rev ${base.revision}; sent to the owner of ${clash.join(", ")} to decide`
			addEntry({ ...at, kind: "stale", items: c.mapped, status: "adopted", adoptable: true, note, requestId: request(`conflict on ${clash.join(", ")}: edited ${file} at rev ${base.revision}, but ${clash.join(", ")} changed since (now rev ${now.revision}). Decide whether to apply: ${items}`, source) })
		}
		if (c.drift.length > 0) {
			emit(makeEvent("file.drift", self.id, { ...at, reason: "not-in-contract", items: c.drift, message: DRIFT_MESSAGE }), self.id)
			addEntry({ ...at, kind: "not-in-contract", items: c.drift, status: "open", adoptable: false, note: DRIFT_MESSAGE })
			settledEdits.delete(rel)
		}
	}

	const onAction = (a: DriftAction) => {
		const entry = entries.find((e) => e.id === a.driftId)
		if (!entry || entry.status !== "open" || !dir) return
		if (a.action === "revert") {
			const base = lastBringupCommit(dir)
			const content = base ? showAt(dir, base.hash, entry.path) : null
			if (!content) return
			writeFileSync(join(dir, entry.path), content)
			handled.set(entry.path, content)
			// Verified: the file's bytes are the base commit's again.
			if (same(read(entry.path), content)) resolve(entry, "reverted")
			return
		}
		const p = pending.get(entry.id)
		if (a.action === "adopt" && entry.adoptable && p) resolve(entry, "adopted", request(p.request, p.source))
	}

	const attach = (to: string) => {
		if (dir) return
		dir = to
		mkdirSync(dir, { recursive: true })
		ensureRepo(dir)
		opts.onAttach?.()
		actions = watchJsonl<DriftAction>(opts.outDir, DRIFT_ACTIONS_FILE, (raw) => {
			const a = raw as Partial<DriftAction>
			return typeof a.driftId === "string" && (a.action === "revert" || a.action === "adopt") ? (a as DriftAction) : null
		}, onAction)
		try {
			watcher = watch(dir, { recursive: true }, (_, name) => {
				const rel = String(name ?? "").replaceAll("\\", "/")
				if (!rel || rel.startsWith(".git")) return
				clearTimeout(timers.get(rel))
				timers.set(rel, setTimeout(() => {
					timers.delete(rel)
					try {
						handle(rel)
					} catch (error) {
						console.error("[linked] could not handle a saved file:", error)
					}
				}, opts.debounceMs ?? DEBOUNCE_MS))
			})
		} catch (error) {
			console.error("[linked] cannot watch the linked folder; edits won't sync:", error)
		}
		writeFileSync(join(opts.outDir, LINKED_FILE), JSON.stringify({ dir }, null, 2))
		emit(makeEvent("linked.attached", self.id, { dir }), self.id)
		// Linked after the design settled: commit what is there now.
		if (seen.some((e) => e.type === "design.settled")) commitRevision()
		save()
	}

	const close = () => {
		if (poll) clearInterval(poll)
		poll = null
		watcher?.close()
		watcher = null
		actions?.close()
		for (const t of timers.values()) clearTimeout(t)
		timers.clear()
		if (live && dir) {
			live = false
			save()
		}
	}

	if (opts.linkDir) attach(opts.linkDir)
	// `bringup link <run> <dir>` on a live run writes linked.json; the run picks it up.
	else
		poll = setInterval(() => {
			const p = join(opts.outDir, LINKED_FILE)
			if (!existsSync(p)) return
			try {
				attach(JSON.parse(readFileSync(p, "utf8")).dir)
			} catch (error) {
				console.error("[linked] bad linked.json:", error)
			}
		}, 1000)

	const participant = createHuman({
		name: "linked",
		capabilities: [],
		handlers: [
			{
				specification: { isSatisfiedBy: () => true } as never,
				processor: {
					apply: ({ event }) => {
						seen.push({ at: event.occurredAt.toISOString(), type: event.type, producerId: event.producerId, payload: event.payload })
						if (isEvent(event, "design.settled") && dir) commitRevision()
						if (isEvent(event, "run.ended")) close()
					},
				},
			},
		],
	})
	self.id = participant.getId()
	return Object.assign(participant, { close, attach })
}

const newest = (outDir: string, kind: string, rel: string): string | null => {
	const root = join(outDir, kind)
	if (!existsSync(root)) return null
	const revs = readdirSync(root).filter((d) => /^rev-\d+$/.test(d)).map((d) => Number(d.slice(4))).filter((r) => existsSync(join(root, `rev-${r}`, rel))).sort((a, b) => a - b)
	return revs.length ? join(root, `rev-${revs.at(-1)}`, rel) : null
}

// The newest built files of a run on disk, for linking after it ended (no live state to ask).
function sourcesOnDisk(outDir: string): Map<string, string> {
	const out = new Map<string, string>()
	const pins = newest(outDir, "firmware", "include/pins.h")
	if (pins) out.set("firmware/pins.h", pins)
	const pcb = newest(outDir, "board", "dist/board/kicad/board.kicad_pcb")
	if (pcb) {
		out.set("board/board.kicad_pcb", pcb)
		const fab = join(dirname(dirname(dirname(dirname(pcb)))), "fab")
		if (existsSync(fab)) for (const f of readdirSync(fab)) out.set(`fab/${f}`, join(fab, f))
	}
	for (const f of ["case.step", "case.stl"]) {
		const p = newest(outDir, "enclosure", f)
		if (p) out.set(`enclosure/${f}`, p)
	}
	return out
}

// `bringup link <runDir> <dir>`. A live run picks up linked.json and commits its current revision itself; for a run
// that has ended, the newest files on disk are written and committed here. Returns what it did, in words.
export function linkRun(outDir: string, dir: string, live: boolean): string {
	mkdirSync(dir, { recursive: true })
	ensureRepo(dir)
	writeFileSync(join(outDir, LINKED_FILE), JSON.stringify({ dir }, null, 2))
	if (live) return `linked ${dir}; the running design commits its current revision there and syncs edits from it`
	const contract = JSON.parse(readFileSync(join(outDir, "contract.json"), "utf8")) as ContractSnapshot
	const changed: string[] = []
	for (const [rel, src] of sourcesOnDisk(outDir)) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true })
		writeFileSync(join(dir, rel), readFileSync(src))
		changed.push(rel)
	}
	commitPaths(dir, changed, `Bringup rev ${contract.revision}: linked from ${outDir}\n\nThe run had ended; its newest built files.\n\nBringup-Revision: ${contract.revision}`)
	return `linked ${dir}: committed ${changed.length} file(s) at rev ${contract.revision} (the run has ended, so edits there won't sync until a run links it)`
}

// `bringup status <runDir>` for a linked run: every view in the linked folder compared three ways from disk alone
// (git for the base, contracts/rev-N.json and contract.json for the contract), so it works offline and after a restart.
export function linkedStatusLines(outDir: string): string[] {
	const p = join(outDir, LINKED_FILE)
	if (!existsSync(p)) return []
	const dir = JSON.parse(readFileSync(p, "utf8")).dir as string
	const base = existsSync(dir) ? lastBringupCommit(dir) : null
	if (!base) return [`Linked folder ${dir}: no Bringup commit yet.`]
	const snap = (rev: number): ContractSnapshot | null => {
		const f = join(outDir, "contracts", `rev-${rev}.json`)
		return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null
	}
	const baseSnap = snap(base.revision)
	const now = JSON.parse(readFileSync(join(outDir, "contract.json"), "utf8")) as ContractSnapshot
	const lines = [`Linked folder ${dir} (base ${base.hash.slice(0, 7)}, rev ${base.revision}; design at rev ${now.revision}):`]
	const views = [...VIEWS.map((v) => v.path), ...(existsSync(join(dir, "fab")) ? readdirSync(join(dir, "fab")).map((f) => `fab/${f}`) : [])]
	let clean = 0
	for (const rel of views) {
		const view = viewOf(rel)!
		const yours = existsSync(join(dir, rel)) ? readFileSync(join(dir, rel)) : null
		const baseContent = showAt(dir, base.hash, rel)
		if (yours === null || baseContent === null || !baseSnap) continue
		const c = classifyView(view, yours, baseContent, baseSnap, now)
		if (c.action === "untouched") {
			clean++
			continue
		}
		const what =
			c.action === "resaved" ? "re-saved, no design change" :
			c.action === "drift" ? "not in the contract" :
			c.action === "request" ? "maps to the contract (a change request)" :
			c.action === "rebase" ? `maps, independent of ${c.movedSince.join(", ")} changed since: rebase` :
			`conflict: ${c.fields.filter((f) => c.movedSince.includes(f)).join(", ")} changed since`
		lines.push(`  modified  ${rel}  (${what})`)
		for (const item of [...("mapped" in c ? c.mapped : []), ...("drift" in c ? c.drift : [])]) lines.push(`              ${item}`)
	}
	lines.push(`  ${clean} file(s) as Bringup committed them`)
	return lines
}

export interface LinkedCommit {
	id: string
	revision: number
	subject: string
	at: string
	source: "brief" | "typed" | "file"
	requestId: string | null
}

export interface LinkedInfo {
	dir: string
	git: boolean
	// Uncommitted changes to files Bringup tracks there: the engineer's edits.
	dirty: boolean
	commits: LinkedCommit[]
}

// For the hub's Files panel: the linked folder and Bringup's commits there, newest first (null if not linked).
export function linkedInfo(outDir: string): LinkedInfo | null {
	const p = join(outDir, LINKED_FILE)
	if (!existsSync(p)) return null
	const dir = JSON.parse(readFileSync(p, "utf8")).dir as string
	const isGit = existsSync(join(dir, ".git"))
	if (!isGit) return { dir, git: false, dirty: false, commits: [] }
	let dirty = false
	let log = ""
	try {
		dirty = git(dir, ["status", "--porcelain", "--untracked-files=no"]).trim() !== ""
		const trailer = (key: string) => `%(trailers:key=${key},valueonly,separator=%x2C)`
		log = git(dir, ["log", "--author=bringup@localhost", `--format=%h%x1f%cI%x1f%s%x1f${trailer("Bringup-Revision")}%x1f${trailer("Bringup-Source")}%x1f${trailer("Bringup-Request")}%x1e`])
	} catch {
		// No commits yet.
	}
	const commits = log.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
		const [id, at, subject, revision, source, requestId] = r.split("\x1f").map((x) => x.trim())
		return { id, at, subject, revision: Number(revision), source: (source || "brief") as LinkedCommit["source"], requestId: requestId || null }
	})
	return { dir, git: true, dirty, commits }
}
