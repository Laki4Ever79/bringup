import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { checkConsistency } from "./contract/consistency.ts"
import { batteryLifeSummary, estimatePower } from "./contract/power.ts"
import type { BringupState } from "./runtime.ts"
import { describeEnv, type Env } from "./tools/env.ts"
import { isStub } from "./tools/stubs.ts"

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

export function writeReport(outDir: string, s: BringupState, env: Env, settled: boolean, opts: { noHardware?: boolean } = {}): string {
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
		`- Enclosure: ${s.artifacts.enclosure?.stlPath ?? "not built"}`,
		`- Firmware: ${!s.artifacts.firmware ? "not built" : isStub(s.artifacts.firmware) ? "stubbed (pins from the contract, not compiled)" : s.artifacts.firmware.ok ? "compiles" : "does NOT compile"}`,
		...Object.entries(s.artifactFailures).map(([k, e]) => `- ${k} failed: ${String(e).split("\n")[0]}`),
		``,
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
