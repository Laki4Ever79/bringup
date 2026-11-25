import { isDeepStrictEqual } from "node:util"
import { BUILD_DERIVED, BUILD_INPUTS, BUILD_REQUIRES } from "../agents/builders.ts"
import { checkConsistency, type Artifacts, type Violation } from "../contract/consistency.ts"
import { FIELDS, type ContractSnapshot, type FieldName } from "../contract/types.ts"
import { pinsEdits } from "./file-sync.ts"
import type { Breakage, EditInput, SuggestedFix, VerifyBuild, VerifyCheck, VerifyResult } from "./steer.ts"

// Verifying an edit the engineer made while the run is paused (runner/steer.ts): the contract's own validation, the
// run's cross-domain checks, and the builds the edit touches, each compared with the design as it is, so only what the
// edit itself breaks is reported. When it breaks something, a fix is suggested from the checks themselves (the
// smallest change to the edit that clears them) or from the compiler (the changed lines its error points at). No model
// is asked: plain code, the same on scripted and real runs.

// The builds an edit can be checked with (the run's own tools); null in a run without hardware tools (--no-hardware).
export interface VerifyTools {
	// Builds one artifact of the edited contract in `dir`, as the run's builder would.
	build(kind: BuildKind, snapshot: ContractSnapshot, dir: string): Promise<{ ok: boolean; detail: string; artifact?: unknown }>
	// Compiles an existing firmware folder (a copy of a revision's, with the engineer's file in it).
	compileFirmware(dir: string, snapshot: ContractSnapshot): Promise<{ ok: boolean; log: string }>
	// A scratch folder holding a copy of `from` (a revision's firmware folder), for compileFirmware.
	copyDir(from: string, to: string): Promise<void>
}

export type BuildKind = "firmware" | "board" | "chassis"
const BUILD_KINDS: BuildKind[] = ["firmware", "board", "chassis"]

export interface VerifyContext {
	snapshot: ContractSnapshot
	artifacts: Artifacts
	brief: string
	outDir: string
	// The contract's validation of a value for a field (as its owner would write it), null when valid.
	validate: (field: FieldName, value: unknown) => string | null
	tools: VerifyTools | null
	// A fresh folder for this verification's builds.
	scratch: string
	readFile: (path: string) => string | null
	writeFile: (path: string, content: string) => void
}

const key = (v: { kind: string; message: string }) => `${v.kind}\u0000${v.message}`

// The quick (contract-only) violations a value raises that the current contract doesn't have, plus its invalidity.
export function contractBreakage(s: ContractSnapshot, field: FieldName, value: unknown, brief: string, validate: VerifyContext["validate"]): Breakage[] {
	const invalid = validate(field, value)
	if (invalid) return [{ kind: "invalid", message: invalid, fields: [field] }]
	const before = new Set(checkConsistency(s, {}, brief, { quick: true }).map(key))
	const after = checkConsistency(withField(s, field, value), {}, brief, { quick: true })
	return after.filter((v) => !before.has(key(v))).map((v) => ({ kind: v.kind, message: v.message, fields: v.fields }))
}

export function withField(s: ContractSnapshot, field: FieldName, value: unknown): ContractSnapshot {
	return { ...s, values: { ...s.values, [field]: value } } as ContractSnapshot
}

// The artifacts an edit to `field` rebuilds (of the ones verification builds).
export function kindsTouched(field: FieldName): BuildKind[] {
	return BUILD_KINDS.filter((k) => BUILD_INPUTS[k].includes(field) || Boolean(BUILD_DERIVED[k]?.fields.includes(field)))
}

// ---- Suggested fixes from the checks ---------------------------------------------------------------------------------

// One independently changeable piece of an edit: a leaf of an object field, or one element of a list field (matched by
// its ref, signal, id or name). `options` are the values to try for it, best first; the last is the current value.
interface Unit {
	label: string
	get: (v: unknown) => unknown
	set: (v: unknown, x: unknown) => unknown
	from: unknown
	to: unknown
}

const ID_KEYS = ["ref", "signal", "id", "name"]
const idOf = (x: unknown): string | null => {
	if (!x || typeof x !== "object") return null
	for (const k of ID_KEYS) if (typeof (x as Record<string, unknown>)[k] === "string") return `${k}=${(x as Record<string, string>)[k]}`
	return null
}
const clone = <T,>(v: T): T => (v === undefined ? v : structuredClone(v))

function units(from: unknown, to: unknown, label: string, get: Unit["get"], set: Unit["set"]): Unit[] {
	if (isDeepStrictEqual(from, to)) return []
	if (Array.isArray(from) && Array.isArray(to) && [...from, ...to].every((x) => idOf(x) !== null)) {
		// A list of named things: per element, so one bad pin doesn't cost the engineer the other pins they changed.
		const ids = [...new Set([...from, ...to].map((x) => idOf(x)!))]
		return ids.flatMap((id) => {
			const a = from.find((x) => idOf(x) === id)
			const b = to.find((x) => idOf(x) === id)
			const getEl = (v: unknown) => (get(v) as unknown[] | undefined)?.find((x) => idOf(x) === id)
			const setEl = (v: unknown, x: unknown) => {
				const list = [...((get(v) as unknown[] | undefined) ?? [])]
				const i = list.findIndex((y) => idOf(y) === id)
				if (x === undefined) {
					if (i >= 0) list.splice(i, 1)
				} else if (i >= 0) list[i] = x
				else list.push(x)
				return set(v, list)
			}
			const name = `${label}[${id.split("=")[1]}]`
			if (a && b && typeof a === "object" && typeof b === "object") return units(a, b, name, getEl, setEl)
			return [{ label: name, get: getEl, set: setEl, from: a, to: b }]
		})
	}
	if (from && to && typeof from === "object" && typeof to === "object" && !Array.isArray(from) && !Array.isArray(to)) {
		const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])]
		return keys.flatMap((k) =>
			units(
				(from as Record<string, unknown>)[k],
				(to as Record<string, unknown>)[k],
				`${label}.${k}`,
				(v) => (get(v) as Record<string, unknown> | undefined)?.[k],
				(v, x) => {
					const o = { ...((get(v) as Record<string, unknown> | undefined) ?? {}) }
					if (x === undefined) delete o[k]
					else o[k] = x
					return set(v, o)
				},
			),
		)
	}
	return [{ label, get, set, from, to }]
}

const show = (x: unknown) => (x === undefined ? "(none)" : typeof x === "object" ? JSON.stringify(x).slice(0, 60) : String(x))

// The values to try for one unit, closest to the engineer's first, the current value last.
function options(u: Unit, value: unknown, passesWith: (x: unknown) => boolean, usedGpios: Set<number>): { x: unknown; why: string }[] {
	// passesWith: this unit at x clears every breakage (the edit's other units as they are).
	const out: { x: unknown; why: string }[] = []
	if (typeof u.from === "number" && typeof u.to === "number") {
		if (u.label.endsWith(".gpio")) {
			// A pin that clashes: the free GPIOs nearest the one asked for.
			const free = Array.from({ length: 49 }, (_, i) => i).filter((g) => g !== u.to && g !== u.from && !usedGpios.has(g)).sort((a, b) => Math.abs(a - (u.to as number)) - Math.abs(b - (u.to as number)))
			for (const g of free.slice(0, 24)) out.push({ x: g, why: `a free pin near GPIO${u.to}` })
		} else if (passesWith(u.from)) {
			// A size or position: the value nearest the engineer's that still passes (bisected between the two).
			let lo = u.from, hi = u.to
			const step = Number.isInteger(u.from) && Number.isInteger(u.to) ? 1 : 0.5
			for (let i = 0; i < 14 && Math.abs(hi - lo) > step; i++) {
				const mid = Math.round((lo + hi) / 2 / step) * step
				if (mid === lo || mid === hi) break
				if (passesWith(mid)) lo = mid
				else hi = mid
			}
			if (lo !== u.from) out.push({ x: lo, why: `the nearest to ${u.to} that passes` })
		}
	}
	out.push({ x: clone(u.from), why: u.from === undefined ? "left out" : "kept as it was" })
	return out.filter((o) => !isDeepStrictEqual(o.x, u.get(value)))
}

// The smallest change to the engineer's value that clears what it breaks: unit by unit, each set to its best option
// that lowers the count of breakages, until none is left. Null when even the current value doesn't pass.
export function suggestFieldFix(s: ContractSnapshot, field: FieldName, value: unknown, brief: string, validate: VerifyContext["validate"]): SuggestedFix | null {
	const current = s.values[field]
	const score = (v: unknown) => contractBreakage(s, field, v, brief, validate).length
	if (score(value) === 0) return null
	const all = units(current, value, field, (v) => v, (_v, x) => x)
	const usedGpios = new Set<number>(((field === "pins" ? value : s.values.pins) as { gpio?: number }[] | undefined ?? []).map((p) => p.gpio).filter((g): g is number => typeof g === "number"))
	let v = clone(value)
	let best = score(v)
	const changes: string[] = []
	for (const u of all) {
		if (best === 0) break
		const tries = options(u, v, (x) => score(u.set(v, x)) === 0, usedGpios)
		for (const o of tries) {
			const next = u.set(v, clone(o.x))
			const sc = score(next)
			if (sc < best) {
				v = next
				best = sc
				changes.push(`${u.label} ${show(u.to)} → ${show(o.x)} (${o.why})`)
				if (typeof o.x === "number" && u.label.endsWith(".gpio")) usedGpios.add(o.x)
				break
			}
		}
	}
	if (best === 0 && changes.length > 0)
		return { summary: changes.join("; "), source: "checks", edit: { kind: "field", field, value: v }, checkedWith: "the contract's validation and the run's cross-domain checks" }
	if (contractBreakage(s, field, current, brief, validate).length === 0 && current !== undefined)
		return { summary: `keep ${field} as it was: no smaller change to your edit clears the checks`, source: "revert", edit: { kind: "field", field, value: clone(current) }, checkedWith: "the current design passes these checks" }
	return null
}

// ---- Suggested fixes from the compiler -------------------------------------------------------------------------------

// The compiler's errors in one file: line and message, from `path:line:col: error: message` lines.
export function compileErrors(log: string, file: string): { line: number; message: string }[] {
	const base = file.split("/").pop()!
	const out: { line: number; message: string }[] = []
	for (const m of log.matchAll(/^(.*?):(\d+):(?:\d+:)?\s*(?:fatal )?error:\s*(.*)$/gm)) {
		if (m[1].split("/").pop() === base) out.push({ line: Number(m[2]), message: m[3].trim() })
	}
	return out
}

// The changed regions of `edited` against `original`, as 1-based line ranges in edited (an LCS line diff).
export function hunks(original: string, edited: string): { start: number; end: number; was: string[]; now: string[] }[] {
	const a = original.split("\n"), b = edited.split("\n")
	const n = a.length, m = b.length
	// Lines both share at the ends are trimmed first, so the table stays small for one local edit.
	let pre = 0
	while (pre < n && pre < m && a[pre] === b[pre]) pre++
	let suf = 0
	while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++
	const A = a.slice(pre, n - suf), B = b.slice(pre, m - suf)
	const L = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0))
	for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
	const out: { start: number; end: number; was: string[]; now: string[] }[] = []
	let i = 0, j = 0
	let cur: { start: number; end: number; was: string[]; now: string[] } | null = null
	const flush = () => {
		if (cur) out.push(cur)
		cur = null
	}
	while (i < A.length || j < B.length) {
		if (i < A.length && j < B.length && A[i] === B[j]) {
			flush()
			i++, j++
		} else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) {
			cur ??= { start: pre + j + 1, end: pre + j, was: [], now: [] }
			cur.now.push(B[j++])
			cur.end = pre + j
		} else {
			cur ??= { start: pre + j + 1, end: pre + j, was: [], now: [] }
			cur.was.push(A[i++])
		}
	}
	flush()
	return out
}

// The edited text with one hunk put back as it was.
export function revertHunk(edited: string, h: { start: number; end: number; was: string[]; now: string[] }): string {
	const lines = edited.split("\n")
	lines.splice(h.start - 1, h.now.length, ...h.was)
	return lines.join("\n")
}

// The hunk an error on `line` most likely comes from: the one containing it, else the nearest one above it.
export function hunkFor(hs: ReturnType<typeof hunks>, line: number): ReturnType<typeof hunks>[number] | null {
	return hs.find((h) => line >= h.start && line <= Math.max(h.start, h.end)) ?? [...hs].reverse().find((h) => h.start <= line) ?? hs[0] ?? null
}

// ---- Verification ----------------------------------------------------------------------------------------------------

const FIRMWARE_FILE = /^firmware\/rev-(\d+)\/((?:src|include|lib|test_host)\/.+|platformio\.ini)$/
const PINS_H = /^firmware\/rev-(\d+)\/include\/pins\.h$/

// A path the engineer may edit: relative to the run folder, no way out of it.
export function editablePath(path: string): string | null {
	const p = path.replace(/^\.\/+/, "")
	if (!p || p.startsWith("/") || p.split("/").some((x) => x === ".." || x === "")) return null
	return FIRMWARE_FILE.test(p) || /^board\/rev-\d+\//.test(p) || /^(enclosure|chassis)\/rev-\d+\//.test(p) ? p : null
}

export async function verifyEdit(edit: EditInput, ctx: VerifyContext): Promise<VerifyResult> {
	const base = { at: new Date().toISOString(), revision: ctx.snapshot.revision }
	if (edit.kind === "field") return { ...base, ...(await verifyField(edit.field, edit.value, ctx, [])) }
	const path = editablePath(edit.path)
	if (!path) return { ...base, ok: false, checks: [{ name: "path", ok: false, detail: `${edit.path} isn't a generated file of this run` }], builds: [], broke: [{ kind: "path", message: `${edit.path} isn't a generated file of this run` }], fix: null, notes: [] }
	const original = ctx.readFile(path)
	if (original === null) return { ...base, ok: false, checks: [{ name: "path", ok: false, detail: `${path} doesn't exist` }], builds: [], broke: [{ kind: "path", message: `${path} doesn't exist` }], fix: null, notes: [] }
	// pins.h is the contract's pins as C: an edit to a pin number is a change to the pins field (as file-sync maps it).
	if (PINS_H.test(path)) {
		const e = pinsEdits(edit.content, original, ctx.snapshot)
		const notes = e.drift.map((d) => `pins.h: ${d} isn't in the contract; the next firmware build overwrites it`)
		if (e.pins) {
			const r = await verifyField("pins", e.pins, ctx, [`pins.h maps to the contract's pins: ${e.mapped.join(", ")}`, ...notes])
			// Applied as the pins it maps to (the file is rewritten from them on the next build); a fix is offered as pins too.
			return { ...base, ...r, asField: { field: "pins", value: e.pins } }
		}
		if (notes.length === 0) return { ...base, ok: true, checks: [{ name: "pins.h", ok: true, detail: "no change" }], builds: [], broke: [], fix: null, notes }
	}
	const fw = FIRMWARE_FILE.exec(path)
	if (fw) return { ...base, ...(await verifyFirmwareFile(path, `firmware/rev-${fw[1]}`, original, edit.content, ctx)) }
	return { ...base, ok: true, checks: [{ name: "file", ok: true, detail: "saved as the engineer's file; no build checks this kind of file here" }], builds: [], broke: [], fix: null, notes: [`${path} is generated: the next rebuild of it overwrites a hand edit`] }
}

type Verdict = Omit<VerifyResult, "at" | "revision">

async function verifyField(field: FieldName, value: unknown, ctx: VerifyContext, notes: string[]): Promise<Verdict> {
	if (!FIELDS.includes(field)) return { ok: false, checks: [], builds: [], broke: [{ kind: "invalid", message: `${field} is not a contract field` }], fix: null, notes }
	const checks: VerifyCheck[] = []
	const contract = contractBreakage(ctx.snapshot, field, value, ctx.brief, ctx.validate)
	const invalid = contract.find((b) => b.kind === "invalid")
	checks.push({ name: "contract", ok: !invalid, detail: invalid ? invalid.message : "the value is valid for the contract" })
	checks.push({ name: "cross-domain checks", ok: invalid ? false : contract.length === 0, detail: invalid ? "not run: the value isn't valid" : contract.length === 0 ? "no new violation" : `${contract.length} new violation${contract.length > 1 ? "s" : ""}` })
	const broke = [...contract]
	const builds: VerifyBuild[] = []
	const edited = withField(ctx.snapshot, field, value)
	// A design without that domain has nothing to build there: not listed at all.
	for (const kind of kindsTouched(field).filter((k) => k !== "chassis" || (edited.values.mechanics && edited.values.motion))) {
		if (!ctx.tools) {
			builds.push({ kind, ok: true, skipped: "this run builds without the hardware tools (--no-hardware)", detail: "not built" })
			continue
		}
		if (broke.length > 0) {
			builds.push({ kind, ok: true, skipped: "the checks above already fail; it is built once they pass", detail: "not built" })
			continue
		}
		const missing = BUILD_REQUIRES[kind].filter((f) => edited.values[f] === undefined)
		if (missing.length > 0) {
			builds.push({ kind, ok: true, skipped: `the contract has no ${missing.join(", ")} yet`, detail: "not built" })
			continue
		}
		const t0 = Date.now()
		try {
			const r = await ctx.tools.build(kind, edited, `${ctx.scratch}/${kind}`)
			builds.push({ kind, ok: r.ok, detail: r.detail, ms: Date.now() - t0 })
			if (!r.ok) broke.push({ kind: `${kind}-build`, message: r.detail })
			else if (r.artifact) {
				// The rebuilt artifact against the edited contract, compared with today's artifact against today's contract.
				const only = { [kind]: r.artifact } as Artifacts
				const was = (ctx.artifacts as Record<string, unknown>)[kind] ? ({ [kind]: (ctx.artifacts as Record<string, unknown>)[kind] } as Artifacts) : {}
				const before = new Set(checkConsistency(ctx.snapshot, was, ctx.brief).map(key))
				for (const v of checkConsistency(edited, only, ctx.brief)) if (!before.has(key(v)) && !broke.some((b) => key(b) === key(v))) broke.push({ kind: v.kind, message: v.message, fields: v.fields })
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			builds.push({ kind, ok: false, detail: message.slice(-600), ms: Date.now() - t0 })
			broke.push({ kind: `${kind}-build`, message: message.slice(-600) })
		}
	}
	if (builds.some((b) => !b.skipped)) checks.push({ name: "builds", ok: builds.every((b) => b.ok), detail: builds.map((b) => `${b.kind} ${b.skipped ? "skipped" : b.ok ? "ok" : "failed"}`).join(", ") })
	const fix = broke.length > 0 ? suggestFieldFix(ctx.snapshot, field, value, ctx.brief, ctx.validate) : null
	return { ok: broke.length === 0, checks, builds, broke, fix, notes }
}

const firstLines = (log: string, n = 12) => log.split("\n").filter((l) => /error/i.test(l)).slice(0, n).join("\n") || log.split("\n").slice(-n).join("\n")

async function verifyFirmwareFile(path: string, fwDir: string, original: string, content: string, ctx: VerifyContext): Promise<Verdict> {
	const notes = [`${path} is generated: the next firmware build overwrites a hand edit`]
	if (!ctx.tools) return { ok: true, checks: [{ name: "compile", ok: true, detail: "not compiled: this run builds without the hardware tools (--no-hardware)" }], builds: [{ kind: "firmware", ok: true, skipped: "this run builds without the hardware tools (--no-hardware)", detail: "not built" }], broke: [], fix: null, notes }
	const compile = async (text: string, tag: string) => {
		const dir = `${ctx.scratch}/${tag}`
		await ctx.tools!.copyDir(`${ctx.outDir}/${fwDir}`, dir)
		ctx.writeFile(`${dir}/${path.slice(fwDir.length + 1)}`, text)
		const t0 = Date.now()
		const r = await ctx.tools!.compileFirmware(dir, ctx.snapshot)
		return { ...r, ms: Date.now() - t0 }
	}
	const r = await compile(content, "fw")
	const build: VerifyBuild = { kind: "firmware", ok: r.ok, detail: r.ok ? "compiles" : firstLines(r.log), ms: r.ms }
	if (r.ok) return { ok: true, checks: [{ name: "compile", ok: true, detail: `the firmware compiles with your file · ${(r.ms / 1000).toFixed(1)} s` }], builds: [build], broke: [], fix: null, notes }
	const errors = compileErrors(r.log, path)
	const broke: Breakage[] = errors.length ? errors.slice(0, 5).map((e) => ({ kind: "compile-error", message: `${path.split("/").pop()}:${e.line}: ${e.message}` })) : [{ kind: "compile-error", message: firstLines(r.log, 4) }]
	// The fix: the changed lines the first error points at, put back; checked by compiling it.
	let fix: SuggestedFix | null = null
	const hs = hunks(original, content)
	const h = errors.length ? hunkFor(hs, errors[0].line) : null
	if (h && hs.length > 1) {
		const fixed = revertHunk(content, h)
		const again = await compile(fixed, "fw-fix")
		if (again.ok) fix = { summary: `put back lines ${h.start}–${Math.max(h.start, h.end)} as generated (the error is there); your other changes stay`, source: "compiler", edit: { kind: "file", path, content: fixed }, checkedWith: "compiled: the firmware builds with it" }
	}
	fix ??= { summary: `keep ${path.split("/").pop()} as generated: ${errors.length ? "the compiler rejects your change" : "the firmware doesn't build with it"}`, source: "revert", edit: { kind: "file", path, content: original }, checkedWith: "the generated file compiled in this run" }
	return { ok: false, checks: [{ name: "compile", ok: false, detail: broke[0].message }], builds: [build], broke, fix, notes }
}
