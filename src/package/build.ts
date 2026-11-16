// A build-ready package from a design contract: one folder a person can order and assemble from (the user decides any
// order; nothing here orders). It rebuilds every artifact on today's code from the contract alone:
//   fab/       JLCPCB gerbers, BOM and CPL, checked complete against the contract's parts
//   parts.md   the board's LCSC parts with today's stock and unit price, and the bought robot parts with shop links
//   printed/   the chassis STLs (and any clamp or mast sections)
//   firmware/  the built firmware and how to flash it
//   assembly.md, bringup.md (bench bring-up), README.md (totals and what's missing)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { ContractSnapshot } from "../contract/types.ts"
import { checkConsistency } from "../contract/consistency.ts"
import type { Env } from "../tools/env.ts"
import { buildBoard } from "../tools/board.ts"
import { exportFab } from "../tools/fab.ts"
import { buildChassis } from "../tools/chassis.ts"
import { buildFirmware } from "../tools/firmware.ts"
import { lookupLcsc } from "../tools/parts-search.ts"
import { checkRobotParts, robotPartLines, robotPartNotes } from "../tools/robot-parts.ts"
import { writeBench } from "../report.ts"

export interface PackageResult {
	dir: string
	boardUsd: number | null
	robotUsd: number | null
	missing: string[]
	outOfStock: string[]
	unpriced: string[]
	findings: string[]
}

const csvRows = (path: string) => readFileSync(path, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')))
const usd = (n: number | null) => (n === null ? "?" : `$${n.toFixed(2)}`)

export async function buildPackage(env: Env, s: ContractSnapshot, outDir: string, opts: { root: string; python: string; pio: string; log?: (m: string) => void }): Promise<PackageResult> {
	const log = opts.log ?? (() => {})
	const rev = s.revision
	mkdirSync(outDir, { recursive: true })
	const work = join(outDir, ".work")
	const missing: string[] = [], outOfStock: string[] = [], unpriced: string[] = []
	const findings = checkConsistency(s, {}).map((v) => `${v.kind}: ${v.message}`)

	// 1. The board and its JLCPCB files, checked complete: every contract part with an LCSC number in the BOM and placed in the CPL.
	log("board: building")
	let board: Awaited<ReturnType<typeof buildBoard>> | null = null
	try {
		board = await buildBoard(env, join(work, "board"), s, rev)
	} catch (e) {
		missing.push(`the board didn't build: ${(e as Error).message.slice(0, 300)}`)
	}
	let fabOk = false
	let bomRows: string[][] = []
	if (board) {
		log("fab: exporting")
		const fab = await exportFab(env, board, s, outDir) // it writes outDir/fab
		bomRows = csvRows(fab.bom)
		const bomRefs = new Set(bomRows.flatMap((r) => r[1]?.split(/[ ,]+/).filter(Boolean) ?? []))
		const cplRefs = new Set(csvRows(fab.cpl).map((r) => r[0]))
		const lcscParts = (s.values.parts ?? []).filter((p) => p.lcsc)
		for (const p of lcscParts) {
			if (!bomRefs.has(p.ref)) missing.push(`fab BOM lacks ${p.ref} (${p.mpn})`)
			if (!cplRefs.has(p.ref)) missing.push(`fab CPL lacks ${p.ref} (${p.mpn})`)
		}
		if (!existsSync(fab.gerbersZip)) missing.push("fab gerbers zip missing")
		fabOk = existsSync(fab.gerbersZip) && !missing.some((m) => m.startsWith("fab"))
	}

	// 2. Today's stock and unit price for each LCSC line (jlcsearch), and the bought robot parts at their shops.
	log("parts: checking stock")
	// The fab BOM's lines (the generator's support resistors and capacitors included), else the contract's parts.
	const lines = new Map<string, { mpn: string; lcsc: string; refs: string[] }>()
	if (bomRows.length) {
		for (const [comment, refs, , lcsc] of bomRows) if (lcsc) lines.set(lcsc, { mpn: comment, lcsc, refs: refs.split(/[ ,]+/).filter(Boolean) })
	} else for (const p of s.values.parts ?? []) if (p.lcsc) lines.set(p.lcsc, { mpn: p.mpn, lcsc: p.lcsc, refs: [...(lines.get(p.lcsc)?.refs ?? []), p.ref] })
	const priced: { mpn: string; lcsc: string; refs: string[]; stock: number | null; unit: number | null }[] = []
	for (const l of lines.values()) {
		const live = await lookupLcsc(l.lcsc)
		priced.push({ ...l, stock: live.stock, unit: live.priceUsd })
		if (live.stock !== null && live.stock < l.refs.length) outOfStock.push(`${l.mpn} (${l.lcsc}): ${live.stock} in stock, ${l.refs.length} needed`)
		if (live.priceUsd === null) unpriced.push(`${l.mpn} (${l.lcsc})`)
	}
	const unbought = (s.values.parts ?? []).filter((p) => !p.lcsc)
	const boardUsd = priced.some((p) => p.unit !== null) ? priced.reduce((t, p) => t + (p.unit ?? 0) * p.refs.length, 0) : null
	const robot = s.values.mechanics ? await checkRobotParts(robotPartLines(s), { live: true }) : null
	for (const l of robot?.lines ?? []) {
		if (l.status === "out of stock" || l.status === "discontinued" || l.status === "backorder") outOfStock.push(`${l.item} ${l.mpn}: ${l.status}`)
		if (l.lineUsd === null) unpriced.push(`${l.item} ${l.mpn} (${l.status})`)
	}
	const robotUsd = robot?.knownUsd ?? null

	// 3. The printed parts.
	let stls: string[] = []
	if (s.values.mechanics) {
		log("chassis: building")
		const ch = await buildChassis(opts.python, opts.root, join(work, "chassis"), s, rev)
		if (ch.ok) {
			mkdirSync(join(outDir, "printed"), { recursive: true })
			stls = ch.files.filter((f) => f.endsWith(".stl"))
			for (const f of stls) copyFileSync(f, join(outDir, "printed", basename(f)))
		} else missing.push(`the chassis didn't build: ${(ch as { error?: string }).error ?? "see .work/chassis"}`)
	}

	// 4. The firmware.
	log("firmware: building")
	const fw = await buildFirmware(opts.pio, opts.root, join(work, "firmware"), s, rev)
	const fwBin = fw.ok ? readdirSync(join(work, "firmware"), { recursive: true }).map(String).find((f) => f.endsWith("firmware.bin") && !f.includes("_sim")) : undefined
	if (fwBin) {
		mkdirSync(join(outDir, "firmware"), { recursive: true })
		copyFileSync(join(work, "firmware", fwBin), join(outDir, "firmware", "firmware.bin"))
	} else missing.push("the firmware didn't build")

	// 5. Bench bring-up, the assembly order, the parts list and the summary.
	writeBench(outDir, s, board)
	writeFileSync(join(outDir, "assembly.md"), assemblyOrder(s, stls.map((f) => basename(f))))
	const partsMd = [
		`# Parts (prices and stock checked ${new Date().toISOString().slice(0, 10)})`,
		"",
		"## The board's parts (JLCPCB assembles them from the fab files; LCSC unit price at quantity 1)",
		"",
		"| Refs | Part | LCSC | In stock | Unit | Line |",
		"|---|---|---|---|---|---|",
		...priced.map((p) => `| ${p.refs.join(" ")} | ${p.mpn} | ${p.lcsc} | ${p.stock ?? "?"} | ${usd(p.unit)} | ${usd(p.unit === null ? null : p.unit * p.refs.length)} |`),
		"",
		`Parts total: ${usd(boardUsd)} per board (LCSC unit prices; JLCPCB adds the PCB, its assembly fee and a fee per extended part, which its quote shows at upload).`,
		...(unbought.length ? ["", `Not assembled by JLCPCB (no LCSC number): ${unbought.map((p) => `${p.ref} ${p.mpn}`).join(", ")}: bought and soldered by hand.`] : []),
		"",
		"## Bought parts for the robot",
		"",
		"| Item | Part | Qty | Shop | Status | Line |",
		"|---|---|---|---|---|---|",
		...(robot?.lines ?? []).map((l) => `| ${l.item} | ${l.mpn} | ${l.qty} | ${l.url ? `[${l.supplier}](${l.url})` : (l.supplier ?? "?")} | ${l.status} | ${usd(l.lineUsd)} |`),
		"",
		`Robot parts total: ${usd(robotUsd)} (the lines a shop priced). ${robot?.summary ?? ""}`,
		...(s.values.mechanics ? robotPartNotes(s).map((n) => `- Not covered yet: ${n}`) : []),
		"",
	].join("\n")
	writeFileSync(join(outDir, "parts.md"), partsMd)
	const result: PackageResult = { dir: outDir, boardUsd, robotUsd, missing, outOfStock, unpriced, findings }
	writeFileSync(join(outDir, "README.md"), readme(s, result, fabOk, stls.map((f) => basename(f)), Boolean(fwBin)))
	return result
}

function assemblyOrder(s: ContractSnapshot, stls: string[]): string {
	const v = s.values, m = v.mechanics
	const parts = v.parts ?? []
	const plug = (role: string) => parts.filter((p) => p.role === role).map((p) => p.ref).join(", ")
	const steps = [
		"Order the board from JLCPCB with the files in fab/ (gerbers zip, BOM, CPL; assembly on, top side). It arrives with its SMD parts on.",
		...(parts.some((p) => !p.lcsc) ? [`Solder the hand-placed parts (no LCSC number): ${parts.filter((p) => !p.lcsc).map((p) => `${p.ref} ${p.mpn}`).join(", ")}.`] : []),
		"Before anything else is connected: bench bring-up steps 1-3 in bringup.md (power, flash, self-test) on the bare board over USB-C.",
	]
	if (m) {
		steps.push(
			`Print the parts in printed/ (${stls.join(", ")}) in ${m.chassis.material}; ${m.chassis.thicknessMm} mm plate.`,
			`Mount the ${m.drive.kind === "skid4" ? "four" : "two"} motors (${m.drive.motor}) on the chassis's cradles or brackets, shafts out; then the wheels (${m.drive.wheel}).`,
			...(m.drive.kind === "skid4" ? [] : [`Bolt the caster (${m.drive.caster}) under the rear (its holes are in the plate).`]),
			`Fit the battery (${m.battery.pack}) between its rails${m.battery.enclosure === "fireproof-bag" ? ", in its fireproof bag" : ""}; leave it unplugged.`,
			`Screw the board onto its standoffs, USB-C toward the edge it faces; plug the motors into ${plug("connector").split(", ").filter((r) => r.startsWith("JM")).join(" and ") || "the motor plugs"} (left first).`,
			`Mount the distance sensor (${m.sensor.module}) on the front bracket and plug it into ${m.sensor.connector}.`,
			...(m.safety?.estop ? [`Fit the emergency stop (${m.safety.estop.part}) in its deck and plug it into ${m.safety.estop.connector}: it breaks the motors' supply.`] : []),
			...(m.safety?.start ? [`Plug the start cord into ${m.safety.start.connector}.`] : []),
			"Plug the battery in last, wheels off the floor, and run the rest of bringup.md (motors, encoders, sensor, then a first drive).",
		)
	}
	return ["# Assembly order", "", ...steps.map((t, i) => `${i + 1}. ${t}`), ""].join("\n")
}

function readme(s: ContractSnapshot, r: PackageResult, fabOk: boolean, stls: string[], fw: boolean): string {
	const total = r.boardUsd !== null || r.robotUsd !== null ? (r.boardUsd ?? 0) + (r.robotUsd ?? 0) : null
	return [
		`# Build package: ${s.values.requirements?.summary ?? "design"} (contract revision ${s.revision})`,
		"",
		"Rebuilt from the design contract on today's code. Nothing here has been ordered: the person building decides that.",
		"",
		"| What | Where | Status |",
		"|---|---|---|",
		`| JLCPCB fab files (gerbers, BOM, CPL) | fab/ | ${fabOk ? "complete: every LCSC part in the BOM and the CPL" : "INCOMPLETE (see below)"} |`,
		`| Parts with stock and prices | parts.md | board parts ${usd(r.boardUsd)}, robot parts ${usd(r.robotUsd)} |`,
		`| Printed parts | printed/ | ${stls.length ? stls.join(", ") : "none"} |`,
		`| Firmware | firmware/firmware.bin | ${fw ? "built" : "NOT built"} |`,
		"| Assembly order | assembly.md | |",
		"| Bench bring-up | bringup.md | |",
		"",
		`**Known cost: ${usd(total)}** (parts only: the PCB, JLCPCB's assembly and extended-part fees, shipping and filament are on top; JLCPCB's quote shows its part at upload).`,
		"",
		...(r.missing.length ? ["## Missing", "", ...r.missing.map((m) => `- ${m}`), ""] : []),
		...(r.outOfStock.length ? ["## Out of stock or short", "", ...r.outOfStock.map((m) => `- ${m}`), ""] : []),
		...(r.unpriced.length ? ["## Not priced (check by hand)", "", ...r.unpriced.map((m) => `- ${m}`), ""] : []),
		...(r.findings.length ? ["## Open design findings on today's checks", "", ...r.findings.map((m) => `- ${m}`), ""] : ["Today's design checks: none open.", ""]),
	].join("\n")
}
