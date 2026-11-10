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
	else
		lines.push(
			"| Check | Computed | Limit | | How |",
			"|---|---|---|---|---|",
			...figures.map((f) => `| ${f.check} | ${f.value} | ${f.limit} | ${f.ok ? "ok" : "**FAILS**"} | ${f.note ?? ""} |`),
			"",
			`Estimates (no datasheet states these; the bench test measures the motor's): ${Object.entries(ESTIMATES).map(([k, e]) => `${k} ${e.value}`).join(", ")}.`,
			"",
		)
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
