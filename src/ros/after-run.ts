import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Artifacts } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import type { ChassisSpec } from "../tools/chassis.ts"
import type { Env } from "../tools/env.ts"
import { rosImageReady, runRosAcceptance, type RosAcceptance } from "./run.ts"

// After a robot's run settles (docs/ros.md): its ROS 2 package, the one generated with its last chassis, is tested
// with its own acceptance test on mock hardware and on its own firmware in QEMU turning MuJoCo, each recorded as an
// MCAP bag and traced for symptoms. Results in <out>/ros/: ros.json for the run page. Best effort, never fails a run;
// off without the ROS image (docker build -t bringup-ros:jazzy docker/ros), in the test suite, or with BRINGUP_NO_ROS.
export async function rosAfterRun(env: Env, outDir: string, s: ContractSnapshot, a: Artifacts): Promise<{ results: RosAcceptance[]; package: string } | null> {
	if (process.env.NODE_TEST_CONTEXT || process.env.BRINGUP_NO_ROS || !a.chassis || !s.values.mechanics) return null
	const pkgSrc = join(a.chassis.dir, "ros", "src")
	const specPath = join(a.chassis.dir, "spec.json")
	if (!existsSync(pkgSrc) || !existsSync(specPath) || !rosImageReady()) return null
	try {
		const spec = JSON.parse(readFileSync(specPath, "utf8")) as ChassisSpec
		const ros = join(outDir, "ros")
		rmSync(join(ros, "ws"), { recursive: true, force: true })
		cpSync(pkgSrc, join(ros, "ws", "src"), { recursive: true })
		const results: RosAcceptance[] = []
		results.push(await runRosAcceptance({ root: env.root, wsDir: join(ros, "ws"), outDir: join(ros, "accept"), backend: "mock", spec, contract: s }))
		// The drive's firmware, copied: the ROS test build (motors off until ROS commands them) mustn't touch the drive's.
		const driveFw = a.drive && a.drive.result !== "not run" ? join(a.drive.dir, "fw") : null
		const fw = driveFw && existsSync(driveFw) ? join(ros, "fw") : null
		if (fw) {
			rmSync(fw, { recursive: true, force: true })
			cpSync(driveFw!, fw, { recursive: true, filter: (src) => !src.includes("/.pio/") })
		}
		if (fw && env.python && env.pio)
			results.push(await runRosAcceptance({ root: env.root, wsDir: join(ros, "ws"), outDir: join(ros, "accept"), backend: "qemu", spec, contract: s, fwDir: fw, python: env.python, pio: env.pio }))
		const summary = { revision: a.chassis.revision, package: "ws/src", results: results.map(({ log, ...r }) => (r.pass ? r : { ...r, log })) }
		writeFileSync(join(ros, "ros.json"), JSON.stringify(summary, null, 1))
		return { results, package: join(ros, "ws", "src") }
	} catch (e) {
		console.error("[ros] acceptance not run:", e)
		return null
	}
}
