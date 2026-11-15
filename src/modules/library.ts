import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Artifacts } from "../contract/consistency.ts"
import type { ContractValues } from "../contract/types.ts"
import { byMpn, loadMechCatalog, type MechCatalog } from "../mechanics/catalog.ts"
import { loadCatalog } from "../tools/parts-search.ts"

// The robot module library (docs/design/module-library.md): proven blocks a robot is built from, each with the
// evidence that it works. A module names its parts (catalog MPNs), its circuit and its driver; the evidence grows with
// every run that uses it. Borrowed idea (Diode's proven blocks), our own data and code.

export interface ModulePart {
	mpn: string
	role: string
	qty: number
	// Catalog parts that do the same job: a design using one of them still uses the module.
	alternatives?: string[]
}
export interface Module {
	id: string
	kind: string
	title: string
	parts: ModulePart[]
	circuit: string
	driver?: string
	interfaces: { kind: string; signals: string[]; address?: string }[]
}

// How strongly a module has been shown to work, weakest first (docs/design/module-library.md).
export const LEVELS = ["cited", "built", "tested", "simulated", "bench", "fielded"] as const
export type Level = (typeof LEVELS)[number]

export interface Evidence {
	at: string
	module: string
	level: Level
	result: "pass" | "fail"
	by: "catalog" | "build" | "host-test" | "simulation" | "bench" | "field"
	run?: string
	revision?: number
	note?: string
	// Measured against expected, for bench evidence: { stallA: { value, unit, expected, tolerance } }.
	measured?: Record<string, { value: number; unit: string; expected: number; tolerance: number }>
}

export function loadModules(root: string): Module[] {
	const dir = join(root, "catalog", "modules")
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Module)
}

// Why a module isn't cited (level 0): a part no catalog has, or a bought mechanical part with an uncited number.
export function moduleProblems(m: Module, mech: MechCatalog, boardMpns: Set<string>): string[] {
	const problems: string[] = []
	const mechParts = [...mech.motors, ...mech.wheels, ...mech.casters, ...mech.batteries, ...(mech.sensors ?? [])]
	for (const p of m.parts)
		for (const mpn of [p.mpn, ...(p.alternatives ?? [])]) {
			const bought = byMpn(mechParts, mpn)
			if (bought) {
				const numeric = Object.entries(bought).filter(([k, v]) => k !== "source" && (typeof v === "number" || (Array.isArray(v) && v.every((x) => typeof x === "number" || (Array.isArray(x) && x.every((y) => typeof y === "number")))))).map(([k]) => k)
				const uncited = numeric.filter((k) => !bought.source?.[k])
				if (uncited.length) problems.push(`${mpn}: ${uncited.join(", ")} have no source`)
			} else if (!boardMpns.has(mpn)) problems.push(`${mpn} is in no catalog (catalog/parts.json, catalog/learned/ or catalog/mechanics.json)`)
		}
	return problems
}

// The MPNs a design uses: its board parts and its bought mechanical parts.
function designMpns(v: Partial<ContractValues>): string[] {
	const m = v.mechanics
	return [...(v.parts ?? []).map((p) => p.mpn), ...(m ? [m.drive.motor, m.drive.wheel, m.drive.caster, m.battery.pack, m.sensor?.module ?? ""] : [])].filter(Boolean)
}

// The modules a design uses: every part of the module (or one of its alternatives) is in the design.
export function modulesUsed(modules: Module[], v: Partial<ContractValues>): Module[] {
	const have = designMpns(v)
	const has = (mpn: string) => have.some((x) => x === mpn || x.split(" ")[0] === mpn.split(" ")[0])
	return modules.filter((m) => m.parts.every((p) => [p.mpn, ...(p.alternatives ?? [])].some(has)))
}

// What a finished run shows about each module it used. Built: the board passed DRC and the firmware compiled. Tested:
// the generated drivers passed their host tests. Simulated: the rover's own firmware passed the simulated drive (every
// module of the robot took part). Only what was shown is recorded: a step that didn't run records nothing.
// failures: the builds that failed at the run's last revision (state.artifactFailures). A board that failed there is a
// "built" fail with its error, never a pass from an older board the run still holds (a scripted rover, 15 Nov: the last
// board build failed on trace length and the module was recorded as built from the board before it).
export function runEvidence(used: Module[], a: Artifacts, run: string, revision: number, at = new Date().toISOString(), failures: Partial<Record<string, string>> = {}): Evidence[] {
	const out: Evidence[] = []
	const add = (m: Module, level: Level, by: Evidence["by"], result: "pass" | "fail", note: string) => out.push({ at, module: m.id, level, result, by, run, revision, note })
	const drcOk = a.board?.drc ? a.board.drc.errors === 0 && a.board.drc.unconnected === 0 : undefined
	const buildFailed = failures.board ?? failures.firmware
	for (const m of used) {
		if (buildFailed) {
			add(m, "built", "build", "fail", `the last ${failures.board ? "board" : "firmware"} build failed: ${buildFailed.split("\n").slice(0, 3).join(" ")}`)
		} else if (a.board && a.firmware && drcOk !== undefined) {
			const ok = drcOk && a.firmware.ok
			add(m, "built", "build", ok ? "pass" : "fail", ok ? "board DRC clean, firmware compiled" : `${drcOk ? "" : `board DRC: ${a.board.drc!.errors} errors, ${a.board.drc!.unconnected} unconnected`}${!drcOk && !a.firmware.ok ? "; " : ""}${a.firmware.ok ? "" : "firmware does not compile"}`)
		}
		const t = a.firmware?.driverTests
		if (m.driver && t && t.ok !== null) {
			const name = m.driver.split("/").pop()!.replace(/\.h$/, "")
			if (t.drivers.some((d) => d.includes(name))) {
				const failed = t.failed.filter((f) => f.name.includes(name))
				add(m, "tested", "host-test", failed.length ? "fail" : "pass", failed.length ? failed.map((f) => `${f.name}: ${f.message}`).join("; ") : `${name} host tests pass`)
			}
		}
		if (a.drive && a.drive.result !== "not run") add(m, "simulated", "simulation", a.drive.result, a.drive.result === "pass" ? "the rover's own firmware passed every segment of the simulated drive" : `simulated drive failed: ${a.drive.reason}`)
	}
	return out
}

// Where evidence is kept: one file per module, machine-wide like the spend ledger (BRINGUP_MODULES_DIR, else
// ~/.bringup/modules), so every run on this machine adds to it; tests point it at a temp dir.
export const evidenceDir = (env: NodeJS.ProcessEnv = process.env) => env.BRINGUP_MODULES_DIR ?? join(homedir(), ".bringup", "modules")

export function appendEvidence(records: Evidence[], dir = evidenceDir()): void {
	if (!records.length) return
	mkdirSync(dir, { recursive: true })
	for (const r of records) appendFileSync(join(dir, `${r.module}.jsonl`), `${JSON.stringify(r)}\n`)
}

export function readEvidence(id: string, dir = evidenceDir()): Evidence[] {
	const f = join(dir, `${id}.jsonl`)
	if (!existsSync(f)) return []
	return readFileSync(f, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Evidence)
}

// A module's level: the highest level whose latest evidence is a pass, with every level below it shown too (a module
// can't be "simulated" without being "built"). Level "cited" needs no evidence, only no catalog problems.
export function levelOf(evidence: Evidence[], cited: boolean): Level | null {
	if (!cited) return null
	let level: Level = "cited"
	for (const l of LEVELS.slice(1)) {
		const latest = evidence.filter((e) => e.level === l).at(-1)
		if (!latest) {
			// "tested" is skipped for a module without a driver, and "bench"/"fielded" only come later: a gap doesn't
			// stop a higher level the module has shown.
			continue
		}
		if (latest.result !== "pass") break
		level = l
	}
	return level
}

export interface ModuleStatus {
	module: Module
	level: Level | null
	problems: string[]
	runs: number
	passes: number
	fails: number
	last?: string
}

export function moduleStatus(root: string, dir = evidenceDir()): ModuleStatus[] {
	const mech = loadMechCatalog(root)
	const boardMpns = new Set(loadCatalog(root).map((p) => p.mpn))
	return loadModules(root).map((m) => {
		const problems = moduleProblems(m, mech, boardMpns)
		const ev = readEvidence(m.id, dir)
		return { module: m, level: levelOf(ev, problems.length === 0), problems, runs: new Set(ev.map((e) => e.run)).size, passes: ev.filter((e) => e.result === "pass").length, fails: ev.filter((e) => e.result === "fail").length, last: ev.at(-1)?.at }
	})
}

// After a run: record what it showed for the modules it used. Never fails a run.
export function recordRun(root: string, v: Partial<ContractValues>, a: Artifacts, run: string, revision: number, dir = evidenceDir(), failures: Partial<Record<string, string>> = {}): Evidence[] {
	try {
		const records = runEvidence(modulesUsed(loadModules(root), v), a, run, revision, undefined, failures)
		appendEvidence(records, dir)
		return records
	} catch (error) {
		console.error("[modules] evidence not recorded:", error)
		return []
	}
}
