import { spawn, spawnSync } from "node:child_process"
import { createConnection, createServer } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { mergeFlash } from "./emulator.ts"
import { qemuEnv } from "./env.ts"
import { qemuBaseArgs, qemuBinary, qemuTarget } from "./qemu.ts"
import { run } from "./exec.ts"
import type { ChassisSpec } from "./chassis.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { ARM_JOINTS } from "../arm/types.ts"
import { ARM_GRIP_CLOSED_DEG, ARM_PERIOD_MS, ARM_SERVO_HZ, armGripOpenDeg, armPcaAddr, armServos } from "../arm/firmware.ts"

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
	// The turn calibration measured before the drive (calibrateTurn), when the robot needed one.
	turnCalibration?: TurnCalibration
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
	// (docs/ros.md), while UART1 still turns the MuJoCo model. The simulation is then paced to real time: the host
	// runs on its own clock.
	consolePort?: number
	// Extra compile flags for the simulation firmware (PLATFORMIO_BUILD_FLAGS), e.g. -DROVER_HOST_ONLY for a ROS test.
	buildFlags?: string
	// Wheel odometry without a gyro is turn-calibrated in the same physics before the drive (calibrateTurn); false: not.
	calibrateTurn?: boolean
	// Called once the console's TCP port takes a connection (the firmware built and QEMU up): what a ROS host waits for.
	onConsoleReady?: () => void
	// Stops the drive when it settles: a ROS test's physics runs until the test is done, not for a set number of
	// simulated seconds (which an idle machine runs about 3x faster than real time).
	until?: Promise<unknown>
}

// Whether something listens on a local TCP port: a connection opened and closed at once (QEMU's console server takes
// a client again after one leaves).
// Why a drive's firmware may not have answered: QEMU quit (and its last error line), or the console's last line (how far
// the firmware got), or that it printed nothing.
export function qemuSaid(exit: string | null, stderr: string, uart0: string | null): string {
	const lastLine = (t: string) => t.replace(/\r/g, "").trim().split("\n").filter(Boolean).at(-1)?.slice(0, 200)
	if (exit) return `QEMU ${exit}${lastLine(stderr) ? `: ${lastLine(stderr)}` : ""}`
	const console = uart0 && existsSync(uart0) ? readFileSync(uart0, "utf8") : ""
	return lastLine(console) ? `QEMU running; the firmware's console last printed: ${lastLine(console)}` : `QEMU running; the firmware's console printed nothing${lastLine(stderr) ? ` (QEMU: ${lastLine(stderr)})` : ""}`
}

// A TCP port nothing listens on now (the OS's pick), for QEMU to serve.
function freePort(): Promise<number> {
	return new Promise((ok, no) => {
		const s = createServer()
		s.on("error", no)
		s.listen(0, "127.0.0.1", () => {
			const port = (s.address() as { port: number }).port
			s.close(() => ok(port))
		})
	})
}

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
	const outDir = resolve(opts.outDir)
	// Wheel odometry without a gyro, not yet calibrated: the turn calibration first, in the same physics, and the drive's
	// firmware built with its factor (the simulated robot's own; a real robot measures its own: docs, the build guide).
	let cal: TurnCalibration | null = null
	if (needsTurnCalibration(opts)) {
		cal = await calibrateTurn({ ...opts, outDir: join(outDir, "turn-cal") })
		if (cal) opts = { ...opts, buildFlags: [opts.buildFlags, `-DROVER_TURN_SCALE=${cal.scale.toFixed(5)}f`, ...(cal.coastMm !== undefined ? [`-DROVER_COAST_MM=${cal.coastMm.toFixed(1)}f`] : [])].filter(Boolean).join(" ") }
	}
	const r = await simInLoop({ ...opts, script: "py/mech/drive.py", resultFile: "drive.json", args: [String(opts.courseS ?? 25), ...(opts.consolePort ? ["realtime"] : [])] })
	if ("notRun" in r) return { revision, dir: outDir, result: "not run", reason: r.notRun, segments: [] }
	return { ...(r.json as Omit<DriveArtifact, "revision" | "dir">), revision, dir: outDir, ...(cal ? { turnCalibration: cal } : {}) }
}

// ── Turn calibration (UMBmark-style, in place; 26 Nov 2026). Without a gyro, the heading is the wheels' difference over
// the track, and turning in place scrubs them: the Eurobot base in MuJoCo counted ~0.55 % more turn than it made, ~2 deg
// after a lap. The firmware's calibration build (ROVER_CAL_QUARTERS) turns 8 quarter-turns each way with the go-to's
// own turn and prints what it counted ("CAL turned ccw|cw <ms> <rad>"); the physics' yaw over the same spans is the
// real turn. scale = counted / real (mechanics.drive.turnScale's meaning), both ways together (a wheel-size difference
// between left and right cancels out).
// coastMm: how far it rolled on after a go-to-like stop (the counts measure it; straight, they don't scrub): the go-to's
// first stop allows for it (ROVER_COAST_MM), where it would otherwise roll past its first target.
export interface TurnCalibration { scale: number; countedRad: [number, number]; realRad: [number, number]; coastMm?: number }
export const CAL_QUARTERS = 8

function needsTurnCalibration(o: DriveOptions): boolean {
	if (o.calibrateTurn === false || o.consolePort || o.spec.imu) return false
	if (/-DROVER_TURN_SCALE=|-DROVER_CAL_QUARTERS=|-DROVER_HOST_ONLY/.test(o.buildFlags ?? "")) return false
	const header = firmwareConfig(o.fwDir)
	return /#define ROVER_ENC_COUNTS_PER_REV/.test(header) && !/#define ROVER_TURN_SCALE/.test(header)
}

function firmwareConfig(fwDir: string): string {
	for (const f of ["include/hw_pins.h"]) {
		try { return readFileSync(join(fwDir, f), "utf8") } catch {}
	}
	return ""
}

// The counted turns from the calibration build's console, and the real ones from the physics' yaw (trajectory.json:
// [t s, x m, y m, yaw rad, ...]) over the same spans. null when the firmware didn't finish its calibration.
export function turnCalibrationFrom(uart0: string, trajectory: number[][]): TurnCalibration | null {
	const start = /CAL start (\d+)/.exec(uart0)
	const ccw = /CAL turned ccw (\d+) (-?[\d.]+)/.exec(uart0)
	const cw = /CAL turned cw (\d+) (-?[\d.]+) scale (-?[\d.]+)/.exec(uart0)
	if (!start || !ccw || !cw || trajectory.length < 2) return null
	// The yaw unwrapped, then read at a time (the sample nearest it: the robot is still at each of these moments).
	const unwrapped: [number, number][] = []
	let prev = trajectory[0][3], acc = trajectory[0][3]
	for (const row of trajectory) {
		let d = row[3] - prev
		while (d > Math.PI) d -= 2 * Math.PI
		while (d < -Math.PI) d += 2 * Math.PI
		acc += d
		prev = row[3]
		unwrapped.push([row[0], acc])
	}
	const yawAt = (ms: number) => unwrapped.reduce((best, r) => (Math.abs(r[0] - ms / 1000) < Math.abs(best[0] - ms / 1000) ? r : best))[1]
	const real: [number, number] = [yawAt(+ccw[1]) - yawAt(+start[1]), yawAt(+ccw[1]) - yawAt(+cw[1])]
	const counted: [number, number] = [+ccw[2], +cw[2]]
	if (real[0] <= 1 || real[1] <= 1) return null
	// Counted with the factor the firmware already had (ROVER_TURN_SCALE): the result is the whole factor.
	const scale = (+cw[3] || 1) * ((counted[0] + counted[1]) / (real[0] + real[1]))
	const coast = /CAL coast (\d+) (-?[\d.]+)/.exec(uart0)
	return { scale, countedRad: counted, realRad: real, ...(coast ? { coastMm: +coast[2] } : {}) }
}

export async function calibrateTurn(opts: DriveOptions): Promise<TurnCalibration | null> {
	const outDir = resolve(opts.outDir)
	// 8 quarter-turns each way take ~20 s of simulated time on the bases so far; 45 s leaves room for a slow one.
	const r = await simInLoop({ ...opts, outDir, script: "py/mech/drive.py", resultFile: "drive.json", buildFlags: [opts.buildFlags, `-DROVER_CAL_QUARTERS=${CAL_QUARTERS}`].filter(Boolean).join(" "), args: ["45"] })
	if ("notRun" in r) return null
	try {
		const cal = turnCalibrationFrom(readFileSync(join(outDir, "uart0.txt"), "utf8"), JSON.parse(readFileSync(join(outDir, "trajectory.json"), "utf8")))
		if (cal) writeFileSync(join(outDir, "turn-calibration.json"), JSON.stringify(cal, null, 1))
		return cal
	} catch {
		return null
	}
}

// The robot arm's pick-and-place in the loop (task 8): the arm firmware's simulation build (templates/fw-arm, SIM.md)
// in QEMU, py/mech/arm_drive.py stepping the MuJoCo arm (py/mech/arm_model.py) in lock-step with it. Results: arm.json.
// The firmware's PCA9685 driver runs as built: its I2C writes go over UART1 to the bridge's model of the chip (SIM.md);
// only the ESP32's I2C peripheral and the Wire library under the driver aren't simulated.
export interface ArmSimSpec {
	mjcf: string
	joints: readonly string[]
	// closedQ/openQ: the gripper actuator's targets; absent, the bridge takes them from py/mech/arm_model.py.
	gripper: { closedDeg: number; openDeg: number; closedQ?: number; openQ?: number }
	// The firmware's PCA9685 and servo map (one per joint, then the gripper): the bridge's model of the chip turns the
	// driver's register writes into pulses and those back into joint angles (templates/fw-arm/SIM.md).
	pca: { addr: number; hz: number }
	servos: { channel: number; minDeg: number; maxDeg: number; rangeDeg: number; pulseUs: [number, number] }[]
	periodMs: number
	repeats: number
	spawn?: [number, number, number] // mm: where each new cube appears; absent, where the model put the first (on the plate at the pick point)
	// innerRMm/rimZMm absent: from py/mech/arm_model.py (CUP_INNER_MM, CUP_RIM_MM).
	cup: { xMm: number; yMm: number; innerRMm?: number; rimZMm?: number }
}
export interface ArmDriveArtifact {
	revision: number
	dir: string
	result: "pass" | "fail" | "not run"
	reason: string
	landed?: number
	attempts?: number
	worstMm?: number // the farthest a landed or missed cube came to rest from the cup's centre
	cycleS?: number[] // simulated seconds per pick-and-drop
	simS?: number
	i2c?: { writes: number; hz: number; ignoredPrescale: number; otherAddr: number[] } // what the bridge's PCA9685 model saw
	drops?: { tS: number; atMm: [number, number, number]; fromCupMm: number; landed: boolean }[] // each cube's rest point
	note: string
}
export const ARM_SIM_NOTE = "the PCA9685 driver runs as built, its register writes into a model of the chip; not simulated: the ESP32's I2C peripheral and the Wire library under it"

// The bridge's spec from the contract: the brief's drop point (the cup), its repeats, the firmware's period and gripper
// angles. The model (py/mech/arm_model.py) places the cube on the plate at the pick point; each new one goes there too.
export function armSimSpec(s: ContractSnapshot, mjcf: string): ArmSimSpec {
	const t = s.values.armTargets
	if (!t) throw new Error("no arm simulation: the contract has no armTargets")
	return {
		mjcf,
		joints: ARM_JOINTS,
		gripper: { closedDeg: ARM_GRIP_CLOSED_DEG, openDeg: armGripOpenDeg(s) },
		pca: { addr: armPcaAddr(s), hz: ARM_SERVO_HZ },
		servos: armServos(s).map((x) => ({ channel: x.channel, minDeg: x.minDeg, maxDeg: x.maxDeg, rangeDeg: x.part.rangeDeg, pulseUs: x.part.pulseUs! })),
		periodMs: ARM_PERIOD_MS,
		repeats: t.repeats,
		cup: { xMm: t.drop.xMm, yMm: t.drop.yMm },
	}
}

export interface ArmDriveOptions extends Omit<DriveOptions, "spec" | "courseS" | "consolePort" | "onConsoleReady" | "until"> {
	spec: ArmSimSpec
	limitS?: number // simulated seconds before the bridge gives up (default 600)
}

export async function runArmDrive(opts: ArmDriveOptions, revision = 0): Promise<ArmDriveArtifact> {
	const outDir = resolve(opts.outDir)
	const r = await simInLoop({ ...opts, machine: opts.machine ?? "esp32s3", script: "py/mech/arm_drive.py", resultFile: "arm.json", args: [String(opts.limitS ?? 600)] })
	if ("notRun" in r) return { revision, dir: outDir, result: "not run", reason: r.notRun, note: ARM_SIM_NOTE }
	return { ...(r.json as Omit<ArmDriveArtifact, "revision" | "dir" | "note">), revision, dir: outDir, note: ARM_SIM_NOTE }
}

// The scorecard course (Bringup Studio's simulation scorecard, docs: 2026-11-26-sim-scorecard-design): once a design
// settles, a gyro-less encoder rover (the kind whose drive ran the turn calibration) also drives a go-to to (500, 300) mm
// and a 600 x 400 mm lap back to its start, on the settled drive's own firmware and calibration, so each accepted change
// shows its lap and go-to error before -> after. Judged at the brief's 2 cm; the miss is the number that matters.
export const SCORECARD_FILE = "scorecard.json"
export const SCORECARD_GOTO_MM = { x: 500, y: 300 }, SCORECARD_LAP_MM = { w: 600, h: 400 }
export interface ScorecardLeg { result: DriveArtifact["result"]; missMm: number | null; reason: string }
export interface DriveScorecard { revision: number; goto: ScorecardLeg; lap: ScorecardLeg; turnScale: number; at: string }

// Whether a settled drive gets the scorecard course: it passed, and it is a gyro-less encoder rover (its drive ran
// the turn calibration, needsTurnCalibration).
export function wantsScorecard(d: DriveArtifact | undefined | null): d is DriveArtifact & { turnCalibration: TurnCalibration } {
	return Boolean(d && d.result === "pass" && d.turnCalibration && !d.stub)
}

// base: the settled drive's own options (its firmware folder, spec and machine); the legs go in <drive dir>/scorecard/.
export async function runScorecardCourse(base: DriveOptions, drive: DriveArtifact & { turnCalibration: TurnCalibration }): Promise<DriveScorecard> {
	const cal = drive.turnCalibration
	const flags = [base.buildFlags, `-DROVER_TURN_SCALE=${cal.scale.toFixed(5)}f`, ...(cal.coastMm !== undefined ? [`-DROVER_COAST_MM=${cal.coastMm.toFixed(1)}f`] : [])].filter(Boolean).join(" ")
	const leg = async (name: string, target: { xMm: number; yMm: number }, extra: string, courseS: number): Promise<ScorecardLeg> => {
		const r = await runDrive({ ...base, spec: { ...base.spec, target: { ...target, tolMm: 20 } } as ChassisSpec, outDir: join(drive.dir, "scorecard", name), courseS, buildFlags: `${flags} ${extra}`, calibrateTurn: false }, drive.revision)
		const miss = (r as { targetMissMm?: unknown }).targetMissMm
		return { result: r.result, missMm: typeof miss === "number" ? miss : null, reason: r.reason }
	}
	const goto = await leg("goto", { xMm: SCORECARD_GOTO_MM.x, yMm: SCORECARD_GOTO_MM.y }, `-DROVER_GOTO_X_MM=${SCORECARD_GOTO_MM.x}.0f -DROVER_GOTO_Y_MM=${SCORECARD_GOTO_MM.y}.0f`, 12)
	const lap = await leg("lap", { xMm: 0, yMm: 0 }, `-DROVER_GOTO_LAP_W_MM=${SCORECARD_LAP_MM.w}.0f -DROVER_GOTO_LAP_H_MM=${SCORECARD_LAP_MM.h}.0f`, 40)
	const out: DriveScorecard = { revision: drive.revision, goto, lap, turnScale: cal.scale, at: new Date().toISOString() }
	writeFileSync(join(drive.dir, SCORECARD_FILE), JSON.stringify(out, null, "\t") + "\n")
	return out
}

// Shared by both: build the firmware's simulation build, start it in QEMU with UART1 on a Unix socket, run the bridge
// script on it and read its result file.
interface SimInLoop extends Omit<DriveOptions, "spec" | "courseS"> {
	spec: unknown
	script: string // the bridge, from the repo root: <script> <spec.json> <socket> <out dir> ...args
	args: string[]
	resultFile: string
}
async function simInLoop(opts: SimInLoop): Promise<{ notRun: string } | { json: unknown }> {
	// Absolute paths: the bridge runs from py/, so a relative --out dir would point elsewhere there.
	const o = { ...opts, root: resolve(opts.root), fwDir: resolve(opts.fwDir), outDir: resolve(opts.outDir) }
	mkdirSync(o.outDir, { recursive: true })
	const notRun = (reason: string) => ({ notRun: reason })
	// The chip's QEMU (qemu.ts): riscv32 for the ESP32-C3, xtensa for the ESP32-S3.
	const target = qemuTarget(o.machine)
	if (!target) return notRun(`QEMU has no model of the ${o.machine} machine: not proven in simulation`)
	const qemu = qemuBinary(o.root, target)
	if (!qemu) return notRun(`QEMU for the ${target.machine} (${target.bin.split("/").pop()}) is not installed (\`npx bringup-mcp setup sim\`; a checkout: npm run setup -- --robotics): not proven in simulation`)
	if (!hasMujoco(o.python)) return notRun("MuJoCo is not installed (`npx bringup-mcp setup sim`; a checkout: npm run setup -- --robotics): not proven in simulation")
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
	// Windows: a free TCP port instead (its Python has no AF_UNIX sockets); the small race above is the price there.
	const local = join(o.outDir, "uart1.sock")
	const tcp = process.platform === "win32" ? await freePort() : null
	const sock = tcp ? null : Buffer.byteLength(local) <= 100 ? local : join(mkdtempSync(join(tmpdir(), "bringup-drive-")), "uart1.sock")
	if (sock) rmSync(sock, { force: true })
	const uart1 = tcp ? `tcp:127.0.0.1:${tcp},server=on,wait=on` : `unix:${sock},server=on,wait=on`
	const uart0 = join(o.outDir, "uart0.txt")
	const q = spawn(qemu, ["-display", "none", ...qemuBaseArgs(target, image), "-serial", o.consolePort ? `tcp:127.0.0.1:${o.consolePort},server=on,wait=off` : `file:${uart0}`, "-serial", uart1], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...qemuEnv(o.root) } })
	// What QEMU said and whether it quit: a drive that didn't run says why (Windows' first OS smoke run, 27 Nov 2026: "the
	// firmware didn't answer within 60 s" and nothing else to go on).
	let qemuErr = ""
	let qemuExit: string | null = null
	q.stderr?.on("data", (d) => (qemuErr = (qemuErr + d).slice(-2000)))
	q.on("exit", (code, signal) => (qemuExit = `exited ${code ?? signal}`))
	q.on("error", (e) => (qemuExit = `didn't start (${e.message})`))
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
		const bridge = spawn(o.python, ["-B", join(o.root, o.script), specPath, tcp ? String(tcp) : sock!, o.outDir, ...o.args], { cwd: join(o.root, "py"), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONPATH: join(o.root, "py") } })
		let stderr = ""
		bridge.stderr.on("data", (d) => (stderr += d))
		// A host's test that ends first asks the bridge to end the course (a "stop" file it checks); it writes its results.
		rmSync(join(o.outDir, "stop"), { force: true })
		void o.until?.then(() => writeFileSync(join(o.outDir, "stop"), ""))
		const code = await new Promise<number | null>((resolve) => {
			const timer = setTimeout(() => { bridge.kill("SIGKILL"); resolve(null) }, o.timeoutMs ?? 300_000)
			bridge.on("close", (c) => { clearTimeout(timer); resolve(c) })
		})
		const file = join(o.outDir, o.resultFile)
		if (code === null) return notRun(`the run didn't finish within ${Math.round((o.timeoutMs ?? 300_000) / 1000)} s`)
		if (!existsSync(file)) return notRun(`the bridge failed: ${stderr.trim().split("\n").at(-1) ?? `exit ${code}`}`)
		const json = JSON.parse(readFileSync(file, "utf8")) as { result?: string; reason?: string }
		if (json.result === "not run") json.reason = `${json.reason ?? ""}; ${qemuSaid(qemuExit, qemuErr, o.consolePort ? null : uart0)}`
		return { json }
	} finally {
		ended = true
		q.kill("SIGKILL")
		if (sock) rmSync(sock, { force: true })
		if (sock && sock !== local) rmSync(dirname(sock), { recursive: true, force: true })
	}
}
