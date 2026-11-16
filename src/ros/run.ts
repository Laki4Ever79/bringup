import { spawn, spawnSync } from "node:child_process"
import { mount } from "../tools/mount.ts"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ChassisSpec } from "../tools/chassis.ts"
import { runDrive, type DriveArtifact } from "../tools/drive.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { bagStats, diagnose, type Diagnosis } from "./diagnose.ts"

// Runs a robot's generated acceptance test (src/ros/acceptance.ts) in the Bringup ROS image (docker/ros), against one
// back end, and records the run as an MCAP bag beside the result:
//   mock: mock_components (commands mirrored back): the wiring, the limits, the controllers' settings;
//   qemu: the robot's own firmware in QEMU, its console on TCP for ROS, its UART1 turning the MuJoCo model.
// The ROS side is the same in both; only the URDF's hardware differs (hardware:=mock / bringup).
export const ROS_IMAGE = "bringup-ros:jazzy"
export const CONSOLE_PORT = 5555

export interface RosAcceptance {
	backend: "mock" | "qemu"
	pass: boolean
	checks: { name: string; pass: boolean; measured: unknown; expected: unknown }[]
	bag?: string
	drive?: Pick<DriveArtifact, "result" | "reason">
	// The run's symptoms traced to the design (src/ros/diagnose.ts), from the bag's topic rates and the speed reached.
	diagnoses?: Diagnosis[]
	log: string
}

const SCRIPT = (hardware: string, robot: string, outName: string) => `#!/bin/bash
source /opt/ros/jazzy/setup.bash
cd /ws && colcon build --event-handlers console_direct- > /out/colcon-${outName}.log 2>&1 || { echo "COLCON FAILED"; exit 3; }
source /ws/install/setup.bash
export ROS_DOMAIN_ID=$((RANDOM % 100 + 100)) ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST
ros2 launch ${robot}_bringup bringup.launch.py hardware:=${hardware} > /out/launch-${outName}.log 2>&1 &
for i in $(seq 1 180); do ros2 control list_controllers 2>/dev/null | grep -q "diff_drive_controller.*active" && break; sleep 1; done
rm -rf /out/bag-${outName}
timeout -s INT 25 ros2 bag record -s mcap -o /out/bag-${outName} /cmd_vel /diff_drive_controller/odom /joint_states /range_sensor_broadcaster/range /tf > /out/bag-${outName}.log 2>&1 &
BAG=$!
sleep 2
python3 /ws/install/${robot}_bringup/share/${robot}_bringup/test/acceptance.py /out/acceptance-${outName}.json
CODE=$?
wait $BAG 2>/dev/null  # the recorder stops itself (SIGINT after 25 s) and writes its metadata
[ -f /out/bag-${outName}/metadata.yaml ] || ros2 bag reindex /out/bag-${outName} -s mcap > /dev/null 2>&1
exit $CODE
`

// No container outlives its run. Killing the docker client on a timeout left the container running: ROS acceptance
// shells (run-qemu.sh) were still up 30 h later (16 Nov 2026). So each run gets a name and three stops: a timeout inside
// the container (it ends itself even if this process is killed outright), docker kill when the time is up or the client
// exits early, and docker kill of whatever is still running when this process exits.
const running = new Set<string>()
let exitHook = false
export function containerArgs(args: string[], timeoutMs: number, name: string): string[] {
	if (args[0] !== "run") return args
	const at = args.indexOf(ROS_IMAGE)
	if (at < 0) return args
	const secs = Math.max(1, Math.ceil(timeoutMs / 1000))
	return ["run", "--name", name, "--stop-timeout", "5", ...args.slice(1, at + 1), "timeout", "-k", "10", String(secs), ...args.slice(at + 1)]
}
function killContainer(name: string): void {
	spawnSync("docker", ["kill", name], { stdio: "ignore", timeout: 30_000 })
	running.delete(name)
}
function docker(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
	const name = `bringup-ros-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
	const full = containerArgs(args, timeoutMs, name)
	const named = full !== args
	if (named) {
		running.add(name)
		if (!exitHook) {
			exitHook = true
			process.on("exit", () => { for (const n of running) spawnSync("docker", ["kill", n], { stdio: "ignore", timeout: 10_000 }) })
		}
	}
	return new Promise((res) => {
		const p = spawn("docker", full, { stdio: ["ignore", "pipe", "pipe"] })
		let out = ""
		p.stdout.on("data", (d) => (out += d))
		p.stderr.on("data", (d) => (out += d))
		const t = setTimeout(() => {
			p.kill("SIGKILL")
			if (named) killContainer(name)
			res({ code: null, out })
		}, timeoutMs)
		p.on("close", (code) => {
			clearTimeout(t)
			// --rm removes it once it stops; one still running (the client died early) is stopped here.
			if (named) killContainer(name)
			res({ code, out })
		})
	})
}

export function rosImageReady(): boolean {
	return spawnSync("docker", ["image", "inspect", ROS_IMAGE], { stdio: "ignore" }).status === 0
}

export async function runRosAcceptance(o: { root: string; wsDir: string; outDir: string; backend: "mock" | "qemu"; robot?: string; spec?: ChassisSpec; contract?: ContractSnapshot; fwDir?: string; python?: string; pio?: string }): Promise<RosAcceptance> {
	const robot = o.robot ?? "rover"
	const ws = resolve(o.wsDir), out = resolve(o.outDir)
	mkdirSync(out, { recursive: true })
	const fail = (log: string): RosAcceptance => ({ backend: o.backend, pass: false, checks: [], log })
	if (!rosImageReady()) return fail(`the ROS image ${ROS_IMAGE} is not built (docker build -t ${ROS_IMAGE} docker/ros)`)
	const script = join(out, `run-${o.backend}.sh`)
	writeFileSync(script, SCRIPT(o.backend === "mock" ? "mock" : "bringup", robot, o.backend), { mode: 0o755 })
	// Build the workspace first, so the firmware's simulated time isn't spent waiting for colcon.
	const built = await docker(["run", "--rm", "-u", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "-e", "HOME=/tmp", "-v", mount(ws, "/ws"), "-w", "/ws", ROS_IMAGE, "bash", "-c", "source /opt/ros/jazzy/setup.bash && colcon build --event-handlers console_direct-"], 600_000)
	if (built.code !== 0) return fail(`colcon build failed: ${built.out.split("\n").slice(-10).join("\n")}`)
	let drive: Promise<DriveArtifact> | undefined
	let rosEnded: () => void = () => {}
	const rosDone = new Promise<void>((r) => (rosEnded = r))
	if (o.backend === "qemu") {
		if (!o.spec || !o.fwDir || !o.python || !o.pio) return fail("the qemu back end needs the chassis spec, the firmware folder, python and pio")
		// The firmware builds, then boots in QEMU and serves its console; the physics runs as long as the test may take.
		// ROS starts once the console takes a connection, not after a fixed wait: the build alone took longer than the
		// 20 s it used to wait under load, and ROS then found no console and got no odometry (mock rover runs, 16 Nov).
		let ready: () => void = () => {}
		const consoleUp = new Promise<void>((r) => (ready = r))
		// The physics runs until the ROS test is done (until: rosDone), not for a set number of simulated seconds: an idle
		// machine ran the 90 s it used to get in 29 s of wall time, before ROS was up (a mock rover, 16 Nov 03:22: the
		// controllers came up at :08, the physics stopped at :13, the acceptance read no odometry and no range).
		drive = runDrive({ root: o.root, python: o.python, pio: o.pio, fwDir: o.fwDir, spec: o.spec, outDir: join(out, "drive-qemu"), courseS: 3600, consolePort: CONSOLE_PORT, timeoutMs: 600_000, buildFlags: "-DROVER_HOST_ONLY", onConsoleReady: () => ready(), until: rosDone })
		const early = await Promise.race([consoleUp.then(() => null), drive])
		if (early) return { ...fail(`the firmware's console never came up: ${early.reason}`), drive: { result: early.result, reason: early.reason } }
	}
	const r = await docker(["run", "--rm", "--network", "host", "-u", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "-e", "HOME=/tmp", "-v", mount(ws, "/ws"), "-v", mount(out, "/out"), ROS_IMAGE, `/out/run-${o.backend}.sh`], 300_000)
	rosEnded()
	const d = drive ? await drive : undefined
	const file = join(out, `acceptance-${o.backend}.json`)
	if (!existsSync(file)) return { ...fail(r.out.split("\n").slice(-15).join("\n")), ...(d ? { drive: { result: d.result, reason: d.reason } } : {}) }
	const res = JSON.parse(readFileSync(file, "utf8")) as { pass: boolean; checks: RosAcceptance["checks"] }
	// The bag's rates and the speed reached, against what the design promises.
	let diagnoses: Diagnosis[] | undefined
	if (o.spec && o.contract) {
		const info = await docker(["run", "--rm", "-v", mount(out, "/out"), ROS_IMAGE, "bash", "-c", `source /opt/ros/jazzy/setup.bash && ros2 bag info /out/bag-${o.backend}`], 60_000)
		const achieved = d && d.result !== "not run" ? d.topSpeedMps : undefined
		diagnoses = diagnose(o.spec, o.contract, { topics: bagStats(info.out), ...(achieved !== undefined ? { achievedSpeedMps: achieved, commandedSpeedMps: o.spec.speedMps } : {}) })
		writeFileSync(join(out, `diagnoses-${o.backend}.json`), JSON.stringify(diagnoses, null, 1))
	}
	return { backend: o.backend, pass: res.pass, checks: res.checks, bag: join(out, `bag-${o.backend}`), ...(d ? { drive: { result: d.result, reason: d.reason } } : {}), ...(diagnoses ? { diagnoses } : {}), log: r.out.split("\n").slice(-5).join("\n") }
}
