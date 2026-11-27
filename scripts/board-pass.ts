// The measured pass for a board change (lead-2, 27 Nov 2026: "make that pass one command … so every future board change
// is measured the same way"). Four cases, one at a time (each wants the machine to itself):
//   cnc        the CNC controller at 81×66 mm (test/fixtures/cnc-81x66.json), a contract build
//   arm        the arm controller, 4 layers (test/fixtures/arm-mock-rev14.json), a contract build
//   rover      a mock rover run (briefs/rover.md --mock), Freerouting on
//   rover-nofr the same without Freerouting (BRINGUP_FREEROUTING=off, BRINGUP_TOOLCHAIN=local): the free tier's and CI's path
//   repeat49   the free-tier rover's 49×29 contract (test/fixtures/rover-nofr-49x29-rev13.json) built 3 times without
//              Freerouting: does tscircuit give the same answer each time? (lead-2, 27 Nov 2026: the same contract built
//              in three saved runs and failed in three)
// For each: the verdict, the time, the board builds (failed), DRC errors / unconnected, the warnings by type and the
// silkscreen count. Saved as JSON; with --before <file> the table is before → after.
//
//   npm run board-pass -- [--only cnc,arm] [--before out/board-pass/<earlier>.json] [--force]
//                         [--save <file>] [--fail-on-regression]   (CI: .github/workflows/board-pass.yml)
//
// It refuses to start while another board build runs on this machine (a tsci build or a Freerouting container): two
// builds at once slow each other and the times mean nothing. --force starts anyway.
import { execFileSync, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"
import { connectorsOntoEdges } from "../src/contract/consistency.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { buildBoard } from "../src/tools/board.ts"
import { detectEnvironment } from "../src/tools/env.ts"

export interface PassResult {
	case: string
	verdict: string
	seconds: number
	builds: number
	failed: number
	errors: number | null
	unconnected: number | null
	byType: Record<string, number>
	silk: number
}

const ROOT = resolve(import.meta.dirname, "..")
const CASES = ["cnc", "arm", "rover", "rover-nofr", "repeat49"] as const
const CONTRACTS: Record<string, string> = { cnc: "test/fixtures/cnc-81x66.json", arm: "test/fixtures/arm-mock-rev14.json", repeat49: "test/fixtures/rover-nofr-49x29-rev13.json" }
const REPEATS = 3

export const silkOf = (byType: Record<string, number>) => Object.entries(byType).filter(([k]) => k.startsWith("silk")).reduce((t, [, n]) => t + n, 0)

// A contract's board, built as scripts/board.ts does.
async function contractCase(name: string): Promise<PassResult> {
	const s = JSON.parse(readFileSync(join(ROOT, CONTRACTS[name]), "utf8")) as ContractSnapshot
	// Connectors packed onto the edges as a run does before its build (scripts/board.ts the same).
	const packed = connectorsOntoEdges(s)
	if (packed) s.values.connectors = packed
	const env = await detectEnvironment(ROOT)
	const dir = mkdtempSync(join(tmpdir(), "bringup-board-pass-"))
	const t0 = Date.now()
	try {
		const b = await buildBoard(env, dir, s, s.revision ?? 1)
		const byType = b.drc?.byType ?? {}
		const clean = b.drc && b.drc.errors === 0 && b.drc.unconnected === 0
		return { case: name, verdict: clean ? `ROUTED${b.routedBy ? ` (${b.routedBy})` : ""}${b.layers === 4 ? " 4L" : ""}` : "DRC errors", seconds: Math.round((Date.now() - t0) / 1000), builds: b.layoutsTried ?? 1, failed: 0, errors: b.drc?.errors ?? null, unconnected: b.drc?.unconnected ?? null, byType, silk: silkOf(byType) }
	} catch (e) {
		return { case: name, verdict: `FAILED: ${String(e).split("\n")[0].slice(0, 80)}`, seconds: Math.round((Date.now() - t0) / 1000), builds: 0, failed: 1, errors: null, unconnected: null, byType: {}, silk: 0 }
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// A finished mock run's numbers: the verdict from its report, the board builds from its trace (artifact.ready /
// artifact.failed of kind board, each with its ms), the last built board's DRC.
export function runResult(name: string, out: string, wallSeconds: number): PassResult {
	const report = existsSync(join(out, "report.md")) ? readFileSync(join(out, "report.md"), "utf8") : ""
	const status = /^Status: (.*)$/m.exec(report)?.[1] ?? "no report"
	const violations = /^Violations: (\d+)/m.exec(report)?.[1]
	const events = existsSync(join(out, "trace.jsonl")) ? readFileSync(join(out, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
	const boards = events.filter((e) => (e.type === "artifact.ready" || e.type === "artifact.failed") && e.payload?.kind === "board")
	const last = [...boards].reverse().find((e) => e.type === "artifact.ready" && e.payload.drc)
	const byType: Record<string, number> = last?.payload.drc.byType ?? {}
	const settled = /^settled at contract revision (\d+)/.exec(status)
	return {
		case: name,
		verdict: settled ? `settled r${settled[1]}${violations && violations !== "0" ? `, ${violations} violations` : ""}` : status.slice(0, 60),
		seconds: Math.round(boards.reduce((t, e) => t + (e.payload.ms ?? 0), 0) / 1000) || wallSeconds,
		builds: boards.length,
		failed: boards.filter((e) => e.type === "artifact.failed").length,
		errors: last?.payload.drc.errors ?? null,
		unconnected: last?.payload.drc.unconnected ?? null,
		byType,
		silk: silkOf(byType),
	}
}

function roverCase(name: string, out: string): PassResult {
	const env = { ...process.env, ...(name === "rover-nofr" ? { BRINGUP_FREEROUTING: "off", BRINGUP_TOOLCHAIN: "local" } : {}) }
	const t0 = Date.now()
	const r = spawnSync("npx", ["tsx", "src/main.ts", "briefs/rover.md", "--mock", "--no-cloud", "--out", out], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 1 << 28 })
	writeFileSync(`${out}.log`, `${r.stdout ?? ""}${r.stderr ?? ""}`)
	return runResult(name, out, Math.round((Date.now() - t0) / 1000))
}

export function busy(): string[] {
	const procs = spawnSync("pgrep", ["-af", "tsci build|freerouting"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l && !/pgrep|board-pass/.test(l))
	let containers: string[] = []
	try {
		containers = execFileSync("docker", ["ps", "--filter", "label=bringup.pid", "--format", "{{.Names}}"], { encoding: "utf8" }).split("\n").filter(Boolean)
	} catch {}
	return [...procs, ...containers]
}

const fmtTypes = (t: Record<string, number>) => Object.entries(t).sort().map(([k, n]) => `${k} ${n}`).join(", ") || "-"
const row = (r: PassResult | undefined) => (r ? `${r.verdict} · ${r.seconds} s · ${r.builds} builds${r.failed ? ` (${r.failed} failed)` : ""} · DRC ${r.errors ?? "?"}/${r.unconnected ?? "?"} · silk ${r.silk}` : "-")

// The table, before → after per case, then the warnings by type.
export function table(after: PassResult[], before: PassResult[] = []): string {
	const lines = ["| Case | Before | After |", "|---|---|---|"]
	for (const a of after) lines.push(`| ${a.case} | ${row(before.find((b) => b.case === a.case))} | ${row(a)} |`)
	lines.push("", "DRC by type (after; before in brackets):")
	for (const a of after) lines.push(`  ${a.case}: ${fmtTypes(a.byType)}${before.find((b) => b.case === a.case) ? ` [${fmtTypes(before.find((b) => b.case === a.case)!.byType)}]` : ""}`)
	return lines.join("\n")
}

// What got worse since before: a case that settled or routed and no longer does, DRC errors or unconnected more than
// before. A case missing from before is new, not a regression. A board time over SLOWER × before's is a warning only
// (slowdowns): shared CI runners vary, and lead-2 (27 Nov 2026): "a red badge nobody trusts is worse than none".
export const SLOWER = 1.25
const ok = (r: PassResult) => /^(settled|ROUTED)/.test(r.verdict)
export function regressions(after: PassResult[], before: PassResult[]): string[] {
	const out: string[] = []
	for (const a of after) {
		const b = before.find((x) => x.case === a.case)
		if (!b) continue
		if (ok(b) && !ok(a)) out.push(`${a.case}: ${b.verdict} → ${a.verdict}`)
		if ((a.errors ?? 0) > (b.errors ?? 0)) out.push(`${a.case}: DRC errors ${b.errors ?? 0} → ${a.errors}`)
		if ((a.unconnected ?? 0) > (b.unconnected ?? 0)) out.push(`${a.case}: unconnected ${b.unconnected ?? 0} → ${a.unconnected}`)
	}
	return out
}
export function slowdowns(after: PassResult[], before: PassResult[]): string[] {
	return after.flatMap((a) => {
		const b = before.find((x) => x.case === a.case)
		return b && b.seconds > 0 && a.seconds > SLOWER * b.seconds ? [`${a.case}: ${b.seconds} s → ${a.seconds} s (over ${Math.round((SLOWER - 1) * 100)} % slower)`] : []
	})
}

// The same contract built REPEATS times without Freerouting: the verdict counts the builds that routed clean.
async function repeatCase(name: string): Promise<PassResult> {
	const was = process.env.BRINGUP_FREEROUTING
	process.env.BRINGUP_FREEROUTING = "off"
	try {
		const runs: PassResult[] = []
		for (let i = 0; i < REPEATS; i++) {
			const r = await contractCase(name)
			console.log(`  try ${i + 1}: ${row(r)}`)
			runs.push(r)
		}
		return repeatResult(name, runs)
	} finally {
		if (was === undefined) delete process.env.BRINGUP_FREEROUTING
		else process.env.BRINGUP_FREEROUTING = was
	}
}
export function repeatResult(name: string, runs: PassResult[]): PassResult {
	const clean = runs.filter((r) => r.verdict.startsWith("ROUTED") && r.errors === 0 && r.unconnected === 0)
	const last = runs[runs.length - 1]
	return { case: name, verdict: `${clean.length === runs.length ? "ROUTED" : clean.length ? "VARIES" : "FAILED"} ${clean.length}/${runs.length}`, seconds: runs.reduce((t, r) => t + r.seconds, 0), builds: runs.reduce((t, r) => t + r.builds, 0), failed: runs.length - clean.length, errors: last.errors, unconnected: last.unconnected, byType: last.byType, silk: last.silk }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2)
	const val = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
	const only = val("--only")?.split(",") ?? [...CASES]
	const unknown = only.filter((c) => !(CASES as readonly string[]).includes(c))
	if (unknown.length) throw new Error(`unknown case(s): ${unknown.join(", ")} (cases: ${CASES.join(", ")})`)
	const others = busy()
	if (others.length && !args.includes("--force")) {
		console.error(`another board build is running; its time and ours would both be wrong (--force to start anyway):\n  ${others.join("\n  ")}`)
		process.exit(3)
	}
	const before: PassResult[] = val("--before") ? JSON.parse(readFileSync(resolve(val("--before")!), "utf8")).results : []
	const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim()
	const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")
	const dir = join(ROOT, "out", "board-pass")
	mkdirSync(dir, { recursive: true })
	const results: PassResult[] = []
	for (const c of CASES.filter((x) => only.includes(x))) {
		console.log(`${c}…`)
		const r = c === "repeat49" ? await repeatCase(c) : c in CONTRACTS ? await contractCase(c) : roverCase(c, join(dir, `${stamp}-${head}-${c}`))
		console.log(`  ${row(r)}`)
		results.push(r)
	}
	// --save <file>: a fixed name as well (CI uploads it as the next run's before).
	const file = join(dir, `${stamp}-${head}.json`)
	const json = JSON.stringify({ commit: head, at: new Date().toISOString(), results }, null, "\t") + "\n"
	writeFileSync(file, json)
	if (val("--save")) writeFileSync(resolve(val("--save")!), json)
	const worse = regressions(results, before)
	const slow = slowdowns(results, before)
	const text = `${table(results, before)}\n\n${before.length ? `${worse.length ? `Regressions:\n${worse.map((w) => `- ${w}`).join("\n")}` : "No regressions."}${slow.length ? `\n\nWarning, slower (not a failure: runner times vary):\n${slow.map((w) => `- ${w}`).join("\n")}` : ""}` : "No before to compare with: this result is the baseline."}`
	console.log(`\n${text}\n\nsaved: ${file}${readdirSync(dir).length > 40 ? " (out/board-pass holds over 40 entries: old ones may go)" : ""}`)
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Board pass (${head})\n\n${text}\n`)
	if (args.includes("--fail-on-regression") && worse.length) process.exitCode = 1
}
