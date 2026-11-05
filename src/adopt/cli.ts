// bringup adopt <repo> [--json out.json]: read an existing hardware repo (KiCad boards, firmware, case files), infer
// the design contract it implies and list where the domains disagree. Read-only: it never writes into the repo.
import { appendFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"
import { firmwareVariants, type FirmwareVariant } from "./firmware.ts"
import { findMcus, gpioOfPad, rankVariants, type PinCheck } from "./match.ts"
import { pinLabel } from "./pins.ts"
import { checkAgainst, writeContracts, type CheckResult } from "./contract.ts"
import { checkModel, checkModelOnBoard, describeModel, findModels, firmwareFacts, walkRepo, type MlFinding, type ModelFacts } from "./ml.ts"
import { avrOf, devBoardPins } from "./match.ts"
import { boardFits, stlBox } from "./mech.ts"
import { loadBoardFile } from "./pcb.ts"

export function find(dir: string, test: (name: string) => boolean, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === ".git" || name === "node_modules" || name === ".pio") continue
		const p = join(dir, name)
		let st
		try {
			st = statSync(p)
		} catch {
			// A broken symlink: nothing to read.
			continue
		}
		if (st.isDirectory()) find(p, test, out)
		else if (test(name)) out.push(p)
	}
	return out
}

export interface BoardReport {
	file: string
	kicadVersion: number
	outline: { widthMm: number; heightMm: number } | null
	mcu: { ref: string; value: string; gpioPads: number } | null
	mcus: string[]
	variant: { id: string; score: number } | null
	runnersUp: { id: string; score: number }[]
	checks: PinCheck[]
	case: { file: string; box: { x: number; y: number; z: number }; fits: boolean; marginMm: number }[]
	inferred: { pins: { signal: string; gpio: number; partRef: string; partPin: string }[] }
	// The model against this board: its sensor, and the chip's RAM and flash.
	ml: MlFinding[]
	note?: string
}

export interface MlReport {
	models: ModelFacts[]
	// The model against the firmware: the input it is handed, the rate it is sampled at.
	findings: MlFinding[]
}

export function adopt(repo: string, opts: { variant?: string } = {}): { repo: string; variants: number; boards: BoardReport[]; ml: MlReport | null } {
	const variants: FirmwareVariant[] = firmwareVariants(repo)
	const files = walkRepo(repo)
	const models = findModels(repo, files)
	const ml: MlReport | null = models.length ? { models, findings: models.flatMap((m) => checkModel(m, firmwareFacts(repo, files, m.program)).map((f) => ({ ...f, program: m.program, model: m.file }))) } : null
	const cases = find(repo, (n) => /\.stl$/i.test(n)).filter((p) => /case|enclosure|housing|shell|body|bottom|base/i.test(relative(repo, p)))
	const boards: BoardReport[] = []
	for (const file of find(repo, (n) => n.endsWith(".kicad_pcb"))) {
		const b = loadBoardFile(file)
		const mcus = findMcus(b)
		const mcu = mcus[0] ?? null
		const rep: BoardReport = {
			file: relative(repo, file),
			kicadVersion: b.version,
			outline: b.outline && { widthMm: b.outline.widthMm, heightMm: b.outline.heightMm },
			mcus: mcus.map((m) => `${m.ref} ${m.value}`),
			mcu: mcu && { ref: mcu.ref, value: mcu.value, gpioPads: mcu.pads.filter((p) => gpioOfPad(mcu, p) !== null).length },
			variant: null,
			runnersUp: [],
			checks: [],
			case: [],
			inferred: { pins: [] },
			// A socketed dev board (or a board with no MCU, a carrier) may carry the sensor itself.
			ml: models.flatMap((m) => checkModelOnBoard(m, b, mcu, Boolean(mcu && (devBoardPins(mcu) || avrOf(mcu)?.board)))),
		}
		if (!mcu) rep.note = b.version < 20200000 ? "KiCad 5 board: pads carry no pin names, so an MCU's GPIOs can't be read from the board alone" : "no MCU on this board (a breakout or a passive board)"
		else {
			// The board's own pin map: every MCU GPIO pad on a named, connected net. This is what the contract would hold.
			for (const m of mcus) for (const p of m.pads) {
				const g = gpioOfPad(m, p)
				if (g === null || !p.net || p.net.startsWith("unconnected-") || /^Net-\(/.test(p.net)) continue
				rep.inferred.pins.push({ signal: p.net.split("/").pop()!, gpio: g, partRef: m.ref, partPin: p.number })
			}
			// --variant pins the pairing when a person knows which firmware runs on the board.
			const ranked = rankVariants(b, mcus, variants, opts.variant)
			if (ranked.length) {
				rep.variant = { id: ranked[0].v.id, score: +ranked[0].score.toFixed(2) }
				rep.runnersUp = ranked.slice(1, 4).map((r) => ({ id: r.v.id, score: +r.score.toFixed(2) }))
				rep.checks = ranked[0].checks
			}
		}
		if (b.outline)
			for (const c of cases) {
				const box = stlBox(c)
				if (box) rep.case.push({ file: relative(repo, c), box, ...boardFits(b.outline.widthMm, b.outline.heightMm, box) })
			}
		boards.push(rep)
	}
	return { repo: basename(resolve(repo)), variants: variants.length, boards, ml }
}

const MARK: Record<PinCheck["verdict"], string> = { "assigned-unwired": "·", "clock-mode": "✗", "other-revision": "✓", "inside-module": "✓", "module-conflict": "✗", unconnected: "✗", power: "✗", "not-on-pads": "?", "name-differs": "≠", unnamed: "·", agrees: "✓" }

export function render(r: ReturnType<typeof adopt>): string {
	const out: string[] = [`# ${r.repo}: ${r.boards.length} board(s), ${r.variants} firmware variant(s)`]
	if (r.ml) {
		out.push("", "## The model on the device")
		// Grouped by the program that builds each model (a repo may keep old copies in archive/ or prototypes/).
		for (const m of r.ml.models) {
			out.push(`  ${m.program || "(repo root)"}: ${describeModel(m)}  (${m.file})`)
			for (const f of r.ml.findings.filter((x) => x.model === m.file)) out.push(`    ${f.mark} ${f.what}${f.where ? `  (${f.where})` : ""}`)
		}
	}
	for (const b of r.boards) {
		out.push("", `## ${b.file}  (KiCad ${b.kicadVersion}${b.outline ? `, ${b.outline.widthMm} × ${b.outline.heightMm} mm` : ""})`)
		if (b.note) out.push(`  ${b.note}`)
		if (b.mcu) out.push(`  MCU${b.mcus.length > 1 ? "s" : ""} ${b.mcus.join(", ")}: ${b.inferred.pins.length} GPIO pads on named nets`)
		if (b.variant) {
			// No build explains the board (every fit at or below zero): its firmware is likely elsewhere, so a broken pin
			// is a question about the pairing, not a wiring fault.
			const unpaired = b.variant.score <= 0
			out.push(unpaired
				? `  no firmware build here fits this board (best: ${b.variant.id}, fit ${b.variant.score}); its firmware may be elsewhere, so the pins below are questions, not faults`
				: `  best-matching firmware: ${b.variant.id} (fit ${b.variant.score})${b.runnersUp.length ? `; next: ${b.runnersUp.map((x) => `${x.id} ${x.score}`).join(", ")}` : ""}`)
			for (const c of b.checks) {
				const where = c.verdict === "not-on-pads" ? "no pad is this GPIO" : c.verdict === "inside-module" || c.verdict === "clock-mode" ? c.net : c.verdict === "module-conflict" ? `taken by ${c.net}` : `${c.mcu}.${c.pad} → ${c.net || "(no net)"}${c.verdict === "assigned-unwired" ? "  (assigned to its peripheral, not wired: drivers need every line assigned)" : ""}${c.pin.console && c.verdict === "unconnected" && !c.pin.unused ? "  (the console: its output goes nowhere)" : ""}${c.sharedWith ? `  ✗ also ${c.sharedWith}: one pin, two jobs` : ""}${c.pin.sleepPin !== undefined ? `  ${c.pin.unused ? "" : "✗ "}its sleep state puts it on ${pinLabel(c.pin.sleepPin)}` : ""}${c.verdict === "unnamed" || c.verdict === "name-differs" ? `  [reaches ${c.reaches.slice(0, 4).join(", ")}]` : ""}`
				// A broken pin defined under #if may be another board's branch: shown, but marked as a question.
				const mark = c.pin.unused && MARK[c.verdict] !== "✓" ? "–" : (c.pin.conditional || unpaired) && MARK[c.verdict] === "✗" ? "?" : MARK[c.verdict]
				out.push(`  ${mark} ${c.pin.name}=${c.pin.as ? `${c.pin.as} (${pinLabel(c.pin.gpio)})` : pinLabel(c.pin.gpio)}  ${where}  (${c.pin.file}:${c.pin.line}${c.branches ? `, best of ${c.branches} #if branches` : c.pin.conditional ? ", under #if" : ""}${c.pin.unused ? ", not used in this build" : ""})`)
			}
		}
		if (b.mcu || b.ml.some((f) => f.mark !== "?")) for (const f of b.ml) out.push(`  ${f.mark} model: ${f.what}`)
		// Repos hold several printed parts (Plant133's sensor cap); the board needs one case that fits, so report the best.
		const best = [...b.case].sort((x, y) => y.marginMm - x.marginMm)[0]
		if (best) out.push(`  case: ${best.fits ? `board fits ${best.file} (${best.box.x}×${best.box.y}×${best.box.z} mm, tightest margin ${best.marginMm} mm)` : `✗ board fits none of ${b.case.length} case part(s); closest ${best.file} is short by ${-best.marginMm} mm`}`)
	}
	return out.join("\n")
}

export function renderCheck(results: CheckResult[]): string {
	const out: string[] = []
	for (const r of results) {
		out.push(`## ${r.board}`)
		if (r.missing) out.push(`  ✗ ${r.missing}`)
		for (const v of r.violations) out.push(`  ✗ ${v.kind}: ${v.message}`)
		for (const c of r.changes) out.push(`  ~ ${c.field}: ${c.what}`)
		if (!r.missing && !r.violations.length && !r.changes.length) out.push("  ✓ matches the agreed contract")
	}
	return out.join("\n")
}

// A pull request's job summary: the verdict against the agreed contract first (what gates the PR), then the design
// changes it makes, then every board's pin report folded away. Markdown, so it reads the same in GitHub and a file.
export function markdown(r: ReturnType<typeof adopt>, results: CheckResult[] | null, contractDir: string): string {
	const out: string[] = []
	const failing = results?.filter((x) => x.violations.length || x.missing) ?? []
	out.push(`## Bringup adopt: ${r.repo}`, "")
	if (!results) {
		out.push(`No agreed contract in \`${contractDir}\` yet, so nothing gates this change. To agree on the design as it is now, run`, "", "```", `npx tsx src/adopt/cli.ts . --contract ${contractDir}`, "```", "", "and commit the folder. From then on, a change that breaks it fails this check.", "")
	} else {
		out.push(failing.length ? `**✗ ${failing.length} board(s) break the agreed contract** (\`${contractDir}\`).` : `**✓ Every board matches the agreed contract** (\`${contractDir}\`).`, "")
		for (const x of results) {
			if (!x.missing && !x.violations.length && !x.changes.length) continue
			out.push(`### \`${x.board}\``)
			if (x.missing) out.push(`- ✗ ${x.missing}`)
			for (const v of x.violations) out.push(`- ✗ **${v.kind}**: ${v.message}`)
			if (x.changes.length) out.push("", "Design changes in this revision (accept them by re-running `--contract` and committing the result):", ...x.changes.map((c) => `- ${c.field}: ${c.what}`))
			out.push("")
		}
	}
	out.push("<details><summary>Every firmware pin against every board</summary>", "", "```", render(r), "```", "", "</details>", "")
	return out.join("\n")
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2)
	const opt = (name: string) => {
		const i = args.indexOf(name)
		return i >= 0 ? args.splice(i, 2)[1] : undefined
	}
	const json = opt("--json")
	const variant = opt("--variant")
	const contractDir = opt("--contract")
	const checkDir = opt("--check")
	const md = opt("--markdown")
	const repo = args[0]
	if (!repo) {
		console.error("usage: adopt <repo> [--variant <env or id>] [--json out.json] [--markdown summary.md] [--contract <dir> | --check <dir>]")
		process.exit(2)
	}
	if (checkDir) {
		// The repo now against the agreed contract: exit 1 when Bringup's checks find a violation. With no contract
		// agreed yet there is nothing to break: report, say how to agree, exit 0.
		const agreed = existsSync(join(checkDir, "index.json"))
		const results = agreed ? checkAgainst(repo, checkDir) : null
		console.log(results ? renderCheck(results) : `no agreed contract in ${checkDir}: run --contract ${checkDir} and commit it`)
		if (md) appendFileSync(md, markdown(adopt(repo, { variant }), results, checkDir))
		process.exit(results?.some((r) => r.violations.length > 0 || r.missing) ? 1 : 0)
	}
	const r = adopt(repo, { variant })
	console.log(render(r))
	if (json) writeFileSync(json, JSON.stringify(r, null, 2))
	if (md) appendFileSync(md, markdown(r, null, contractDir ?? ".bringup/adopt"))
	if (contractDir) {
		const written = writeContracts(repo, find(repo, (n) => n.endsWith(".kicad_pcb")), contractDir, variant)
		console.log("")
		for (const w of written) {
			const v = w.inferred.snapshot.values
			console.log(`contract ${contractDir}/${w.entry}: ${v.pins?.length ?? 0} pins, ${v.parts?.length ?? 0} parts, ${v.connectors?.length ?? 0} edge connectors, firmware ${w.inferred.links.variant ?? "none"}`)
			for (const f of w.inferred.refused) console.log(`  the contract refused ${f.field}: ${f.reason}`)
		}
	}
}
