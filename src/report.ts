import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { checkConsistency, type EnclosureArtifact } from "./contract/consistency.ts"
import { batteryLifeSummary, estimatePower } from "./contract/power.ts"
import type { BringupState } from "./runtime.ts"
import { describeEnv, type Env } from "./tools/env.ts"
import { isStub } from "./tools/stubs.ts"
import type { Payloads } from "./events.ts"
import { bringupSection } from "./bench/report.ts"

function counts(tracePath: string): Record<string, number> {
	const c: Record<string, number> = {}
	if (!existsSync(tracePath)) return c
	for (const line of readFileSync(tracePath, "utf8").trim().split("\n")) {
		if (!line) continue
		const { type, payload } = JSON.parse(line) as { type: string; payload: { approved?: boolean; violations?: unknown[] } }
		c[type] = (c[type] ?? 0) + 1
		if (type === "change.resolved") c[payload.approved ? "approved" : "rejected"] = (c[payload.approved ? "approved" : "rejected"] ?? 0) + 1
		if (type === "consistency.checked") c.violationsSeen = (c.violationsSeen ?? 0) + (payload.violations?.length ?? 0)
	}
	return c
}

const INSTALL = {
	tsci: { tool: "tscircuit", install: "npm i --prefix tools/node tscircuit bun" },
	kicad: { tool: "KiCad 10", install: "docker pull kicad/kicad:10.0" },
	python: { tool: "python with build123d", install: "uv venv .venv && uv pip install platformio build123d" },
	pio: { tool: "PlatformIO", install: "uv venv .venv && uv pip install platformio build123d" },
} as const

// The hardware tools this machine lacks, in the order the README installs them.
export function missingTools(env: Env): { tool: string; install: string }[] {
	return (Object.keys(INSTALL) as (keyof typeof INSTALL)[]).filter((k) => !env[k]).map((k) => INSTALL[k])
}

function reviewSection(s: BringupState): string[] {
	const r = s.review
	if (!r.enabled) return ["Brief review: skipped (--no-review).", ""]
	const last = r.results.at(-1)
	const n = r.results.length
	const head = last
		? `Verdict: ${last.verdict} after ${n} review${n === 1 ? "" : "s"} (at most ${r.maxRounds} fix round${r.maxRounds === 1 ? "" : "s"}).`
		: r.missingVerdict
			? "No verdict: the reviewer ended its turn without submitting a review, so the design settled on the deterministic checks alone."
			: "No verdict: the design never reached the reviewer (it did not become consistent and quiet)."
	const rounds = r.results.map((x) => [
		`- Review ${x.round} of revision ${x.revision}: ${x.verdict}`,
		...x.findings.map((f) => `  - ${f.severity} (${f.fields.join(", ") || "general"}): ${f.issue} Suggestion: ${f.suggestion}`),
	])
	return ["## Brief review", "", head, ...rounds.flat(), ""]
}

// The last firmware.booted event in the trace, as one report line.
function bootLine(tracePath: string, env: Env, noHardware: boolean): string {
	const label = "- Firmware boot (QEMU):"
	if (noHardware) return `${label} not run (--no-hardware)`
	if (!env.qemu) return `${label} not run (QEMU not installed; see NOTES.md)`
	const boots = existsSync(tracePath)
		? readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload: Payloads["firmware.booted"] }).filter((e) => e.type === "firmware.booted")
		: []
	const last = boots.at(-1)?.payload
	if (!last) return `${label} not run (no firmware compiled)`
	if (last.booted) return `${label} booted, printed revision ${last.bootRevision}`
	return `${label} did NOT boot (firmware rev ${last.revision}): ${last.serialTail.trim().split("\n").at(-1) ?? ""}`
}

// The files to slice and whether py/enclosure.py's print check passed them.
function printLines(e: EnclosureArtifact | undefined, stubbed: boolean): string[] {
	if (!e) return []
	if (stubbed || isStub(e) || !e.lidStlPath) return [`- Print files: none (--no-hardware: the enclosure was not built)`]
	const lines = [`- Print files: ${e.stlPath}, ${e.lidStlPath}`]
	const check = e.printCheck
	if (!check) return lines
	if (check.ok) {
		lines.push(`- Print check: ok (case open side up, lid plate down; ${e.standoffs?.length ?? 0} M2 standoffs for self-tapping screws)`)
	} else {
		lines.push(`- Print check: ${check.issues.length} issue(s)`, ...check.issues.map((i) => `  - ${i}`))
	}
	return lines
}

// The parts list's order-readiness summary (agents/bom.ts). "needs attention" only for out-of-stock or unlisted lines.
function sourcingLine(bomPath: string): string {
	if (!existsSync(bomPath)) return "- Sourcing: no bom.json (no parts yet)"
	const r = (JSON.parse(readFileSync(bomPath, "utf8")) as { readiness?: { summary: string; warn: boolean } }).readiness
	return r ? `- Sourcing: ${r.warn ? "needs attention: " : ""}${r.summary}` : "- Sourcing: bom.json has no readiness summary"
}

function fabSection(s: BringupState, stubbed: boolean): string[] {
	const b = s.artifacts.board
	const body = stubbed
		? ["Fab export: skipped (--no-hardware: there is no real board to fabricate)."]
		: b?.fabDir && existsSync(b.fabDir)
			? [
					`JLCPCB assembly package (PCBWay takes the same files) in ${b.fabDir}:`,
					...readdirSync(b.fabDir).sort().map((f) => `- ${f} (${statSync(join(b.fabDir!, f)).size} bytes)`),
					"",
					"Work through the checklist in README.txt before ordering.",
				]
			: b?.fabError
				? [`Fab export failed: ${b.fabError.split("\n")[0]}`]
				: ["Fab export: no board was built."]
	return ["## Fabrication", "", ...body, ""]
}

export function writeReport(outDir: string, s: BringupState, env: Env, settled: boolean, opts: { noHardware?: boolean; bench?: boolean } = {}): string {
	const snapshot = s.contract.snapshot()
	const violations = checkConsistency(snapshot, s.artifacts)
	const c = counts(join(outDir, "trace.jsonl"))
	const v = snapshot.values
	// With --no-hardware the tools are never used, so their absence is not news.
	const missing = opts.noHardware ? [] : missingTools(env)
	const status = settled ? "settled" : missing.length > 0 ? `UNSETTLED — missing tools: ${missing.map((m) => m.tool).join(", ")}` : "UNSETTLED"
	const stubbed = opts.noHardware || [s.artifacts.board, s.artifacts.enclosure, s.artifacts.firmware].some(isStub)
	const lines = [
		`# Bringup report`,
		``,
		`Status: ${status} at contract revision ${snapshot.revision}`,
		`Violations: ${violations.length}`,
		...violations.map((x) => `- ${x.kind}: ${x.message}`),
		``,
		...(missing.length > 0
			? [
					`## Missing tools`,
					``,
					`These builds could not run, so the design cannot settle on this machine. Install them (README, "Install"), or rerun with --no-hardware to stub the hardware:`,
					``,
					...missing.map((m) => `- ${m.tool}: \`${m.install}\``),
					``,
				]
			: []),
		...(stubbed ? [`Hardware stubbed (--no-hardware): board, enclosure and firmware were derived from the contract, not built.`, ``] : []),
		`## Design`,
		`- ${v.requirements?.summary ?? "?"}`,
		`- Board ${v.outline?.widthMm}×${v.outline?.heightMm} mm; connectors: ${(v.connectors ?? []).map((x) => `${x.ref} ${x.kind} on ${x.edge}`).join(", ") || "none"}`,
		`- Parts: ${(v.parts ?? []).map((p) => `${p.ref} ${p.mpn}${p.lcsc ? ` (${p.lcsc})` : ""}`).join(", ")}`,
		`- Pins: ${(v.pins ?? []).map((p) => `${p.signal}=GPIO${p.gpio}→${p.partRef}.${p.partPin}`).join(", ")}`,
		`- Rails (peak/rated): ${(v.rails ?? []).map((r) => `${r.name} ${r.loadMa}/${r.regulatorMaxMa} mA${r.averageMa !== undefined ? `, average ${r.averageMa} mA` : ""}`).join("; ")}`,
		`- Estimated battery life: ${batteryLifeSummary(estimatePower(snapshot, existsSync(join(outDir, "brief.md")) ? readFileSync(join(outDir, "brief.md"), "utf8") : ""))}`,
		``,
		...reviewSection(s),
		`## Artifacts`,
		`- Board: ${s.artifacts.board?.pcbPath ?? "not built"}${s.artifacts.board?.renderPath ? ` (render ${s.artifacts.board.renderPath})` : ""}`,
		...drcLines(s.artifacts.board?.drc),
		`- Enclosure: ${s.artifacts.enclosure?.stlPath ?? "not built"}`,
		...printLines(s.artifacts.enclosure, stubbed),
		`- Firmware: ${!s.artifacts.firmware ? "not built" : isStub(s.artifacts.firmware) ? "stubbed (pins from the contract, not compiled)" : s.artifacts.firmware.ok ? "compiles" : "does NOT compile"}`,
		bootLine(join(outDir, "trace.jsonl"), env, stubbed),
		sourcingLine(join(outDir, "bom.json")),
		...Object.entries(s.artifactFailures).map(([k, e]) => `- ${k} failed: ${String(e).split("\n")[0]}`),
		``,
		...fabSection(s, stubbed),
		...(opts.bench ? bringupSection(join(outDir, "trace.jsonl")) : []),
		`## Coordination`,
		`- Contract changes: ${c["contract.changed"] ?? 0}`,
		`- Change requests held by interception: ${c["change.proposed"] ?? 0} (approved ${c.approved ?? 0}, rejected ${c.rejected ?? 0})`,
		`- Consistency checks: ${c["consistency.checked"] ?? 0}; violations caught along the way: ${c.violationsSeen ?? 0}`,
		`- Artifacts built: ${c["artifact.ready"] ?? 0}; failed builds: ${c["artifact.failed"] ?? 0}; agent crashes: ${c["agent.halted"] ?? 0}`,
		``,
		`## Environment`,
		"```",
		describeEnv(env),
		"```",
		``,
	]
	const path = join(outDir, "report.md")
	writeFileSync(path, lines.join("\n"))
	return path
}

function drcLines(drc: import("./tools/drc.ts").DrcSummary | null | undefined): string[] {
	if (drc === undefined) return []
	if (drc === null) return ["- Design rules (KiCad): not checked (KiCad could not run)"]
	const types = Object.entries(drc.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ")
	return [`- Design rules (KiCad, ${drc.rules}): ${drc.errors} errors, ${drc.warnings} warnings, ${drc.unconnected} unconnected${types ? ` (${types})` : ""}`]
}
export const drcReportLinesForTest = drcLines
