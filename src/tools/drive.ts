import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { mergeFlash } from "./emulator.ts"
import { qemuEnv } from "./env.ts"
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
	stub?: boolean
}

const freePort = () =>
	new Promise<number>((resolve) => {
		const s = createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port
			s.close(() => resolve(p))
		})
	})

export interface DriveOptions {
	root: string
	python: string
	pio: string
	fwDir: string // a prepared rover firmware (prepareFirmware)
	spec: ChassisSpec
	outDir: string
	env?: "esp32c3_sim" | "esp32c3" // the build QEMU runs (the board build never answers: a test of "not run")
	courseS?: number
	timeoutMs?: number
}

export async function runDrive(opts: DriveOptions, revision = 0): Promise<DriveArtifact> {
	// Absolute paths: the bridge runs from py/, so a relative --out dir would point elsewhere there.
	const o = { ...opts, root: resolve(opts.root), fwDir: resolve(opts.fwDir), outDir: resolve(opts.outDir) }
	mkdirSync(o.outDir, { recursive: true })
	const notRun = (reason: string): DriveArtifact => ({ revision, dir: o.outDir, result: "not run", reason, segments: [] })
	const qemu = join(o.root, "tools/qemu/bin/qemu-system-riscv32")
	if (!existsSync(qemu)) return notRun("QEMU is not installed (npm run setup): not proven in simulation")
	const env = o.env ?? "esp32c3_sim"
	const build = await run(o.pio, ["run", "-d", o.fwDir, "-e", env], { timeoutMs: 900_000 })
	if (build.code !== 0) return notRun(`the simulation firmware didn't build: ${(build.stdout + build.stderr).trim().split("\n").slice(-3).join(" ")}`)
	const { image, log } = await mergeFlash(o.fwDir, env)
	if (!image) return notRun(`no flash image: ${log.trim().split("\n").at(-1)}`)
	const specPath = join(o.outDir, "spec.json")
	writeFileSync(specPath, JSON.stringify(o.spec, null, 1))
	const port = await freePort()
	const q = spawn(qemu, ["-display", "none", "-machine", "esp32c3", "-icount", "3", "-drive", `file=${image},if=mtd,format=raw`, "-global", "driver=timer.esp32c3.timg,property=wdt_disable,value=true", "-serial", `file:${join(o.outDir, "uart0.txt")}`, "-serial", `tcp:127.0.0.1:${port},server=on,wait=on`], { stdio: "ignore", env: { ...process.env, ...qemuEnv(o.root) } })
	try {
		const bridge = spawn(o.python, ["-B", join(o.root, "py/mech/drive.py"), specPath, String(port), o.outDir, String(o.courseS ?? 25)], { cwd: join(o.root, "py"), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONPATH: join(o.root, "py") } })
		let stderr = ""
		bridge.stderr.on("data", (d) => (stderr += d))
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
		q.kill("SIGKILL")
	}
}
