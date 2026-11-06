import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { ROUTING_FAILURE } from "../contract/space.ts"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boardParts, circuitFromContract, LDO_FROM_USB_MM, placeParts, type PlacementOptions } from "../codegen/circuit.ts"
import type { BoardArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { holesFromCircuitJson, netsFromCircuitJson, partsFromCircuitJson, placementsFromCircuitJson } from "./board-nets.ts"
import { kicadCli, toolPath, type Env } from "./env.ts"
import { runDrc } from "./drc.ts"
import { run, tail } from "./exec.ts"

// Contract -> tscircuit source -> placed and autorouted board -> KiCad project, STEP and render.
// tscircuit's own result is the source of truth for nets and size; KiCad exports are best-effort.
export async function buildBoard(env: Env, dir: string, s: ContractSnapshot, revision: number): Promise<BoardArtifact> {
	if (!env.tsci) throw new Error("tscircuit build failed: tsci is not installed (tools/node)")
	// tscircuit treats the nearest package.json as its project: inside this repo it would look for
	// react in our node_modules and write to the repo's dist/. Build outside any project, then copy.
	// tscircuit's autorouter occasionally drops a via onto a pad for one particular geometry; nudging the
	// LDO usually clears it, so a placement-sensitive failure retries with a few alternative distances.
	// The same goes for what only KiCad's DRC sees: tscircuit doesn't model a connector's locating-hole clearance, so a
	// via can land next to J1's NPTH (the first wake-word board: 4 hole_clearance errors, 0 on the logger without the
	// microphone). A build with DRC errors also tries the next distance; the build with the fewest errors is kept.
	let lastError: unknown
	let best: { board: BoardArtifact; errors: number } | null = null
	// The default layout first; then the same with keepouts at the USB-C locating holes (the fix for vias beside
	// them); then the other LDO distances.
	const attempts: PlacementOptions[] = [{ ldoFromUsbMm: LDO_FROM_USB_MM }, { ldoFromUsbMm: LDO_FROM_USB_MM, usbKeepouts: true }, ...[7, 9.5, 11].map((ldoFromUsbMm) => ({ ldoFromUsbMm }))]
	// A layout that leaves a part out is never built: tscircuit would drop the part at the board's centre, onto whatever
	// is there (the wake-word board at 35×25 mm, LDO 11 mm from J1: "C3 overlaps U3", and autorouting skipped).
	const count = boardParts(s).length
	const fitting = attempts.filter((placement) => placeParts(s, placement).length >= count)
	if (fitting.length === 0) {
		const placed = new Set(placeParts(s).map((b) => b.ref))
		const left = boardParts(s).map((p) => p.ref).filter((ref) => !placed.has(ref))
		throw new Error(`tscircuit build failed: no room on the board for ${left.join(", ")} at ${s.values.outline?.widthMm}×${s.values.outline?.heightMm} mm (the placer found no free spot)`)
	}
	for (const placement of fitting) {
		const work = mkdtempSync(join(tmpdir(), "bringup-board-"))
		const out = mkdtempSync(join(tmpdir(), "bringup-board-out-"))
		try {
			const board = await buildIn(env, work, s, revision, out, placement)
			const errors = board.drc?.errors ?? 0
			if (!best || errors < best.errors) {
				if (best) rmSync(best.board.dir, { recursive: true, force: true })
				best = { board, errors }
			} else rmSync(out, { recursive: true, force: true })
			if (errors === 0) break
		} catch (error) {
			// The failed attempt's log goes to the run's folder, and the message points there. Not when an earlier layout
			// built: its board is what lands in the folder, and a failed layout's log beside it would mislead.
			if (!best && existsSync(join(out, "build.log"))) {
				mkdirSync(dir, { recursive: true })
				cpSync(join(out, "build.log"), join(dir, "build.log"))
			}
			rmSync(out, { recursive: true, force: true })
			lastError = error instanceof Error ? new Error(error.message.replaceAll(out, dir)) : error
			// Once an earlier layout has built, a later one failing only means it isn't better: keep the board we have
			// (before, a keepout attempt that failed threw, and the built board with a few DRC errors was lost).
			if (best) continue
			if (!/overlap|clearance|keepout|too close/i.test(String(error))) throw error
		} finally {
			rmSync(work, { recursive: true, force: true })
		}
	}
	if (!best) throw lastError
	// Moved into the run's own folder, with every path re-pointed there.
	mkdirSync(dir, { recursive: true })
	cpSync(best.board.dir, dir, { recursive: true })
	rmSync(best.board.dir, { recursive: true, force: true })
	const at = (p: string | null) => (p ? p.replace(best!.board.dir, dir) : p)
	return { ...best.board, dir, pcbPath: at(best.board.pcbPath)!, stepPath: at(best.board.stepPath), renderPath: at(best.board.renderPath) }
}

async function buildIn(env: Env, work: string, s: ContractSnapshot, revision: number, dir: string, placement: PlacementOptions): Promise<BoardArtifact> {
	writeFileSync(join(work, "board.circuit.tsx"), circuitFromContract(s, placement))
	const build = await run(env.tsci!, ["build", "board.circuit.tsx", "--kicad-project"], { cwd: work, timeoutMs: 300_000, env: { PATH: toolPath(env) } })
	const circuitPath = join(work, "dist/board/circuit.json")
	if (build.code !== 0 || !existsSync(circuitPath)) {
		writeFileSync(join(dir, "build.log"), build.stdout + "\n" + build.stderr)
		throw new Error(`tscircuit build failed (exit ${build.code}):\n${buildErrors(build.stdout + "\n" + build.stderr)}\nfull log: ${join(dir, "build.log")}`)
	}
	const elements = JSON.parse(readFileSync(circuitPath, "utf8")) as { type: string; width?: number; height?: number }[]
	const pcb = elements.find((e) => e.type === "pcb_board")
	const pcbRel = "dist/board/kicad/board.kicad_pcb"
	// The routing keepouts were for the autorouter only; the board KiCad checks and exports is without them.
	const pcbFile = join(work, pcbRel)
	if (existsSync(pcbFile)) writeFileSync(pcbFile, stripKeepouts(readFileSync(pcbFile, "utf8")))

	const step = await kicadCli(env, ["pcb", "export", "step", "-o", "board.step", pcbRel], work, 180_000)
	const render = await kicadCli(env, ["pcb", "render", "-o", "board.png", "--side", "top", pcbRel], work, 180_000)
	const usbRefs = (s.values.connectors ?? []).filter((c) => c.kind === "usb-c").map((c) => c.ref)
	const drc = await runDrc(env, work, pcbRel, "dist/board/kicad/board.kicad_pro", usbRefs)
	cpSync(work, dir, { recursive: true })

	return {
		revision,
		dir,
		pcbPath: join(dir, pcbRel),
		stepPath: step.code === 0 && existsSync(join(dir, "board.step")) ? join(dir, "board.step") : null,
		renderPath: render.code === 0 && existsSync(join(dir, "board.png")) ? join(dir, "board.png") : null,
		widthMm: pcb?.width ?? 0,
		heightMm: pcb?.height ?? 0,
		nets: netsFromCircuitJson(elements),
		holes: holesFromCircuitJson(elements),
		parts: partsFromCircuitJson(elements),
		placements: placementsFromCircuitJson(elements),
		drc,
	}
}

// Keepouts are routing hints for tscircuit's autorouter (it can't see a connector's locating holes and drops vias next
// to them), not fab rules: KiCad would read them as rule areas and flag the connector's own pads inside. Removes every
// top-level zone that is a keepout from the exported board, leaving copper zones alone.
export function stripKeepouts(pcb: string): string {
	let out = ""
	let i = 0
	for (;;) {
		const at = pcb.indexOf("(zone", i)
		if (at < 0) return out + pcb.slice(i)
		let depth = 0
		let end = at
		for (; end < pcb.length; end++) {
			if (pcb[end] === "(") depth++
			else if (pcb[end] === ")" && --depth === 0) break
		}
		const block = pcb.slice(at, end + 1)
		const lineStart = pcb.lastIndexOf("\n", at) + 1
		out += pcb.slice(i, /\(keepout\b/.test(block) ? lineStart : end + 1)
		i = end + 1
	}
}

// tscircuit prints many advisory warnings before the real error; keep the lines that explain the failure.
const NOISE = /underspecified|requires_power|missing a trace|missing a manufacturer part|does not match supplier footprint|schematicsheet|is missing a name|Failed to load 3D model/i
const SIGNAL = /error|overlap|clearance|too close|outside|fail|fatal|cannot|skipped/i
const SUMMARY = /^Circuits\s+\d+ passed \d+ failed/

// The lines that explain a failed build. The router's "missing a trace" lines also follow other errors (a via on a
// pad), so they count only when nothing more specific explains it: then the router ran out of room, and without them
// the architect saw only "0 passed 1 failed".
export function buildErrors(output: string): string {
	const lines = output.split("\n").map((l) => l.trim()).filter(Boolean)
	const relevant = lines.filter((l) => SIGNAL.test(l) && !NOISE.test(l))
	if (relevant.every((l) => SUMMARY.test(l))) {
		const unrouted = lines.filter((l) => ROUTING_FAILURE.test(l))
		if (unrouted.length > 0) return [...unrouted.slice(0, 8), ...(unrouted.length > 8 ? [`(${unrouted.length - 8} more pins without a trace)`] : []), ...relevant].join("\n")
	}
	return (relevant.length > 0 ? relevant : lines).slice(-20).join("\n")
}
