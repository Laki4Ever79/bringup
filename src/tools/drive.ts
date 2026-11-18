import { spawn, spawnSync } from "node:child_process"
import { createConnection } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { mergeFlash } from "./emulator.ts"
import { qemuEnv } from "./env.ts"
import { qemuBaseArgs, qemuBinary, qemuTarget } from "./qemu.ts"
import { run } from "./exec.ts"
import type { ChassisSpec } from "./chassis.ts"

// Firmware in the loop (docs/mechanics.md): the rover's simulation build in QEMU, its UART1 on a local TCP port, and
// py/mech/drive.py stepping MuJoCo in lock-step with it over a course. Results: drive.json and trajectory.json.

export interface DriveSegment {
	name: string
	pass: boolean
	detail: string
}
export interface DriveArtifact {
	revision: number
	dir: string
	result: "pass" | "fail" | "not run"
	reason: string
	segments: DriveSegment[]
	peakA?: number
	topSpeedMps?: number
	closestWallMm?: number
	edgeMm?: number // the course's step height
	stub?: boolean
}

export interface DriveOptions {
	root: string
	python: string
	pio: string
	fwDir: string // a prepared rover firmware (prepareFirmware)
	spec: ChassisSpec
	outDir: string
	env?: string // the build QEMU runs (default: the machine's simulation build; a board build never answers: a test of "not run")
	machine?: string // the MCU profile's sim.machine (qemu.ts): esp32c3 (default) or esp32s3
	courseS?: number
	timeoutMs?: number
	// The firmware's console (UART0) on this TCP port instead of a log file: a ROS 2 host drives it in host mode
	// (docs/ros.md), while UART1 still turns the MuJoCo model.
	consolePort?: number
	// Extra compile flags for the simulation firmware (PLATFORMIO_BUILD_FLAGS), e.g. -DROVER_HOST_ONLY for a ROS test.
	buildFlags?: string
	// Called once the console's TCP port takes a connection (the firmware built and QEMU up): what a ROS host waits for.
	onConsoleReady?: () => void
	// Stops the drive when it settles: a ROS test's physics runs until the test is done, not for a set number of
	// simulated seconds (which an idle machine runs about 3x faster than real time).
	until?: Promise<unknown>
}

// Whether something listens on a local TCP port: a connection opened and closed at once (QEMU's console server takes
// a client again after one leaves).
export function portOpen(port: number): Promise<boolean> {
	return new Promise((res) => {
		const s = createConnection({ host: "127.0.0.1", port })
		const done = (ok: boolean) => { s.destroy(); res(ok) }
		s.once("connect", () => done(true))
		s.once("error", () => done(false))
		s.setTimeout(1000, () => done(false))
	})
}

// MuJoCo, from npm run setup -- --robotics: a .venv without it gets "not run", like a machine without QEMU.
function hasMujoco(python: string): boolean {
	return spawnSync(python, ["-c", "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('mujoco') else 1)"], { stdio: "ignore" }).status === 0
}

export async function runDrive(opts: DriveOptions, revision = 0): Promise<DriveArtifact> {
	// Absolute paths: the bridge runs from py/, so a relative --out dir would point elsewhere there.
	const o = { ...opts, root: resolve(opts.root), fwDir: resolve(opts.fwDir), outDir: resolve(opts.outDir) }
	mkdirSync(o.outDir, { recursive: true })
	const notRun = (reason: string): DriveArtifact => ({ revision, dir: o.outDir, result: "not run", reason, segments: [] })
	// The chip's QEMU (qemu.ts): riscv32 for the ESP32-C3, xtensa for the ESP32-S3.
	const target = qemuTarget(o.machine)
	if (!target) return notRun(`QEMU has no model of the ${o.machine} machine: not proven in simulation`)
	const qemu = qemuBinary(o.root, target)
	if (!qemu) return notRun(`QEMU for the ${target.machine} (${target.bin.split("/").pop()}) is not installed (npm run setup): not proven in simulation`)
	if (!hasMujoco(o.python)) return notRun("MuJoCo is not installed (npm run setup -- --robotics): not proven in simulation")
	const env = o.env ?? target.simEnv
	const build = await run(o.pio, ["run", "-d", o.fwDir, "-e", env], { timeoutMs: 900_000, ...(o.buildFlags ? { env: { ...(process.env as Record<string, string>), PLATFORMIO_BUILD_FLAGS: o.buildFlags } } : {}) })
	if (build.code !== 0) return notRun(`the simulation firmware didn't build: ${(build.stdout + build.stderr).trim().split("\n").slice(-3).join(" ")}`)
	const { image, log } = await mergeFlash(o.fwDir, env, target.chip)
	if (!image) return notRun(`no flash image: ${log.trim().split("\n").at(-1)}`)
	const specPath = join(o.outDir, "spec.json")
	writeFileSync(specPath, JSON.stringify(o.spec, null, 1))
	// The firmware's UART1 on a Unix socket in the run folder: a free TCP port, closed and then served by QEMU, could be
	// taken by another process in between (pending-fixes, 11 Nov); a path in our own folder can't. A socket path must
	// fit 108 bytes, so a deep run folder uses a fresh private temp folder instead (mkdtemp: unique, also race-free).
	const local = join(o.outDir, "uart1.sock")
	const sock = Buffer.byteLength(local) <= 100 ? local : join(mkdtempSync(join(tmpdir(), "bringup-drive-")), "uart1.sock")
	rmSync(sock, { force: true })
	const q = spawn(qemu, ["-display", "none", ...qemuBaseArgs(target, image), "-serial", o.consolePort ? `tcp:127.0.0.1:${o.consolePort},server=on,wait=off` : `file:${join(o.outDir, "uart0.txt")}`, "-serial", `unix:${sock},server=on,wait=on`], { stdio: "ignore", env: { ...process.env, ...qemuEnv(o.root) } })
	// The console is up once QEMU listens on it (polled; it stops when the drive ends).
	let ended = false
	if (o.consolePort && o.onConsoleReady)
		void (async () => {
			while (!ended) {
				if (await portOpen(o.consolePort!)) return o.onConsoleReady!()
				await new Promise((r) => setTimeout(r, 250))
			}
		})()
	try {
		const bridge = spawn(o.python, ["-B", join(o.root, "py/mech/drive.py"), specPath, sock, o.outDir, String(o.courseS ?? 25)], { cwd: join(o.root, "py"), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONPATH: join(o.root, "py") } })
		let stderr = ""
		bridge.stderr.on("data", (d) => (stderr += d))
		// A host's test that ends first asks the bridge to end the course (a "stop" file it checks); it writes its results.
		rmSync(join(o.outDir, "stop"), { force: true })
		void o.until?.then(() => writeFileSync(join(o.outDir, "stop"), ""))
		const code = await new Promise<number | null>((resolve) => {
			const timer = setTimeout(() => { bridge.kill("SIGKILL"); resolve(null) }, o.timeoutMs ?? 300_000)
			bridge.on("close", (c) => { clearTimeout(timer); resolve(c) })
		})
		const file = join(o.outDir, "drive.json")
		if (code === null) return notRun(`the drive didn't finish within ${Math.round((o.timeoutMs ?? 300_000) / 1000)} s`)
		if (!existsSync(file)) return notRun(`the bridge failed: ${stderr.trim().split("\n").at(-1) ?? `exit ${code}`}`)
		const r = JSON.parse(readFileSync(file, "utf8")) as Omit<DriveArtifact, "revision" | "dir">
		return { ...r, revision, dir: o.outDir }
	} finally {
		ended = true
		q.kill("SIGKILL")
		rmSync(sock, { force: true })
		if (sock !== local) rmSync(dirname(sock), { recursive: true, force: true })
	}
}
