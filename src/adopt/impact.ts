// The check's result as change impact: for each design change in a pull request, which other domains have to follow
// and exactly where. Pure: it reads the check results (contract.ts) and the adopt report (cli.ts), nothing else.
import { BUILD_INPUTS } from "../agents/builders.ts"
import type { Violation } from "../contract/consistency.ts"
import type { Connector, FieldName } from "../contract/types.ts"
import type { CheckResult, FieldChange } from "./contract.ts"
import { pinLabel } from "./pins.ts"

export type Domain = "board" | "case" | "firmware" | "bom"

// The fields each domain reads: Bringup's own builders rebuild on exactly these (BUILD_INPUTS), and the BOM agent
// wakes on parts changes only (src/agents/bom.ts). A domain that doesn't read a field is unaffected by its change.
export const READERS: Record<Domain, readonly FieldName[]> = {
	board: BUILD_INPUTS.board,
	case: BUILD_INPUTS.enclosure,
	firmware: BUILD_INPUTS.firmware,
	bom: ["parts"],
}

const LABEL: Record<Domain, string> = { board: "Board", case: "Case", firmware: "Firmware", bom: "BOM" }

// changed: the change is in this domain. update: it has to follow, at the place named. ok: checked, nothing to do.
// unaffected: it doesn't read the field. not checked: it reads the field, but adopt can't see whether it follows.
export type Status = "changed" | "update" | "ok" | "unaffected" | "not checked"

export interface DomainImpact {
	domain: Domain
	status: Status
	// Plain words; file names in backticks (dropped in the plain-text version).
	says: string
}

export interface ChangeImpact {
	board: string
	headline: string
	domains: DomainImpact[]
}

// The parts of the adopt report impact reads: each board's case parts and how the board fits them.
export interface CaseReport {
	boards: { file: string; case: { file: string; fits: boolean; marginMm: number }[] }[]
}

const KIND: Record<Connector["kind"], string> = { "usb-c": "USB-C", button: "button", header: "header" }
// Where a connector's offset is measured from (contract.ts connectors()): x along top and bottom, y up the sides.
const END: Record<Connector["edge"], string> = { bottom: "left", top: "left", left: "bottom", right: "bottom" }
const mm = (n: number) => `${+n.toFixed(2)} mm`

export function impactOf(results: CheckResult[] | null, report: CaseReport): ChangeImpact[] {
	const out: ChangeImpact[] = []
	for (const r of results ?? []) {
		if (r.missing) {
			out.push({ board: r.board, headline: r.missing, domains: (["case", "firmware", "bom"] as const).map((domain) => ({ domain, status: "not checked", says: "the board is gone, so there is nothing to compare" })) })
			continue
		}
		const cases = report.boards.find((b) => b.file === r.board)?.case ?? []
		const explained = new Set<string>()
		for (const c of r.changes) {
			// The firmware left on an old pin is said under the pin's own move, from the firmware's pins.
			if (c.stale || !c.detail) continue
			const item = changeImpact(r, c, cases)
			if (!item) continue
			out.push(item)
			const d = c.detail
			explained.add(d.field === "pins" ? d.signal : d.field === "outline" ? "outline" : d.ref)
		}
		for (const v of r.violations) {
			const subject = subjectOf(v)
			if (explained.has(subject)) continue
			explained.add(subject)
			out.push(violationImpact(r, v, subject))
		}
	}
	return out
}

// The domains that don't read a field, said once.
function unaffected(field: FieldName, except: Domain[]): DomainImpact[] {
	return (Object.keys(READERS) as Domain[]).filter((d) => !except.includes(d) && !READERS[d].includes(field)).map((domain) => ({ domain, status: "unaffected", says: `doesn't read ${field}` }))
}

// The case part the board is checked against: the best fit, as the adopt report says it.
function caseFit(cases: CaseReport["boards"][number]["case"]): { file: string; fits: boolean; says: string } | null {
	const best = [...cases].sort((x, y) => y.marginMm - x.marginMm)[0]
	if (!best) return null
	return {
		file: best.file,
		fits: best.fits,
		says: best.fits ? `the board still fits, ${mm(best.marginMm)} margin` : cases.length > 1 ? `the board fits none of the ${cases.length} case parts; this, the closest, is short by ${mm(-best.marginMm)}` : `the board no longer fits it: short by ${mm(-best.marginMm)}`,
	}
}

const NO_CASE: DomainImpact = { domain: "case", status: "not checked", says: "no case STL found in the repo" }

function changeImpact(r: CheckResult, c: FieldChange, cases: CaseReport["boards"][number]["case"]): ChangeImpact | null {
	const d = c.detail!
	const board: DomainImpact = { domain: "board", status: "changed", says: "" }
	const fit = caseFit(cases)
	if (d.field === "pins") {
		const pin = d.to ?? d.from!
		const headline = !d.to ? `${d.signal} is gone from the board (was ${pinLabel(d.from!.gpio)})` : !d.from ? `${d.signal} is new on ${pinLabel(d.to.gpio)}` : d.from.gpio !== d.to.gpio ? `${d.signal} moved ${pinLabel(d.from.gpio)} → ${pinLabel(d.to.gpio)}` : `${d.signal} now goes to ${d.to.partRef}.${d.to.partPin} (was ${d.from.partRef}.${d.from.partPin})`
		return { board: r.board, headline, domains: [board, firmwareFollows(r, d.signal, d.from?.gpio ?? null, d.to?.gpio ?? null, d.to && d.from && d.to.partRef !== d.from.partRef ? d.to.partRef : null, pin.gpio), ...unaffected("pins", ["board", "firmware"])] }
	}
	if (d.field === "connectors") {
		const k = d.to ?? d.from!
		const name = `${d.ref} (${KIND[k.kind]})`
		const headline = !d.to ? `${name} is gone from the ${d.from!.edge} edge` : !d.from ? `${name} is new on the ${d.to.edge} edge at ${mm(d.to.offsetMm)}` : d.from.edge === d.to.edge ? `${name} moved ${mm(Math.abs(d.to.offsetMm - d.from.offsetMm))} along the ${d.to.edge} edge (${d.from.offsetMm} → ${d.to.offsetMm} mm from its ${END[d.to.edge]} end)` : `${name} moved from the ${d.from.edge} edge (${mm(d.from.offsetMm)}) to the ${d.to.edge} edge (${mm(d.to.offsetMm)})`
		// adopt reads an STL's outer size only, so the cutout itself is a job to do, never a confirmed fact.
		const job = !d.to ? `no longer needs a cutout for ${d.ref}` : !d.from ? `needs a cutout for ${d.ref} on the ${d.to.edge} edge at ${mm(d.to.offsetMm)}` : `needs its ${d.ref} cutout moved to the ${d.to.edge} edge at ${mm(d.to.offsetMm)}`
		const caseImpact: DomainImpact = fit ? { domain: "case", status: "update", says: `\`${fit.file}\` ${job} (${fit.says}; adopt reads the case's size, not its cutouts)` } : NO_CASE
		return { board: r.board, headline, domains: [board, caseImpact, ...unaffected("connectors", ["board", "case"])] }
	}
	if (d.field === "outline") {
		const thick = d.from.thicknessMm !== d.to.thicknessMm ? ` × ${d.to.thicknessMm}` : ""
		const headline = `the board is now ${d.to.widthMm} × ${d.to.heightMm}${thick} mm (was ${d.from.widthMm} × ${d.from.heightMm}${thick ? ` × ${d.from.thicknessMm}` : ""} mm)`
		const caseImpact: DomainImpact = fit ? { domain: "case", status: fit.fits ? "ok" : "update", says: `\`${fit.file}\`: ${fit.says}` } : NO_CASE
		return { board: r.board, headline, domains: [board, caseImpact, ...unaffected("outline", ["board", "case"])] }
	}
	if (d.field === "parts") {
		return {
			board: r.board,
			headline: `${d.ref} is now ${d.to.mpn} (was ${d.from.mpn})`,
			domains: [
				board,
				{ domain: "bom", status: "update", says: `update ${d.ref}'s line: ${d.from.mpn} → ${d.to.mpn}${d.from.footprint !== d.to.footprint ? `, footprint ${d.to.footprint}` : ""}` },
				// Bringup's firmware picks its sensor driver by part, and its case puts a vent over the sensor: adopt reads neither.
				{ domain: "firmware", status: "not checked", says: `adopt doesn't read drivers; check that the code for ${d.ref} suits ${d.to.mpn}` },
				fit ? { domain: "case", status: "not checked", says: `adopt reads \`${fit.file}\`'s size, not its vents or openings over ${d.ref}` } : NO_CASE,
			],
		}
	}
	return null
}

// Whether the firmware followed a pin: the GPIO its linked name drives now against where the board put the signal.
function firmwareFollows(r: CheckResult, signal: string, from: number | null, to: number | null, newPart: string | null, gpio: number): DomainImpact {
	const f = r.firmware?.[signal]
	if (!r.variant) return { domain: "firmware", status: "not checked", says: "no firmware build was paired with this board" }
	if (!f) return { domain: "firmware", status: "not checked", says: `no firmware name is linked to ${signal}${from === null ? " yet (re-agree the contract to link one)" : ""}` }
	const at = `\`${f.file}:${f.line}\``
	if (to === null) return f.gpio === null ? { domain: "firmware", status: "ok", says: `${f.name} is gone from the build too` } : { domain: "firmware", status: "update", says: `${at} still drives ${pinLabel(f.gpio)} (${f.name}): remove it or give it a new pin` }
	if (f.gpio === null) return { domain: "firmware", status: "update", says: `${f.name} is gone from the build (last at ${at}): give ${signal} a name on ${pinLabel(to)} again` }
	if (f.gpio === to) {
		if (newPart) return { domain: "firmware", status: "not checked", says: `${f.name} (${at}) still drives ${pinLabel(gpio)}; adopt can't tell whether its code suits ${newPart}` }
		return { domain: "firmware", status: "ok", says: `follows, ${f.name} drives ${pinLabel(to)} (${at})` }
	}
	return { domain: "firmware", status: "update", says: `${at} ${f.gpio === from ? "still drives" : "drives"} ${pinLabel(f.gpio)} (${f.name}): update it to ${pinLabel(to)}` }
}

// The signal or part a violation is about (the messages are consistency.ts's own), else its kind.
function subjectOf(v: Violation): string {
	if (v.kind === "outline-mismatch") return "outline"
	return /^net (\S+) does not/.exec(v.message)?.[1] ?? /firmware drives (\S+) on/.exec(v.message)?.[1] ?? v.kind
}

// A violation no board change explains: the firmware moved a pin on its own, or something the diff can't name.
function violationImpact(r: CheckResult, v: Violation, subject: string): ChangeImpact {
	const f = r.firmware?.[subject]
	if (v.kind === "pin-mismatch" && f) {
		const was = /contract says (\S+)/.exec(v.message)?.[1] ?? "the agreed pin"
		const now = f.gpio === null ? "no pin" : pinLabel(f.gpio)
		return {
			board: r.board,
			headline: `the firmware moved ${subject}: ${f.name} drives ${now} (\`${f.file}:${f.line}\`), the board still has ${was}`,
			domains: [
				{ domain: "firmware", status: "changed", says: "" },
				{ domain: "board", status: "update", says: `move ${subject} to ${now} on the board, or put the firmware back on ${was}` },
				...unaffected("pins", ["board", "firmware"]),
			],
		}
	}
	// What reads the violated fields, other than the board it was found on: adopt checked nothing further.
	const readers = (["case", "firmware", "bom"] as const).filter((d) => v.fields.some((x) => READERS[d].includes(x)))
	return {
		board: r.board,
		headline: v.message,
		domains: [{ domain: "board", status: "changed", says: "" }, ...readers.map((domain) => ({ domain, status: "not checked" as const, says: `reads ${v.fields.join(", ")}` })), ...(["case", "firmware", "bom"] as const).filter((d) => !readers.includes(d)).map((domain) => ({ domain, status: "unaffected" as const, says: `doesn't read ${v.fields.join(", ")}` }))],
	}
}

const ORDER: Status[] = ["update", "ok", "not checked", "unaffected"]

// One change's consequences in one sentence per domain; unaffected domains share one, the domain that changed is the headline.
function consequences(item: ChangeImpact): string[] {
	const out: string[] = []
	const rest = item.domains.filter((d) => d.status !== "changed").sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
	for (const d of rest.filter((x) => x.status !== "unaffected")) out.push(`${LABEL[d.domain]}: ${d.status === "not checked" ? `not checked (${d.says})` : d.says}`)
	const un = rest.filter((x) => x.status === "unaffected")
	if (un.length) out.push(`${un.map((d) => LABEL[d.domain]).join(", ")}: unaffected (${un.length > 1 ? `they ${un[0].says.replace(/^doesn't/, "don't")}` : `it ${un[0].says}`})`)
	return out
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const MAX_ITEMS = 4

// The block at the top of the job summary and the pull-request comment: 3 to 6 lines, the details stay below it.
export function impactMarkdown(results: CheckResult[] | null, report: CaseReport, contractDir: string): string {
	if (!results) return `**Change impact:** not known yet: there is no agreed contract in \`${contractDir}\` to compare with.\n`
	const items = impactOf(results, report)
	if (!items.length) return `**Change impact: none.** Every board matches the agreed contract (\`${contractDir}\`), so board, case, firmware and BOM have nothing to follow.\n`
	const several = new Set(items.map((x) => x.board)).size > 1 || results.length > 1
	const out = [`**Change impact** (against \`${contractDir}\`):`]
	for (const x of items.slice(0, MAX_ITEMS)) out.push(`- **${cap(x.headline)}**${several ? ` (\`${x.board}\`)` : ""}. ${consequences(x).join(". ")}.`)
	if (items.length > MAX_ITEMS) out.push(`- …and ${items.length - MAX_ITEMS} more, in the details below.`)
	return `${out.join("\n")}\n`
}

// The same for a terminal: every change, one domain per line, no markdown.
export function impactText(results: CheckResult[] | null, report: CaseReport): string {
	if (!results) return ""
	const items = impactOf(results, report)
	if (!items.length) return "Change impact: none (every board matches the agreed contract)"
	const out = ["Change impact:"]
	for (const x of items) {
		out.push(`  ${cap(x.headline).replace(/`/g, "")}${results.length > 1 ? `  (${x.board})` : ""}`)
		for (const line of consequences(x)) out.push(`    ${line.replace(/`/g, "")}`)
	}
	return out.join("\n")
}
