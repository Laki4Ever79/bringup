import { copyFileSync, existsSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { KICAD_IMAGE } from "./env.ts"
import { mount } from "./mount.ts"
import { type RunResult } from "./exec.ts"
import { dockerRun } from "./containers.ts"
import { FAB_RULES } from "./drc.ts"

// Freerouting for a board tscircuit placed but couldn't route (crowded boards: run 9's 58×22 rover, where no tscircuit
// layout routed with the debug footprint; 16 Nov 2026, measured: Freerouting routes it with 0 DRC errors and 0
// unconnected under the JLCPCB rules, the footprint kept). KiCad's board → Specctra DSN (the fab's track, clearance and
// via, and keep-outs along the edge, which Freerouting honours) → Freerouting (headless, Java 25 in a container: the
// jar needs class file 69) → its session back into the board, the keep-outs removed.
export const FREEROUTING_JAR = "tools/freerouting-2.5.0.jar"
export const JAVA_IMAGE = "eclipse-temurin:25-jre"
export const ROUTE = { trackMm: 0.2, clearanceMm: 0.15, viaMm: 0.45, drillMm: 0.25, edgeMm: FAB_RULES.minEdgeClearanceMm + 0.05, passes: 20 }

const uid = () => `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`
const docker = (args: string[], timeoutMs: number): Promise<RunResult> => dockerRun("freerouting", ["-u", uid(), "-e", "HOME=/tmp", ...args], timeoutMs)

// Routes work/<pcbRel> in place. Returns null when it routed every connection, else why not. widths: the track width a
// net needs over the fab's default (a rail's IPC-2221 width, circuit.ts routedWidths): Freerouting routes it at the
// default, then freeroute.py widens it where clearance allows (thin only into fine-pitch pins; track-widths.ts judges).
export async function freeroute(root: string, work: string, pcbRel: string, widths: Map<string, number> = new Map()): Promise<string | null> {
	const jar = resolve(root, FREEROUTING_JAR)
	if (!existsSync(jar)) return `Freerouting isn't installed (${FREEROUTING_JAR})`
	copyFileSync(resolve(root, "py/freeroute.py"), join(work, "freeroute.py"))
	copyFileSync(jar, join(work, "freerouting.jar"))
	const v = ["-v", mount(work, "/w"), "-w", "/w"]
	const r = ROUTE
	const wide = [...widths].filter(([, w]) => w > r.trackMm)
	if (wide.length) writeFileSync(join(work, "widths.json"), JSON.stringify(Object.fromEntries(wide)))
	const dsn = await docker([...v, KICAD_IMAGE, "python3", "freeroute.py", "dsn", pcbRel, "board.dsn", ...[r.trackMm, r.clearanceMm, r.viaMm, r.drillMm, r.edgeMm].map(String)], 180_000)
	if (dsn.code !== 0 || !existsSync(join(work, "board.dsn"))) return `DSN export failed: ${tail(dsn)}`
	const fr = await docker([...v, JAVA_IMAGE, "java", "-jar", "freerouting.jar", "-de", "board.dsn", "-do", "board.ses", "--gui.enabled=false", "-mp", String(r.passes)], 900_000)
	if (fr.code !== 0 || !existsSync(join(work, "board.ses"))) return `Freerouting failed: ${tail(fr)}`
	// Its count: "incomplete connections: N" while routing, "the board has N unrouted connection(s)" when it stops short
	// (Freerouting 2.5, the arm board, 26 Nov 2026).
	const last = [...(fr.stdout + fr.stderr).matchAll(/incomplete connections: (\d+)|the board has (\d+) unrouted connection/g)].map((m) => [m[0], m[1] ?? m[2]]).at(-1)
	const incomplete = last ? Number(last[1]) : NaN
	const ses = await docker([...v, KICAD_IMAGE, "python3", "freeroute.py", "ses", pcbRel, "board.ses", pcbRel, ...(wide.length ? ["widths.json", String(r.clearanceMm), String(r.edgeMm)] : [])], 300_000)
	if (ses.code !== 0) return `SES import failed: ${tail(ses)}`
	// Its whole output beside the board (freerouting.log), and its last lines in the reason when it gave no count.
	writeFileSync(join(work, "freerouting.log"), fr.stdout + "\n" + fr.stderr)
	return incomplete === 0 ? null : Number.isNaN(incomplete) ? `Freerouting gave no count of unrouted connections; its last lines: ${(fr.stdout + "\n" + fr.stderr).trim().split("\n").slice(-4).join(" | ")}` : `Freerouting left ${incomplete} connection(s) unrouted`
}

const tail = (r: RunResult) => (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")
