// Whether a design is finished enough to package for ordering (17 Nov 2026): `bringup package` refuses, by name, a
// design whose run didn't settle, whose board is older than its contract, that has open findings, or whose brief review
// failed, was skipped or never came, unless --force. Nothing gets ordered from an unfinished run. It reads the run's
// report.md beside the contract (out/<run>/contract.json, or out/<run>/contracts/rev-N.json) and today's checks; no
// builds.
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { checkConsistency } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"

// The run a contract belongs to: out/<run>/contract.json, or out/<run>/contracts/rev-N.json.
export const runDirOf = (contractPath: string) => (basename(dirname(contractPath)) === "contracts" ? dirname(dirname(contractPath)) : dirname(contractPath))

export function packageGate(contractPath: string, s: ContractSnapshot): string[] {
	const dir = runDirOf(contractPath)
	const reportPath = join(dir, "report.md")
	const out: string[] = []
	const today = checkConsistency(s, {})
	if (today.length) out.push(`${today.length} open finding${today.length === 1 ? "" : "s"} on today's checks: ${today.map((v) => `${v.kind}: ${v.message.split("\n")[0]}`).join("; ")}`)
	if (!existsSync(reportPath)) {
		out.push(`no run report beside ${contractPath} (${reportPath}): nothing says the run that made it settled; package a run's contract.json`)
		return out
	}
	const report = readFileSync(reportPath, "utf8")
	const status = /^Status: (.*?)(?: at contract revision (\d+))?$/m.exec(report)
	if (!status) out.push(`the report has no Status line (${reportPath})`)
	else {
		if (!status[1].startsWith("settled")) out.push(`the run ended ${status[1]}, not settled`)
		if (status[2] && Number(status[2]) !== s.revision) out.push(`this contract is revision ${s.revision}, but the report judged revision ${status[2]}: package the run's final contract.json`)
	}
	const stale = /^Board: built at revision .*$/m.exec(report)
	if (stale) out.push(`the board is stale: ${stale[0].replace(/^Board: /, "")}`)
	const violations = Number(/^Violations: (\d+)/m.exec(report)?.[1] ?? 0)
	if (violations > 0) {
		const after = report.slice(report.search(/^Violations: /m)).split("\n").slice(1, 1 + violations)
		out.push(`${violations} open violation${violations === 1 ? "" : "s"} in the report: ${after.map((l) => /^- ([a-z-]+):/.exec(l)?.[1] ?? l.slice(0, 40)).join(", ")}`)
	}
	const held = /^Held by \(besides the violations\): (\d+)/m.exec(report)
	if (held) out.push(`held by ${held[1]} more (report "Held by")`)
	if (/^Brief review: skipped/m.test(report)) out.push("the brief review was skipped (--no-review): no reviewer checked the design against its brief")
	else if (/^No verdict:/m.test(report)) out.push(`no review verdict: ${/^No verdict: (.*)$/m.exec(report)![1]}`)
	else {
		const verdict = /^Verdict: (\w+)(.*)$/m.exec(report)
		if (!verdict) out.push("the report has no brief review verdict")
		else if (verdict[1] !== "pass") out.push(`the brief review's verdict is ${verdict[1]}`)
		// A mock design's scripted pass doesn't hold the package: it packages with a banner saying so (scriptedReview).
	}
	return out
}

// A design from a free mock run: its brief review passed, but by the scripted reviewer, not a model. Its package opens
// with a banner saying so instead of being refused (27 Nov 2026: mocks are the default, so a newcomer's first "package
// it" was always a refusal).
export function scriptedReview(contractPath: string): boolean {
	const reportPath = join(runDirOf(contractPath), "report.md")
	if (!existsSync(reportPath)) return false
	const verdict = /^Verdict: (\w+)(.*)$/m.exec(readFileSync(reportPath, "utf8"))
	return verdict?.[1] === "pass" && /scripted reviewer/.test(verdict[2])
}
