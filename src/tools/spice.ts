import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { dropoutOhms, powerDeck, QUIESCENT_A, railId, type PowerScenario } from "../codegen/spice.ts"
import type { ContractSnapshot } from "../contract/types.ts"

const exec = promisify(execFile)

const TIMEOUT_MS = 120_000
const STDERR_TAIL_LINES = 40
const IMAGE = "kicad/kicad:10.0"
const VOUT_TOLERANCE = 0.03

// USB power, then a Li-ion cell nominal and near empty.
export const POWER_SCENARIOS: PowerScenario[] = [
	{ name: "vbus-5v0", vinV: 5 },
	{ name: "liion-3v7", vinV: 3.7 },
	{ name: "liion-3v5", vinV: 3.5 },
]

export interface PowerReport {
	scenarios: { name: string; rail: string; vinV: number; voutV: number; headroomMv: number; dissipationMw: number; ok: boolean }[]
}

function tail(text: string): string {
	return text.trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n")
}

export function parseMeasurements(log: string): Record<string, number> {
	const out: Record<string, number> = {}
	for (const m of log.matchAll(/^(\w+)\s+=\s+([-+\d.eE]+)/gm)) out[m[1]] = Number(m[2])
	return out
}

// Writes one deck per scenario under dir, runs them all in one ngspice container and reads the .meas results back.
// root is unused for now; it keeps the signature in line with the other tools.
export async function simulatePower(root: string, dir: string, s: ContractSnapshot, scenarios = POWER_SCENARIOS): Promise<PowerReport> {
	void root
	await mkdir(dir, { recursive: true })
	for (const sc of scenarios) await writeFile(join(dir, `${sc.name}.cir`), powerDeck(s, sc))
	const script = 'for f in *.cir; do ngspice -b "$f" -o "${f%.cir}.log" || exit 1; done'
	const uid = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`
	try {
		await exec("docker", ["run", "--rm", "-u", uid, "-e", "HOME=/tmp", "-v", `${dir}:/w`, "-w", "/w", IMAGE, "sh", "-c", script], { timeout: TIMEOUT_MS })
	} catch (e) {
		const err = e as { stderr?: string; killed?: boolean; message: string }
		const why = err.killed ? `timed out after ${TIMEOUT_MS / 1000} s` : "failed"
		throw new Error(`power simulation ${why}: ${tail(err.stderr ?? "") || err.message}`)
	}

	const report: PowerReport = { scenarios: [] }
	for (const sc of scenarios) {
		const log = await readFile(join(dir, `${sc.name}.log`), "utf8")
		const meas = parseMeasurements(log)
		for (const rail of s.values.rails ?? []) {
			const id = railId(rail)
			const voutV = meas[`vout_${id}`]
			const ioutA = meas[`iout_${id}`]
			if (voutV === undefined || ioutA === undefined) throw new Error(`power simulation: no result for rail ${rail.name} in ${sc.name}:\n${tail(log)}`)
			report.scenarios.push({
				name: sc.name,
				rail: rail.name,
				vinV: sc.vinV,
				voutV,
				// Margin above dropout; negative means the rail has fallen out of regulation.
				headroomMv: Math.round((sc.vinV - rail.voltageV - ioutA * dropoutOhms(rail)) * 1000),
				dissipationMw: Math.round(((sc.vinV - voutV) * ioutA + sc.vinV * QUIESCENT_A) * 1000),
				ok: Math.abs(voutV - rail.voltageV) <= rail.voltageV * VOUT_TOLERANCE,
			})
		}
	}
	return report
}
