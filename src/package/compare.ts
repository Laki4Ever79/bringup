// A design before and after a change (get_pictures compare): the run's state at two contract revisions, read from what
// the run already kept: contracts/rev-N.json, and each builder's newest rev-N folder at or below the revision (a builder
// that didn't rebuild for a change still shows what it built before). The summary is one line a person reads: the
// board's size, parts moved / added / removed (the boards' pick-and-place files), each simulation's verdict, the
// contract fields that changed.
//
// Public, in the engine.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface DesignAt {
	revision: number
	contract: Record<string, unknown> | null
	dirs: Partial<Record<"board" | "chassis" | "enclosure" | "drive" | "armsim" | "cncsim" | "arm", string>>
}

// The newest kind/rev-N at or below the revision that holds `has`.
export function revDirAtOrBelow(dir: string, rev: number, has?: string): string | null {
	if (!existsSync(dir)) return null
	const revs = readdirSync(dir).map((n) => /^rev-(\d+)$/.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).filter((n) => n <= rev).sort((a, b) => b - a)
	const n = revs.find((r) => !has || existsSync(join(dir, `rev-${r}`, has)))
	return n === undefined ? null : join(dir, `rev-${n}`)
}

export function designAt(runDir: string, revision: number): DesignAt {
	const contractFile = revDirAtOrBelowFile(join(runDir, "contracts"), revision)
	const contract = contractFile ? ((JSON.parse(readFileSync(contractFile, "utf8")) as { values?: Record<string, unknown> }).values ?? null) : null
	const dirs: DesignAt["dirs"] = {}
	const put = (k: keyof DesignAt["dirs"], has?: string) => {
		const d = revDirAtOrBelow(join(runDir, k), revision, has)
		if (d) dirs[k] = d
	}
	put("board", "board.png")
	put("chassis", "chassis.stl")
	put("enclosure", "case.stl")
	put("drive", "drive.json")
	put("armsim", "arm.json")
	put("cncsim", "result.json")
	put("arm", join("arm", "posed", "groups.json"))
	return { revision, contract, dirs }
}

// contracts/rev-N.json: the newest at or below the revision.
function revDirAtOrBelowFile(dir: string, rev: number): string | null {
	if (!existsSync(dir)) return null
	const revs = readdirSync(dir).map((n) => /^rev-(\d+)\.json$/.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).filter((n) => n <= rev).sort((a, b) => b - a)
	return revs.length ? join(dir, `rev-${revs[0]}.json`) : null
}

// The last change request and the revisions either side of it: before = the contract's revision when it arrived, after =
// the run's newest. null when the run had no change request.
export function lastChange(runDir: string): { text: string; before: number; after: number } | null {
	const file = join(runDir, "trace.jsonl")
	if (!existsSync(file)) return null
	const events = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload?: { revision?: number; text?: string } })
	const at = events.findLastIndex((e) => e.type === "change.requested")
	if (at < 0) return null
	const revs = (from: number, to: number) => events.slice(from, to).filter((e) => e.type === "contract.changed" && typeof e.payload?.revision === "number").map((e) => e.payload!.revision!)
	const before = Math.max(0, ...revs(0, at))
	const after = Math.max(before, ...revs(at, events.length))
	return { text: String(events[at].payload?.text ?? ""), before, after }
}

// Each part's centre on the board from its pick-and-place file (fab/cpl.csv: Designator, Mid X, Mid Y, Layer, Rotation).
function placements(boardDir: string | undefined): Map<string, [number, number]> {
	const m = new Map<string, [number, number]>()
	const f = boardDir ? join(boardDir, "fab", "cpl.csv") : null
	if (!f || !existsSync(f)) return m
	for (const line of readFileSync(f, "utf8").split(/\r?\n/).slice(1)) {
		const [ref, x, y] = line.split(",")
		if (ref && x && y) m.set(ref.trim(), [parseFloat(x), parseFloat(y)])
	}
	return m
}

const verdict = (dir: string | undefined, file: string): string | null => {
	if (!dir || !existsSync(join(dir, file))) return null
	try {
		return String((JSON.parse(readFileSync(join(dir, file), "utf8")) as { result?: string }).result ?? "?")
	} catch {
		return null
	}
}

// Every leaf value that differs between two JSON values, as [path, before, after] ("chassis.boards[0].at.xMm").
export function leafChanges(a: unknown, b: unknown, path = ""): [string, unknown, unknown][] {
	if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b) && (!Array.isArray(a) || a.length === (b as unknown[]).length)) {
		const keys = Array.isArray(a) ? a.map((_, i) => i) : [...new Set([...Object.keys(a), ...Object.keys(b as object)])]
		return keys.flatMap((k) => leafChanges((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : String(k)))
	}
	return JSON.stringify(a) === JSON.stringify(b) ? [] : [[path, a, b]]
}

// One change as a person reads it: "chassis board 1 at x -20 → -15 mm" from chassis.boards[0].at.xMm.
function said([path, a, b]: [string, unknown, unknown]): string {
	const mm = /Mm$/.test(path)
	const words = path
		.replace(/\[(\d+)\]/g, (_, i) => ` ${Number(i) + 1}`)
		.replace(/Mm$/, "")
		.split(".")
		.join(" ")
	const v = (x: unknown) => (x === undefined ? "none" : typeof x === "object" ? "…" : String(x))
	return `${words} ${v(a)} → ${v(b)}${mm ? " mm" : ""}`
}

export interface Comparison {
	summary: string
	changed: { board: boolean; assembly: boolean; motion: boolean }
	details: {
		outline?: { before: [number, number] | null; after: [number, number] | null }
		moved: string[]
		added: string[]
		removed: string[]
		verdicts: { what: string; before: string | null; after: string | null }[]
		fields: string[]
	}
}

export function compareDesigns(a: DesignAt, b: DesignAt): Comparison {
	const size = (c: Record<string, unknown> | null): [number, number] | null => {
		const o = c?.outline as { widthMm?: number; heightMm?: number } | undefined
		return o && typeof o.widthMm === "number" && typeof o.heightMm === "number" ? [o.widthMm, o.heightMm] : null
	}
	const sa = size(a.contract), sb = size(b.contract)
	const pa = placements(a.dirs.board), pb = placements(b.dirs.board)
	// Moved: more than half a millimetre (the router's own rounding stays under it).
	const moved = [...pb].filter(([ref, [x, y]]) => pa.has(ref) && Math.hypot(x - pa.get(ref)![0], y - pa.get(ref)![1]) > 0.5).map(([ref]) => ref)
	const refs = (c: Record<string, unknown> | null) => new Set(((c?.parts as { ref: string }[] | undefined) ?? []).map((p) => p.ref))
	const ra = refs(a.contract), rb = refs(b.contract)
	const added = [...rb].filter((r) => !ra.has(r)), removed = [...ra].filter((r) => !rb.has(r))
	const verdicts = (
		[
			["drive", "drive", "drive.json"],
			["pick-and-place", "armsim", "arm.json"],
			["machine", "cncsim", "result.json"],
		] as const
	)
		.map(([what, k, f]) => ({ what, before: verdict(a.dirs[k], f), after: verdict(b.dirs[k], f) }))
		.filter((v) => v.before !== null || v.after !== null)
	const keys = [...new Set([...Object.keys(a.contract ?? {}), ...Object.keys(b.contract ?? {})])]
	const fields = keys.filter((k) => JSON.stringify(a.contract?.[k]) !== JSON.stringify(b.contract?.[k]))
	const list = (xs: string[]) => (xs.length > 3 ? `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more` : xs.join(", "))
	const parts: string[] = []
	if (sa && sb && (sa[0] !== sb[0] || sa[1] !== sb[1])) parts.push(`board ${sa[0]}×${sa[1]} → ${sb[0]}×${sb[1]} mm`)
	else if (sb) parts.push(`board ${sb[0]}×${sb[1]} mm, same size`)
	if (moved.length) parts.push(`${list(moved)} moved`)
	if (added.length) parts.push(`added ${list(added)}`)
	if (removed.length) parts.push(`removed ${list(removed)}`)
	for (const v of verdicts) parts.push(`${v.what} ${v.before ?? "not run"} → ${v.after ?? "not run"}`)
	// Each changed field down to its values: up to four said one by one; a field with more, as a count.
	for (const f of fields) {
		if (f === "parts" || f === "outline") continue // said above (added, removed; the board's size)
		const leaves = leafChanges(a.contract?.[f], b.contract?.[f])
		if (!leaves.length) continue
		parts.push(leaves.length <= 4 ? leaves.map(said).join(", ") : `${f}: ${leaves.length} values changed`)
	}
	const assemblyA = a.dirs.chassis ?? a.dirs.arm ?? a.dirs.enclosure, assemblyB = b.dirs.chassis ?? b.dirs.arm ?? b.dirs.enclosure
	const motionA = a.dirs.drive ?? a.dirs.armsim ?? a.dirs.cncsim, motionB = b.dirs.drive ?? b.dirs.armsim ?? b.dirs.cncsim
	return {
		summary: parts.join("; ") || "nothing changed",
		changed: { board: a.dirs.board !== b.dirs.board, assembly: assemblyA !== assemblyB, motion: motionA !== motionB },
		details: { outline: { before: sa, after: sb }, moved, added, removed, verdicts, fields },
	}
}
