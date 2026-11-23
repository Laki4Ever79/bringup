import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { RosAcceptance } from "./run.ts"

// The report's ROS 2 section (a robot only): the generated package, and its acceptance test on each back end with the
// symptoms traced to the design (src/ros/after-run.ts writes ros/ros.json).
export function rosSection(outDir: string): string[] {
	const f = join(outDir, "ros", "ros.json")
	if (!existsSync(f)) return []
	const r = JSON.parse(readFileSync(f, "utf8")) as { revision: number; results: Omit<RosAcceptance, "log">[] }
	const name = { mock: "mock hardware (commands mirrored back)", qemu: "the robot's own firmware in QEMU, turning the MuJoCo model", real: "the real robot over USB" }
	const lines = ["## ROS 2", "", `The robot's ROS 2 package (revision ${r.revision}) is in ros/ws/src: the URDF, the diff-drive controller's settings, a launch file and its acceptance test, all from the design. \`colcon build\` it in a Jazzy workspace; \`ros2 launch rover_bringup bringup.launch.py hardware:=bringup port:=/dev/ttyACM0\` drives the real robot over USB (\`npm run ros -- <run> --port /dev/ttyACM0\` does it and runs the acceptance; docs/ros.md).`, ""]
	for (const x of r.results) {
		lines.push(`Acceptance on ${name[x.backend]}: **${x.pass ? "pass" : "FAIL"}**${x.bag ? ` (recorded: ros/accept/bag-${x.backend})` : ""}`)
		for (const c of x.checks) lines.push(`- ${c.name}: ${c.pass ? "pass" : "FAIL"} (measured ${JSON.stringify(c.measured)}, expected ${JSON.stringify(c.expected)})`)
		for (const d of x.diagnoses ?? []) lines.push(`- Symptom: ${d.symptom}. Cause (${d.confidence}): ${d.cause}. Fix: ${d.fix} (${d.affects.join(", ")})`)
		lines.push("")
	}
	return lines
}
