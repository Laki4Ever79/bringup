import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// One screen about a finished (or running) run, read from its folder only: the status, the violations, and each
// built artifact's own verdict (the case's print check, the chassis' interference, the simulated drive, the ROS
// test), with the files worth opening. Shared by the MCP server's run_summary and `bringup summary` (text-to-cad
// and cadsmith print a short verdict per run; ours lists what each domain's own check said). A system run gives one
// block per board.

export interface ArtifactLine { what: string; revision: number | null; verdict: string; file?: string }
export interface BoardSummary { board: string; status: string; violations: string[]; artifacts: ArtifactLine[] }
export interface RunSummary { runId: string; kind: "design" | "system"; status: string; boards: BoardSummary[]; files: string[]; text: string }

const latestRev = (dir: string): { rev: number; path: string } | null => {
	if (!existsSync(dir)) return null
	const revs = readdirSync(dir).map((n) => /^rev-(\d+)$/.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]))
	if (!revs.length) return null
	const rev = Math.max(...revs)
	return { rev, path: join(dir, `rev-${rev}`) }
}
const json = (p: string): any => {
	try { return JSON.parse(readFileSync(p, "utf8")) } catch { return null }
}

function boardSummary(dir: string, board: string): BoardSummary {
	const report = existsSync(join(dir, "report.md")) ? readFileSync(join(dir, "report.md"), "utf8") : ""
	const status = /^Status: (.+)$/m.exec(report)?.[1] ?? (existsSync(join(dir, "trace.jsonl")) ? "running (no report yet)" : "not started")
	// The report's violation bullets, under "Violations: N".
	const vblock = /^Violations: \d+\n((?:- .+\n?)*)/m.exec(report)?.[1] ?? ""
	const violations = vblock.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2))
	const artifacts: ArtifactLine[] = []
	// A folder alone isn't a build: a stubbed or skipped build (no toolchain, --no-hardware) leaves it empty.
	const ended = report !== ""
	const absent = ended ? "not built (stubbed, or its tool is missing: the report says which)" : "building"
	const b = latestRev(join(dir, "board"))
	if (b) {
		const drc = json(join(b.path, "drc.json"))
		const errors = Array.isArray(drc?.violations) ? drc.violations.filter((v: any) => v.severity === "error").length : null
		artifacts.push({ what: "board", revision: b.rev, verdict: errors === null ? (existsSync(join(b.path, "board.png")) ? "built" : absent) : `built, DRC ${errors} error(s)`, file: existsSync(join(b.path, "board.png")) ? join(b.path, "board.png") : undefined })
	}
	const e = latestRev(join(dir, "enclosure"))
	if (e) {
		const p = json(join(e.path, "print.json"))
		artifacts.push({ what: "case", revision: e.rev, verdict: p ? (p.ok ? "print check ok" : `print check: ${p.issues.join("; ")}`) : existsSync(join(e.path, "case.stl")) ? "built" : absent, file: existsSync(join(e.path, "case.stl")) ? join(e.path, "case.stl") : undefined })
	}
	const c = latestRev(join(dir, "chassis"))
	if (c) {
		const i = json(join(c.path, "mounts.json"))?.interference
		artifacts.push({ what: "chassis", revision: c.rev, verdict: i ? `interference: ${i.pairs} pairs, ${i.clashes.length} clash(es), ${i.unmeasured.length} unmeasured` : existsSync(join(c.path, "chassis.stl")) ? "built" : absent, file: existsSync(join(c.path, "chassis.stl")) ? join(c.path, "chassis.stl") : undefined })
		const urdf = existsSync(join(c.path, "ros", "src")) ? readdirSync(join(c.path, "ros", "src")).map((p) => join(c.path, "ros", "src", p, "urdf")).find((p) => existsSync(p)) : undefined
		if (urdf) artifacts.push({ what: "ROS package", revision: c.rev, verdict: "URDF and controllers written", file: urdf })
	}
	const d = latestRev(join(dir, "drive"))
	const drive = d ? json(join(d.path, "drive.json")) : null
	if (d && drive) artifacts.push({ what: "simulated drive", revision: d.rev, verdict: drive.result === "pass" ? "pass" : `${drive.result}: ${drive.reason ?? ""}`.trim(), file: join(d.path, "trajectory.json") })
	const ros = json(join(dir, "ros", "ros.json"))
	if (ros?.results) artifacts.push({ what: "ROS test", revision: ros.revision ?? null, verdict: ros.results.map((r: any) => `${r.backend}: ${r.pass ? "pass" : "fail"}`).join(", ") })
	return { board, status, violations, artifacts }
}

export function runSummary(dir: string, runId: string): RunSummary {
	const system = existsSync(join(dir, "system.json")) || existsSync(join(dir, "system-report.md"))
	const boards = system && existsSync(join(dir, "boards"))
		? readdirSync(join(dir, "boards")).sort().map((b) => boardSummary(join(dir, "boards", b), b))
		: [boardSummary(dir, "main")]
	const sysReport = system && existsSync(join(dir, "system-report.md")) ? readFileSync(join(dir, "system-report.md"), "utf8") : ""
	const status = system ? (/^Status: (.+)$/m.exec(sysReport)?.[1] ?? "running (no report yet)") : boards[0].status
	const files = [system ? join(dir, "system-report.md") : join(dir, "report.md"), ...boards.flatMap((b) => b.artifacts.map((a) => a.file).filter((f): f is string => Boolean(f)))].filter((f) => existsSync(f))
	const lines = [`${runId}: ${status}`]
	for (const b of boards) {
		if (system) lines.push(`${b.board}: ${b.status}`)
		for (const v of b.violations.slice(0, 5)) lines.push(`  ! ${v.length > 160 ? `${v.slice(0, 157)}...` : v}`)
		if (b.violations.length > 5) lines.push(`  ! ... ${b.violations.length - 5} more`)
		for (const a of b.artifacts) lines.push(`  ${a.what}${a.revision !== null ? ` (rev ${a.revision})` : ""}: ${a.verdict}`)
	}
	return { runId, kind: system ? "system" : "design", status, boards, files, text: lines.join("\n") }
}

// The run before this one of the same design: the newest sibling folder (by name, which starts with its time) whose
// brief.md, or system spec, is the same text. Null when there is none.
export function previousRun(dir: string): string | null {
	const parent = join(dir, "..")
	const keyOf = (d: string) => {
		for (const f of ["brief.md", "system.json", "system-spec.json"]) if (existsSync(join(d, f))) return readFileSync(join(d, f), "utf8")
		return null
	}
	const key = keyOf(dir)
	if (key === null) return null
	const name = dir.replace(/\/+$/, "").split("/").pop()!
	const older = readdirSync(parent).filter((n) => n < name && keyOf(join(parent, n)) === key).sort()
	return older.length ? join(parent, older[older.length - 1]) : null
}

// What changed from `prev` to `cur`, one line each: the status, the number of open violations, and every artifact
// verdict that differs (cadsmith's Δprev line; the user's rule: every report carries before → after).
export function summaryDelta(prev: RunSummary, cur: RunSummary): string[] {
	const out: string[] = []
	if (prev.status !== cur.status) out.push(`status: ${prev.status} → ${cur.status}`)
	const count = (s: RunSummary) => s.boards.reduce((t, b) => t + b.violations.length, 0)
	if (count(prev) !== count(cur)) out.push(`open violations: ${count(prev)} → ${count(cur)}`)
	for (const b of cur.boards) {
		const pb = prev.boards.find((x) => x.board === b.board)
		const tag = cur.boards.length > 1 ? `${b.board} ` : ""
		if (!pb) { out.push(`${tag}new board`); continue }
		for (const a of b.artifacts) {
			const pa = pb.artifacts.find((x) => x.what === a.what)
			if (!pa) out.push(`${tag}${a.what}: (none) → ${a.verdict}`)
			else if (pa.verdict !== a.verdict) out.push(`${tag}${a.what}: ${pa.verdict} → ${a.verdict}`)
		}
		for (const pa of pb.artifacts) if (!b.artifacts.some((x) => x.what === pa.what)) out.push(`${tag}${pa.what}: ${pa.verdict} → (none)`)
	}
	return out
}

// The exit code a script can act on: 0 settled, 2 unsettled, 1 anything else (failed, still running, no report).
export function summaryExitCode(s: RunSummary): number {
	if (/^settled\b/i.test(s.status)) return 0
	if (/^UNSETTLED\b/.test(s.status)) return 2
	return 1
}
