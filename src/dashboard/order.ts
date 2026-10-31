import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { zipStore } from "../tools/fab.ts"

// "Ready to order": one zip with exactly what JLCPCB's PCBA upload asks for (gerbers.zip, bom.csv, cpl.csv), the
// case and lid STLs for JLC3DP, and a README with the steps. JLCPCB has no public order API, so nothing is uploaded
// and no order is placed: the page downloads this and opens JLCPCB's quote page. From the latest settled revision only.

export const JLCPCB_QUOTE = "https://cart.jlcpcb.com/quote"
export const JLC3DP = "https://jlc3dp.com"

// The board's inputs: a change to one of these after the fab package was written makes its gerbers stale.
// Same as BUILD_INPUTS["build:board"] in src/agents/builders.ts.
const BOARD_INPUTS = new Set(["parts", "pins", "outline", "connectors"])

export type OrderPackage = { ok: true; name: string; revision: number; zip: Buffer } | { ok: false; reason: string }

type Ev = { type: string; payload?: any }

function readTrace(dir: string): Ev[] {
	const text = existsSync(join(dir, "trace.jsonl")) ? readFileSync(join(dir, "trace.jsonl"), "utf8") : ""
	return text.split("\n").flatMap((l) => {
		try { return l.trim() ? [JSON.parse(l)] : [] } catch { return [] }
	})
}

// Whether the run can be ordered, and from which revision; the reason when not.
export function orderCheck(dir: string): { ok: true; revision: number; fabRevision: number } | { ok: false; reason: string } {
	const events = readTrace(dir)
	if (events.find((e) => e.type === "run.started")?.payload?.noHardware === true) return { ok: false, reason: "the hardware was stubbed in this run (--no-hardware): there are no real gerbers to order" }
	const lastSettle = events.findLastIndex((e) => e.type === "design.settled")
	if (lastSettle < 0) return { ok: false, reason: "the design is not settled yet: wait until it is consistent" }
	const settled = events[lastSettle].payload
	if (!settled.settled) return { ok: false, reason: `the design stopped at rev ${settled.revision} and is not consistent: fix it before ordering` }
	if (events.slice(lastSettle + 1).some((e) => e.type === "contract.changed")) return { ok: false, reason: "a change is in flight: wait until the design settles again" }
	// Everything green: the board's DRC clean, and the brief review passed (when the run has one).
	const board = events.filter((e) => e.type === "artifact.ready" && e.payload.kind === "board" && e.payload.revision <= settled.revision).at(-1)?.payload
	if (!board) return { ok: false, reason: "the board has not been built yet" }
	if (board.drc && board.drc.errors > 0) return { ok: false, reason: `the board's DRC has ${board.drc.errors} errors at rev ${board.revision}: fix them before ordering` }
	const reviewOn = events.find((e) => e.type === "run.started")?.payload?.review !== false
	const review = events.filter((e) => e.type === "review.completed").at(-1)?.payload
	if (reviewOn && !review) return { ok: false, reason: "the brief review has not finished yet" }
	if (reviewOn && review.verdict !== "pass") return { ok: false, reason: `the brief review did not pass (rev ${review.revision}): see the review findings` }
	const readme = join(dir, "fab/README.txt")
	if (!["gerbers.zip", "bom.csv", "cpl.csv"].every((f) => existsSync(join(dir, "fab", f))) || !existsSync(readme)) return { ok: false, reason: "there is no fab package for this run yet (gerbers, BOM and CPL)" }
	const fabRevision = Number(/Contract revision (\d+)/.exec(readFileSync(readme, "utf8"))?.[1] ?? NaN)
	const boardChange = events.filter((e) => e.type === "contract.changed" && BOARD_INPUTS.has(e.payload.field) && e.payload.revision <= settled.revision).at(-1)?.payload.revision ?? 0
	if (!Number.isFinite(fabRevision) || fabRevision < boardChange) return { ok: false, reason: `the fab files are from rev ${Number.isFinite(fabRevision) ? fabRevision : "?"}, but the board changed at rev ${boardChange}: wait for the board build` }
	return { ok: true, revision: settled.revision, fabRevision }
}

// The newest enclosure build at or before the settled revision that has a case STL.
function caseDir(dir: string, revision: number): string | null {
	const root = join(dir, "enclosure")
	if (!existsSync(root)) return null
	const revs = readdirSync(root).map((d) => /^rev-(\d+)$/.exec(d)).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => Number(m[1])).filter((r) => r <= revision && existsSync(join(root, `rev-${r}`, "case.stl")))
	return revs.length ? join(root, `rev-${Math.max(...revs)}`) : null
}

function readme(runId: string, revision: number, fabRevision: number, caseRev: string | null, fabReadme: string): string {
	const checklist = /CHECKLIST[\s\S]*?(?=\n\s*Contract revision|$)/.exec(fabReadme)?.[0].trimEnd() ?? ""
	return [
		`Bringup · Ready to order · ${runId} · design rev ${revision} (board files from rev ${fabRevision})`,
		"",
		"Nothing was uploaded and no order was placed: JLCPCB has no public order API. These are the files its",
		"order forms ask for; the steps below take a few minutes.",
		"",
		"FILES",
		"  gerbers.zip  Gerber X2 layers and the drill file: the PCB",
		"  bom.csv      the parts list, JLCPCB's PCBA format (LCSC part numbers)",
		"  cpl.csv      where each part goes (pick and place)",
		caseRev ? `  case.stl, lid.stl  the enclosure, print-ready poses (enclosure ${caseRev})` : "  (no case STL: the enclosure was not built for this revision)",
		"",
		"1. THE BOARD, ASSEMBLED (JLCPCB)",
		`   Open ${JLCPCB_QUOTE} and add gerbers.zip. Keep the detected size and 2 layers.`,
		"   Turn on PCB Assembly, then add bom.csv and cpl.csv when it asks for them.",
		"   Check every part in JLCPCB's placement preview, and fix rotations there (see the checklist).",
		"",
		"2. THE CASE (JLC3DP)",
		caseRev ? `   Open ${JLC3DP}, start a 3D printing quote and add case.stl and lid.stl.` : "   No case files in this package.",
		"",
		"BEFORE YOU PAY, review these known unverified items:",
		checklist ? checklist.split("\n").slice(1).join("\n") : "  (no checklist in the fab package)",
		"",
	].join("\n")
}

export function orderPackage(dir: string): OrderPackage {
	const check = orderCheck(dir)
	if (!check.ok) return check
	const runId = basename(dir)
	const fab = (f: string) => readFileSync(join(dir, "fab", f))
	const cd = caseDir(dir, check.revision)
	const files = [
		{ name: "README.txt", data: Buffer.from(readme(runId, check.revision, check.fabRevision, cd ? basename(cd) : null, fab("README.txt").toString())) },
		{ name: "gerbers.zip", data: fab("gerbers.zip") },
		{ name: "bom.csv", data: fab("bom.csv") },
		{ name: "cpl.csv", data: fab("cpl.csv") },
		...(cd ? ["case.stl", "lid.stl"].filter((f) => existsSync(join(cd, f))).map((f) => ({ name: f, data: readFileSync(join(cd, f)) })) : []),
	]
	return { ok: true, name: `bringup-${runId}-rev${check.revision}-ready-to-order.zip`, revision: check.revision, zip: zipStore(files) }
}
