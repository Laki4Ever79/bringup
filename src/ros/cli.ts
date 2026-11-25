import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ChassisSpec } from "../tools/chassis.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { writeRosPackage } from "./package.ts"
import { rosImageReady, runRosAcceptance, ROS_IMAGE } from "./run.ts"
import { prepareFirmware } from "../tools/firmware.ts"
import { loadRules } from "../rules/eurobot.ts"
import type { Arena } from "./nav2.ts"
import { provisionFiles, writeProvision } from "./provision.ts"
import { rosPackageName } from "./package.ts"

// One command for a finished robot's ROS 2 side (docs/ros.md):
//   npm run ros -- <run dir>                         the package, tested on mock hardware and the firmware in QEMU
//   npm run ros -- <run dir> --port /dev/ttyACM0     the same test on the real robot, over its USB serial port
//   npm run ros -- <run dir> --nav                   and then one Nav2 goal from the design's start (step 2)
//   npm run ros -- <run dir> --workspace <dir>       only write the colcon workspace (for the robot's own computer)
//   npm run ros -- <run dir> --pi5 <dir> [--ssh-key <file.pub>] [--hostname <name>] [--wifi-ssid <ssid>] [--no-nav]
//                                                    a Raspberry Pi 5's first-boot setup (cloud-init user-data): ROS 2
//                                                    Jazzy, the workspace built, the robot and Nav2 started at boot;
//                                                    the Wi-Fi password from BRINGUP_WIFI_PASSWORD
// The package is written fresh from the run's last chassis spec with this checkout's generator and bridge, so an older
// run gets today's ROS side. The firmware too, from the run's contract with this checkout's template, so the bridge
// and the firmware speak the same report: a 22 Nov run's saved firmware sent no gyro heading, and its ROS turn check
// read 0 rad (25 Nov 2026). Without a contract, the run's saved firmware.
const usage = "usage: npm run ros -- <run dir> [--port /dev/ttyACM0 | --workspace <dir> | --pi5 <dir> [--ssh-key <file.pub>] [--hostname <name>] [--wifi-ssid <ssid>] [--no-nav]]"
const VALUED = ["--port", "--workspace", "--pi5", "--ssh-key", "--hostname", "--wifi-ssid"]

const lastRev = (dir: string): string | null => {
	if (!existsSync(dir)) return null
	const revs = readdirSync(dir).filter((d) => /^rev-\d+$/.test(d)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
	return revs.length ? join(dir, revs[revs.length - 1]) : null
}

// A competition robot's table (motion.rules -> catalog/rules/<id>.json limits.table), for its Nav2 map.
export function arenaOf(root: string, contract: ContractSnapshot | undefined): Arena | undefined {
	const id = (contract?.values.motion as { rules?: string } | undefined)?.rules
	const t = id ? loadRules(root, id)?.limits.table : undefined
	return t ? { sizeMm: t.value, wallMm: t.wallMm, source: t.source.where } : undefined
}

export function rosWorkspace(root: string, run: string, ws: string): { spec: ChassisSpec; contract?: ContractSnapshot; fw: string | null } {
	const chassis = lastRev(join(run, "chassis"))
	if (!chassis || !existsSync(join(chassis, "spec.json"))) throw new Error(`${run} has no chassis build (chassis/rev-*/spec.json): is it a robot's run?`)
	const spec = JSON.parse(readFileSync(join(chassis, "spec.json"), "utf8")) as ChassisSpec
	const contract = existsSync(join(run, "contract.json")) ? (JSON.parse(readFileSync(join(run, "contract.json"), "utf8")) as ContractSnapshot) : undefined
	rmSync(join(ws, "src"), { recursive: true, force: true })
	mkdirSync(join(ws, "src"), { recursive: true })
	const arena = arenaOf(root, contract)
	writeRosPackage(join(ws, "src"), spec, { robot: "rover", ...(contract ? { revision: contract.revision } : {}), ...(arena ? { arena } : {}) })
	cpSync(join(root, "templates", "ros", "bringup_hardware"), join(ws, "src", "bringup_hardware"), { recursive: true })
	const drive = lastRev(join(run, "drive"))
	return { spec, contract, fw: drive && existsSync(join(drive, "fw")) ? join(drive, "fw") : null }
}

export async function rosCli(argv: string[], root = process.cwd()): Promise<number> {
	const run = argv.find((a, i) => !a.startsWith("--") && !VALUED.includes(argv[i - 1]))
	const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
	if (!run || !existsSync(run)) {
		console.error(usage)
		return 2
	}
	const port = opt("--port"), only = opt("--workspace"), pi5 = opt("--pi5")
	const out = join(resolve(run), "ros")
	const ws = only ? resolve(only) : join(out, "ws")
	const { spec, contract, fw } = rosWorkspace(root, resolve(run), ws)
	if (pi5) {
		const ssid = opt("--wifi-ssid"), key = opt("--ssh-key")
		if (ssid && !process.env.BRINGUP_WIFI_PASSWORD) {
			console.error("[ros] --wifi-ssid needs the password in BRINGUP_WIFI_PASSWORD (kept off the command line)")
			return 2
		}
		const files = provisionFiles(ws, rosPackageName("rover"), contract, {
			...(opt("--hostname") ? { hostname: opt("--hostname")! } : {}),
			...(key ? { sshKey: readFileSync(resolve(key), "utf8") } : {}),
			...(ssid ? { wifi: { ssid, password: process.env.BRINGUP_WIFI_PASSWORD! } } : {}),
			nav: !argv.includes("--no-nav"),
			...(contract ? { revision: contract.revision } : {}),
		})
		writeProvision(resolve(pi5), files)
		console.log(`[ros] Raspberry Pi 5 setup: ${resolve(pi5)} (${Object.keys(files).join(", ")}); see its README.md`)
		return 0
	}
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
	const fresh = !!(contract?.values.mechanics && contract.values.motion)
	const backends = port ? (["real"] as const) : (fw || fresh) && python && pio ? (["mock", "qemu"] as const) : (["mock"] as const)
	let pass = true
	for (const backend of backends) {
		let fwDir: string | undefined
		if (backend === "qemu") {
			fwDir = join(out, "fw")
			rmSync(fwDir, { recursive: true, force: true })
			if (fresh) await prepareFirmware(root, fwDir, contract!)
			else cpSync(fw!, fwDir, { recursive: true, filter: (src) => !src.includes("/.pio/") })
		}
		const r = await runRosAcceptance({ root, wsDir: ws, outDir: join(out, "accept"), backend, ...(argv.includes("--nav") ? { nav: true } : {}), ...(port ? { device: port } : {}), spec, ...(contract ? { contract } : {}), ...(fwDir ? { fwDir, python, pio } : {}) })
		pass &&= r.pass
		console.log(`[ros] ${backend}: ${r.pass ? "PASS" : "FAIL"}${r.bag ? ` (bag: ${r.bag})` : ""}`)
		for (const c of r.checks) console.log(`      ${c.pass ? "pass" : "FAIL"}  ${c.name}: measured ${JSON.stringify(c.measured)}, expected ${JSON.stringify(c.expected)}`)
		for (const d of r.diagnoses ?? []) console.log(`      symptom: ${d.symptom}; cause (${d.confidence}): ${d.cause}; fix: ${d.fix}`)
		if (!r.pass && !r.checks.length) console.log(r.log)
	}
	return pass ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) rosCli(process.argv.slice(2)).then((c) => process.exit(c))
