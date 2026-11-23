import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ChassisSpec } from "../tools/chassis.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { writeRosPackage } from "./package.ts"
import { rosImageReady, runRosAcceptance, ROS_IMAGE } from "./run.ts"

// One command for a finished robot's ROS 2 side (docs/ros.md):
//   npm run ros -- <run dir>                         the package, tested on mock hardware and the firmware in QEMU
//   npm run ros -- <run dir> --port /dev/ttyACM0     the same test on the real robot, over its USB serial port
//   npm run ros -- <run dir> --workspace <dir>       only write the colcon workspace (for the robot's own computer)
// The package is written fresh from the run's last chassis spec with this checkout's generator and bridge, so an older
// run gets today's ROS side; the firmware is the run's own.
const usage = "usage: npm run ros -- <run dir> [--port /dev/ttyACM0 | --workspace <dir>]"

const lastRev = (dir: string): string | null => {
	if (!existsSync(dir)) return null
	const revs = readdirSync(dir).filter((d) => /^rev-\d+$/.test(d)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
	return revs.length ? join(dir, revs[revs.length - 1]) : null
}

export function rosWorkspace(root: string, run: string, ws: string): { spec: ChassisSpec; contract?: ContractSnapshot; fw: string | null } {
	const chassis = lastRev(join(run, "chassis"))
	if (!chassis || !existsSync(join(chassis, "spec.json"))) throw new Error(`${run} has no chassis build (chassis/rev-*/spec.json): is it a robot's run?`)
	const spec = JSON.parse(readFileSync(join(chassis, "spec.json"), "utf8")) as ChassisSpec
	const contract = existsSync(join(run, "contract.json")) ? (JSON.parse(readFileSync(join(run, "contract.json"), "utf8")) as ContractSnapshot) : undefined
	rmSync(join(ws, "src"), { recursive: true, force: true })
	mkdirSync(join(ws, "src"), { recursive: true })
	writeRosPackage(join(ws, "src"), spec, { robot: "rover", ...(contract ? { revision: contract.revision } : {}) })
	cpSync(join(root, "templates", "ros", "bringup_hardware"), join(ws, "src", "bringup_hardware"), { recursive: true })
	const drive = lastRev(join(run, "drive"))
	return { spec, contract, fw: drive && existsSync(join(drive, "fw")) ? join(drive, "fw") : null }
}

export async function rosCli(argv: string[], root = process.cwd()): Promise<number> {
	const run = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--port" && argv[argv.indexOf(a) - 1] !== "--workspace")
	const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
	if (!run || !existsSync(run)) {
		console.error(usage)
		return 2
	}
	const port = opt("--port"), only = opt("--workspace")
	const out = join(resolve(run), "ros")
	const ws = only ? resolve(only) : join(out, "ws")
	const { spec, contract, fw } = rosWorkspace(root, resolve(run), ws)
	console.log(`[ros] workspace: ${ws} (rover_bringup + bringup_hardware)`)
	if (only) {
		console.log(`[ros] on the robot's computer (Ubuntu 24.04 + ROS 2 Jazzy): colcon build, then\n      ros2 launch rover_bringup bringup.launch.py hardware:=bringup port:=/dev/ttyACM0`)
		return 0
	}
	if (!rosImageReady()) {
		console.error(`[ros] the ROS image isn't built: docker build -t ${ROS_IMAGE} docker/ros`)
		return 1
	}
	const am = (p: string) => (existsSync(join(root, p)) ? join(root, p) : undefined)
	const python = am(".venv/bin/python"), pio = am(".venv/bin/pio")
	const backends = port ? (["real"] as const) : fw && python && pio ? (["mock", "qemu"] as const) : (["mock"] as const)
	let pass = true
	for (const backend of backends) {
		let fwDir: string | undefined
		if (backend === "qemu") {
			fwDir = join(out, "fw")
			rmSync(fwDir, { recursive: true, force: true })
			cpSync(fw!, fwDir, { recursive: true, filter: (src) => !src.includes("/.pio/") })
		}
		const r = await runRosAcceptance({ root, wsDir: ws, outDir: join(out, "accept"), backend, ...(port ? { device: port } : {}), spec, ...(contract ? { contract } : {}), ...(fwDir ? { fwDir, python, pio } : {}) })
		pass &&= r.pass
		console.log(`[ros] ${backend}: ${r.pass ? "PASS" : "FAIL"}${r.bag ? ` (bag: ${r.bag})` : ""}`)
		for (const c of r.checks) console.log(`      ${c.pass ? "pass" : "FAIL"}  ${c.name}: measured ${JSON.stringify(c.measured)}, expected ${JSON.stringify(c.expected)}`)
		for (const d of r.diagnoses ?? []) console.log(`      symptom: ${d.symptom}; cause (${d.confidence}): ${d.cause}; fix: ${d.fix}`)
		if (!r.pass && !r.checks.length) console.log(r.log)
	}
	return pass ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) rosCli(process.argv.slice(2)).then((c) => process.exit(c))
