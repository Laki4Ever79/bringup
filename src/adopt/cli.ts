// bringup adopt <repo> [--json out.json]: read an existing hardware repo (KiCad boards, firmware, case files), infer
// the design contract it implies and list where the domains disagree. Read-only: it never writes into the repo.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { firmwareVariants, type FirmwareVariant } from "./firmware.ts"
import { checkVariant, findMcus, fitScore, gpioOfPad, type PinCheck } from "./match.ts"
import { pinLabel } from "./pins.ts"
import { boardFits, stlBox } from "./mech.ts"
import { nameLegacyPads, readBoard } from "./pcb.ts"

function find(dir: string, test: (name: string) => boolean, out: string[] = []): string[] {
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
	note?: string
}

export function adopt(repo: string, opts: { variant?: string } = {}): { repo: string; variants: number; boards: BoardReport[] } {
	const variants: FirmwareVariant[] = firmwareVariants(repo)
	const cases = find(repo, (n) => /\.stl$/i.test(n)).filter((p) => /case|enclosure|housing|shell|body|bottom|base/i.test(relative(repo, p)))
	const boards: BoardReport[] = []
	for (const file of find(repo, (n) => n.endsWith(".kicad_pcb"))) {
		const b = readBoard(readFileSync(file, "utf8"))
		// KiCad 5: pin names come from the project's schematic and symbol cache.
		const cache = join(dirname(file), `${basename(file, ".kicad_pcb")}-cache.lib`)
		if (b.version < 20200000 && existsSync(cache)) {
			const schs = readdirSync(dirname(file)).filter((n) => n.endsWith(".sch")).map((n) => readFileSync(join(dirname(file), n), "utf8"))
			nameLegacyPads(b, schs, readFileSync(cache, "utf8"))
		}
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
			const ranked = variants
				.filter((v) => !opts.variant || v.id === opts.variant || v.id.endsWith(`:${opts.variant}`))
				.map((v) => ({ v, checks: checkVariant(b, mcus, v) }))
				.map((r) => ({ ...r, score: fitScore(r.checks) }))
				.sort((a, b) => b.score - a.score)
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
	return { repo: basename(repo), variants: variants.length, boards }
}

const MARK: Record<PinCheck["verdict"], string> = { "clock-mode": "✗", "other-revision": "✓", "inside-module": "✓", "module-conflict": "✗", unconnected: "✗", power: "✗", "not-on-pads": "?", "name-differs": "≠", unnamed: "·", agrees: "✓" }

export function render(r: ReturnType<typeof adopt>): string {
	const out: string[] = [`# ${r.repo}: ${r.boards.length} board(s), ${r.variants} firmware variant(s)`]
	for (const b of r.boards) {
		out.push("", `## ${b.file}  (KiCad ${b.kicadVersion}${b.outline ? `, ${b.outline.widthMm} × ${b.outline.heightMm} mm` : ""})`)
		if (b.note) out.push(`  ${b.note}`)
		if (b.mcu) out.push(`  MCU${b.mcus.length > 1 ? "s" : ""} ${b.mcus.join(", ")}: ${b.inferred.pins.length} GPIO pads on named nets`)
		if (b.variant) {
			out.push(`  best-matching firmware: ${b.variant.id} (fit ${b.variant.score})${b.runnersUp.length ? `; next: ${b.runnersUp.map((x) => `${x.id} ${x.score}`).join(", ")}` : ""}`)
			for (const c of b.checks) {
				const where = c.verdict === "not-on-pads" ? "no pad is this GPIO" : c.verdict === "inside-module" || c.verdict === "clock-mode" ? c.net : c.verdict === "module-conflict" ? `taken by ${c.net}` : `${c.mcu}.${c.pad} → ${c.net || "(no net)"}${c.verdict === "unnamed" || c.verdict === "name-differs" ? `  [reaches ${c.reaches.slice(0, 4).join(", ")}]` : ""}`
				// A broken pin defined under #if may be another board's branch: shown, but marked as a question.
				const mark = c.pin.unused && MARK[c.verdict] !== "✓" ? "–" : c.pin.conditional && MARK[c.verdict] === "✗" ? "?" : MARK[c.verdict]
				out.push(`  ${mark} ${c.pin.name}=${pinLabel(c.pin.gpio)}  ${where}  (${c.pin.file}:${c.pin.line}${c.branches ? `, best of ${c.branches} #if branches` : c.pin.conditional ? ", under #if" : ""}${c.pin.unused ? ", not used in this build" : ""})`)
			}
		}
		// Repos hold several printed parts (Plant133's sensor cap); the board needs one case that fits, so report the best.
		const best = [...b.case].sort((x, y) => y.marginMm - x.marginMm)[0]
		if (best) out.push(`  case: ${best.fits ? `board fits ${best.file} (${best.box.x}×${best.box.y}×${best.box.z} mm, tightest margin ${best.marginMm} mm)` : `✗ board fits none of ${b.case.length} case part(s); closest ${best.file} is short by ${-best.marginMm} mm`}`)
	}
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
	const repo = args[0]
	if (!repo) {
		console.error("usage: adopt <repo> [--variant <env or id>] [--json out.json]")
		process.exit(2)
	}
	const r = adopt(repo, { variant })
	console.log(render(r))
	if (json) writeFileSync(json, JSON.stringify(r, null, 2))
}
