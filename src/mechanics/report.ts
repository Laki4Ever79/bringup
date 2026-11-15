import type { ContractSnapshot } from "../contract/types.ts"
import type { DriveArtifact } from "../tools/drive.ts"
import { mechanicsFigures } from "./checks.ts"
import { ESTIMATES } from "./estimates.ts"

// The report's Mechanics section (a robot only): the brief's targets against the computed values, from the same code
// as the checks; the estimates no datasheet gives; and whether the simulated drive proved it.
export function mechanicsSection(s: ContractSnapshot, drive: DriveArtifact | undefined): string[] {
	if (!s.values.motion) return []
	const figures = mechanicsFigures(s)
	const lines = ["## Mechanics", ""]
	if (figures.length === 0) lines.push("No complete mechanics design yet: nothing to compute.", "")
	else {
		// Each datasheet page once, numbered; a figure lists the numbers of the pages its values came from.
		const refs: { key: string; mpn: string; url: string; where: string; fields: Set<string> }[] = []
		const refOf = (x: { mpn: string; field: string; url: string; where: string }) => {
			const key = `${x.mpn}\u0000${x.url}\u0000${x.where}`
			let r = refs.find((y) => y.key === key)
			if (!r) refs.push((r = { key, mpn: x.mpn, url: x.url, where: x.where, fields: new Set() }))
			r.fields.add(x.field)
			return refs.indexOf(r) + 1
		}
		const cites = (f: (typeof figures)[number]) => [...new Set((f.sources ?? []).map(refOf))].map((n) => `[${n}]`).join(" ")
		lines.push(
			"| Check | Computed | Limit | | How | Sources |",
			"|---|---|---|---|---|---|",
			...figures.map((f) => `| ${f.check} | ${f.value} | ${f.limit} | ${f.ok ? "ok" : "**FAILS**"} | ${f.note ?? ""} | ${cites(f)} |`),
			"",
			"Datasheet sources:",
			...refs.map((r, i) => `${i + 1}. ${r.mpn}: ${[...r.fields].join(", ")} (${r.where}) ${r.url}`),
			"",
			`Estimates (no datasheet states these; the bench test measures the motor's): ${Object.entries(ESTIMATES).map(([k, e]) => `${k} ${e.value}`).join(", ")}.`,
			"",
		)
	}
	if (!drive || drive.result === "not run")
		lines.push(`Simulated drive: not proven in simulation${drive ? ` (${drive.reason})` : ""}.`, "")
	else
		lines.push(
			`Simulated drive: ${drive.result} (the rover's own firmware in QEMU driving the MuJoCo model, revision ${drive.revision}): ${drive.reason}.`,
			...drive.segments.map((g) => `- ${g.name}: ${g.pass ? "pass" : "FAIL"} (${g.detail})`),
			...(drive.peakA !== undefined ? [`- Peak motor current ${drive.peakA} A, top speed ${drive.topSpeedMps} m/s, closest to a wall ${drive.closestWallMm} mm; trajectory in ${drive.dir}/trajectory.json`] : []),
			"",
		)
	return lines
}
